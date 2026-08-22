// module4/redis/connectionFactory.js
// ==================================================
// MODULE 4 — DEPLOYMENT-AGNOSTIC REDIS CONNECTION FACTORY
// ==================================================
// Standalone for now (does NOT require or modify redis/client.js —
// Module 4 stays isolated until manual merge). Owns exactly one
// concern: build an ioredis-compatible client for whichever topology
// is configured, so every OTHER module4/ file only ever calls plain
// command methods (get/set/eval/etc.) and never constructs a
// connection itself or branches on topology.
//
// WHY THIS EXISTS (vs. just using `new Redis(...)` everywhere):
// ioredis exposes the same command surface for a single instance,
// a Cluster client, and a Sentinel-managed client — the constructor
// call differs, the command API afterward does not. Centralizing the
// constructor call here means migrating from single-instance to
// Cluster/Sentinel later is a config change (env vars), not a code
// change, in every file that consumes this module.
//
// TOPOLOGY SELECTION (env)
//   REDIS_TOPOLOGY   "single" (default) | "cluster" | "sentinel"
//   -- single --
//   REDIS_URL, or REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_DB/REDIS_TLS
//   -- cluster --
//   REDIS_CLUSTER_NODES   comma-separated "host:port" seed list
//   REDIS_PASSWORD, REDIS_TLS apply to all nodes
//   -- sentinel --
//   REDIS_SENTINEL_NODES  comma-separated "host:port" sentinel list
//   REDIS_SENTINEL_MASTER_NAME  (default "mymaster")
//   REDIS_PASSWORD, REDIS_TLS apply as sentinel/master auth
//
// TODAY'S DEPLOYMENT: single instance. Default topology is "single"
// so no env changes are needed for this to behave identically to not
// existing. Cluster/sentinel branches are written and structurally
// ready but NOT VERIFIED against real cluster/sentinel infrastructure
// — see Step 4.2 report's Verified/Not Verified section.
//
// CLUSTER-SAFETY NOTE FOR EVERY OTHER module4/ FILE:
// Redis Cluster shards by key hash slot. Any multi-key operation
// (MULTI/EXEC, Lua script) that touches keys in different slots
// fails on a real cluster even though it works fine against a single
// instance. Every module4/ file that needs multiple related keys to
// stay atomic MUST route key names through module4/redis/keyspace.js's
// hash-tag helper so they land in the same slot. This factory does
// not enforce that (it only builds connections) — keyspace.js does.

let Redis = null;
try {
    Redis = require("ioredis");
} catch (e) {
    Redis = null;
}

function topology() {
    const t = (process.env.REDIS_TOPOLOGY || "single").toLowerCase();
    if (t === "cluster" || t === "sentinel") return t;
    return "single";
}

function tlsOption() {
    return process.env.REDIS_TLS === "true" ? {} : undefined;
}

function baseOptions(extra = {}) {
    return {
        connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || "5000", 10),
        maxRetriesPerRequest: 3,
        enableOfflineQueue: true,
        retryStrategy(times) {
            return Math.min(1000 * Math.pow(2, Math.min(times, 6)), 10000);
        },
        ...extra,
    };
}

// Builds one client per the configured topology. Returns null (never
// throws) if ioredis isn't installed or required env is missing —
// same "degrade to no-op, never crash the app" contract as redis/client.js.
function createClient(label) {
    if (!Redis) return null;

    const mode = topology();

    try {
        let client;
        if (mode === "cluster") {
            const nodesRaw = process.env.REDIS_CLUSTER_NODES;
            if (!nodesRaw) return null;
            const nodes = nodesRaw.split(",").map((s) => {
                const [host, port] = s.trim().split(":");
                return { host, port: parseInt(port || "6379", 10) };
            });
            client = new Redis.Cluster(nodes, {
                redisOptions: baseOptions({
                    password: process.env.REDIS_PASSWORD || undefined,
                    tls: tlsOption(),
                }),
                // Cluster-specific: retry on ASK/MOVED redirects (normal
                // during a cluster resharding/failover), same spirit as
                // the single-instance READONLY handling in redis/client.js.
                clusterRetryStrategy(times) {
                    return Math.min(1000 * Math.pow(2, Math.min(times, 6)), 10000);
                },
            });
        } else if (mode === "sentinel") {
            const sentinelsRaw = process.env.REDIS_SENTINEL_NODES;
            if (!sentinelsRaw) return null;
            const sentinels = sentinelsRaw.split(",").map((s) => {
                const [host, port] = s.trim().split(":");
                return { host, port: parseInt(port || "26379", 10) };
            });
            client = new Redis(baseOptions({
                sentinels,
                name: process.env.REDIS_SENTINEL_MASTER_NAME || "mymaster",
                password: process.env.REDIS_PASSWORD || undefined,
                tls: tlsOption(),
            }));
        } else {
            // single (default) — identical construction to redis/client.js's
            // makeConnection, kept independent here rather than imported so
            // Module 4 has zero require-time dependency on redis/client.js.
            if (process.env.REDIS_URL) {
                client = new Redis(process.env.REDIS_URL, baseOptions({ tls: tlsOption() }));
            } else {
                client = new Redis(baseOptions({
                    host: process.env.REDIS_HOST || "127.0.0.1",
                    port: parseInt(process.env.REDIS_PORT || "6379", 10),
                    password: process.env.REDIS_PASSWORD || undefined,
                    db: parseInt(process.env.REDIS_DB || "0", 10),
                    tls: tlsOption(),
                }));
            }
        }

        // BUG FIX (Module 4 verification, 2026-08-06): every client this
        // factory builds now gets an 'error' listener before it's handed
        // back to any caller. ioredis clients are EventEmitters — an
        // 'error' event with zero listeners is treated as fatal by Node
        // and kills the whole process. Every OTHER module4/*.js file calls
        // createClient() and previously got a client with no such listener
        // at all, silently relying on server.js's unrelated global
        // uncaughtException handler as an accidental safety net instead of
        // a designed one. Centralizing it here (rather than repeating it
        // in roomState.js/routing.js/userProfile.js/wallet/index.js) means
        // no future consumer of this factory can forget it either.
        client.on("error", (err) => {
            console.warn(`[module4/connectionFactory] "${label}" client error (non-fatal, degrades to no-op per the redis/*.js "return null on failure" contract): ${err.message}`);
        });

        return client;
    } catch (e) {
        console.warn(`[module4/connectionFactory] failed to create "${label}" client (${mode}): ${e.message}`);
        return null;
    }
}

module.exports = { createClient, topology };
