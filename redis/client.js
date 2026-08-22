// redis/client.js
// ==================================================
// PHASE 2A — REDIS CONNECTION MANAGER
// ==================================================
// Additive infrastructure module, same init(deps)-free "require and use"
// shape as the rest of the Redis layer. This file owns the actual
// ioredis connections; every other redis/*.js file goes through here
// instead of calling `new Redis()` itself.
//
// SAFETY CONTRACT (read this before touching anything else in redis/):
//   If REDIS_URL / REDIS_HOST is not set, or ioredis is not installed,
//   or Redis is unreachable, this module NEVER throws and NEVER blocks
//   server startup. `isEnabled()` becomes false, every read helper
//   returns null, every write helper is a no-op. The rest of the app
//   (rooms, sockets, wallet, admin panel, everything already in
//   server.js) has zero dependency on this module and keeps working
//   exactly as before Phase 2A. Redis here is a mirror, not a source
//   of truth yet — that's the "additive mirror" approach, not a
//   replace-in-place migration.
//
// ENV CONFIGURATION
//   REDIS_ENABLED       "true"/"false" (default: auto — enabled if
//                        REDIS_URL or REDIS_HOST is set, disabled
//                        otherwise)
//   REDIS_URL            e.g. redis://:password@host:6379/0
//                         (if set, takes priority over discrete vars)
//   REDIS_HOST            default 127.0.0.1
//   REDIS_PORT            default 6379
//   REDIS_PASSWORD         optional
//   REDIS_DB               default 0
//   REDIS_TLS               "true" to use rediss:// / TLS socket
//   REDIS_KEY_PREFIX         default "pingpong:" — namespaces every key
//                             this app writes, so a shared Redis instance
//                             can't collide with another app's keys
//   REDIS_POOL_SIZE           default 4 — number of general-purpose
//                             connections in the round-robin pool (see
//                             below)
//   REDIS_CONNECT_TIMEOUT_MS   default 5000
//
// CONNECTION POOL
//   ioredis multiplexes commands over one socket fine for most loads,
//   but a single connection means one slow/blocking command (or a
//   temporary network hiccup during reconnect) head-of-line-blocks
//   everything else. We keep a small round-robin pool of general
//   connections for normal GET/SET/HSET-style traffic, plus two
//   dedicated connections ioredis itself requires to be separate:
//   one for Pub/Sub subscription and one reserved for future blocking
//   commands (BLPOP etc.) so those never contend with the pool.
//
// AUTO RECONNECT
//   ioredis's built-in retryStrategy with capped exponential backoff.
//   Connections also set `reconnectOnError` so a READONLY error from a
//   failed-over replica triggers an immediate reconnect instead of
//   waiting out the normal backoff.
//
// HEALTH MONITORING
//   A lightweight ping loop tracks per-connection status and latency.
//   getHealth() is consumed by redis/index.js's admin endpoint and by
//   health-check.js's snapshot if it's ever wired in later (not done
//   in Phase 2A — see docs).
//
// PHASE 2B-1 ADDITION: two more dedicated connections (adapter-pub /
// adapter-sub) reserved for the Socket.IO Redis Adapter — see
// getAdapterConnections() / redis/socketAdapter.js. Everything above
// this point is unchanged Phase 2A code.

let Redis = null;
try {
    Redis = require("ioredis");
} catch (e) {
    // ioredis not installed yet — module stays fully disabled, no crash.
    Redis = null;
}

const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || "pingpong:";
const POOL_SIZE = Math.max(1, parseInt(process.env.REDIS_POOL_SIZE || "4", 10));
const CONNECT_TIMEOUT_MS = parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || "5000", 10);
const PING_INTERVAL_MS = 15000;

function envSaysEnabled() {
    if (process.env.REDIS_ENABLED === "false") return false;
    if (process.env.REDIS_ENABLED === "true") return true;
    // Auto: enabled only if the operator actually configured a target.
    return !!(process.env.REDIS_URL || process.env.REDIS_HOST);
}

function buildRedisOptions(extra = {}) {
    const base = {
        connectTimeout: CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 3,
        enableOfflineQueue: true,
        retryStrategy(times) {
            // Exponential backoff capped at 10s, so a Redis restart or
            // brief network blip self-heals without operator action.
            const delay = Math.min(1000 * Math.pow(2, Math.min(times, 6)), 10000);
            return delay;
        },
        reconnectOnError(err) {
            const msg = (err && err.message) || "";
            if (msg.includes("READONLY") || msg.includes("ETIMEDOUT")) return true;
            return false;
        },
        lazyConnect: false,
    };
    return { ...base, ...extra };
}

function makeConnection(label) {
    let conn;
    if (process.env.REDIS_URL) {
        conn = new Redis(process.env.REDIS_URL, buildRedisOptions({
            tls: process.env.REDIS_TLS === "true" ? {} : undefined,
        }));
    } else {
        conn = new Redis(buildRedisOptions({
            host: process.env.REDIS_HOST || "127.0.0.1",
            port: parseInt(process.env.REDIS_PORT || "6379", 10),
            password: process.env.REDIS_PASSWORD || undefined,
            db: parseInt(process.env.REDIS_DB || "0", 10),
            tls: process.env.REDIS_TLS === "true" ? {} : undefined,
        }));
    }
    const state = { label, status: "connecting", lastError: null, lastLatencyMs: null, connectedAt: null };
    conn.on("connect", () => { state.status = "connecting"; });
    conn.on("ready", () => { state.status = "ready"; state.connectedAt = new Date().toISOString(); state.lastError = null; });
    conn.on("error", (err) => { state.status = "error"; state.lastError = err.message; });
    conn.on("close", () => { state.status = "closed"; });
    conn.on("reconnecting", (delay) => { state.status = `reconnecting(${delay}ms)`; });
    conn._healthState = state;
    return conn;
}

// ---- Module state ----
let enabled = false;
let pool = [];
let poolCursor = 0;
let subConn = null;
let blockingConn = null;
// PHASE 2B-1: two more dedicated connections, reserved exclusively for
// the Socket.IO Redis Adapter (see redis/socketAdapter.js). Kept separate
// from `subConn` above (which redis/pubsub.js's app-level event channels
// use) so the adapter's own internal subscribe traffic never shares a
// connection with, or is misinterpreted as, this app's custom pub/sub
// messages — same "each concern gets its own connection" principle the
// pool/subConn/blockingConn split above already established in Phase 2A.
let adapterPubConn = null;
let adapterSubConn = null;
let pingTimer = null;
let initError = null;

function init() {
    if (pool.length || initError) return; // already initialized (idempotent)
    if (!Redis) {
        initError = "ioredis not installed (npm install ioredis)";
        console.warn(`[redis/client] disabled: ${initError}`);
        return;
    }
    if (!envSaysEnabled()) {
        initError = "REDIS_URL/REDIS_HOST not configured — Redis layer disabled (this is fine; app runs entirely in-memory as before)";
        console.warn(`[redis/client] disabled: ${initError}`);
        return;
    }
    try {
        pool = Array.from({ length: POOL_SIZE }, (_, i) => makeConnection(`pool-${i}`));
        subConn = makeConnection("pubsub");
        blockingConn = makeConnection("blocking");
        adapterPubConn = makeConnection("adapter-pub");
        adapterSubConn = makeConnection("adapter-sub");
        enabled = true;
        pingTimer = setInterval(pingAll, PING_INTERVAL_MS);
        pingTimer.unref();
        console.log(`[redis/client] Redis layer enabled — pool=${POOL_SIZE}, prefix="${KEY_PREFIX}"`);
    } catch (e) {
        initError = e.message;
        enabled = false;
        console.warn(`[redis/client] failed to initialize, disabling: ${e.message}`);
    }
}

function isEnabled() {
    return enabled;
}

// Round-robin a general-purpose connection out of the pool.
function getConnection() {
    if (!enabled || !pool.length) return null;
    const conn = pool[poolCursor % pool.length];
    poolCursor++;
    return conn;
}

function getSubscriberConnection() {
    return enabled ? subConn : null;
}

function getBlockingConnection() {
    return enabled ? blockingConn : null;
}

// PHASE 2B-1: dedicated pub/sub pair for the Socket.IO Redis Adapter
// only — see redis/socketAdapter.js. Returns null (never throws) if
// Redis isn't enabled, same safety contract as every other getter here.
function getAdapterConnections() {
    if (!enabled || !adapterPubConn || !adapterSubConn) return null;
    return { pubClient: adapterPubConn, subClient: adapterSubConn };
}

function prefixed(key) {
    return `${KEY_PREFIX}${key}`;
}

async function pingAll() {
    if (!enabled) return;
    const all = [...pool, subConn, blockingConn, adapterPubConn, adapterSubConn].filter(Boolean);
    await Promise.all(all.map(async (conn) => {
        const start = Date.now();
        try {
            await conn.ping();
            conn._healthState.lastLatencyMs = Date.now() - start;
        } catch (e) {
            conn._healthState.lastError = e.message;
        }
    }));
}

function getHealth() {
    if (!Redis) return { enabled: false, reason: "ioredis not installed" };
    if (!enabled) return { enabled: false, reason: initError || "not configured" };
    const all = [...pool, subConn, blockingConn, adapterPubConn, adapterSubConn].filter(Boolean);
    return {
        enabled: true,
        keyPrefix: KEY_PREFIX,
        poolSize: pool.length,
        connections: all.map((c) => ({ label: c._healthState.label, ...c._healthState })),
        allReady: all.every((c) => c._healthState.status === "ready"),
    };
}

async function shutdown() {
    if (pingTimer) clearInterval(pingTimer);
    const all = [...pool, subConn, blockingConn, adapterPubConn, adapterSubConn].filter(Boolean);
    await Promise.all(all.map((c) => c.quit().catch(() => {})));
    pool = [];
    subConn = null;
    blockingConn = null;
    adapterPubConn = null;
    adapterSubConn = null;
    enabled = false;
}

init();

module.exports = {
    isEnabled,
    getConnection,
    getSubscriberConnection,
    getBlockingConnection,
    getAdapterConnections,
    prefixed,
    getHealth,
    shutdown,
    KEY_PREFIX,
};
