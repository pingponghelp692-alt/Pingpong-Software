// redis/cache.js
// ==================================================
// PHASE 2A — REDIS CACHE LAYER
// ==================================================
// Generic, reusable get/set/del/invalidate helpers on top of
// redis/client.js. Not wired into any existing route in Phase 2A —
// this is infrastructure other modules (including future phases)
// can import. Every function degrades to a safe no-op / null when
// Redis is disabled or a call fails, so nothing that starts using
// this later can take the app down if Redis has a bad moment.
//
// KEY NAMESPACES
//   Callers pass a `namespace` (e.g. "user", "room", "session",
//   "roomlist") and a `key` (e.g. a userId). The stored Redis key is
//   `${REDIS_KEY_PREFIX}cache:${namespace}:${key}`, so namespaces
//   can be invalidated independently of each other and of the raw
//   state mirrors in userState.js/roomState.js (which use their own
//   `user:state:*` / `room:state:*` keys, not this cache).

const client = require("./client.js");

function cacheKey(namespace, key) {
    return client.prefixed(`cache:${namespace}:${key}`);
}

async function get(namespace, key) {
    if (!client.isEnabled()) return null;
    const conn = client.getConnection();
    if (!conn) return null;
    try {
        const raw = await conn.get(cacheKey(namespace, key));
        if (raw == null) return null;
        try { return JSON.parse(raw); } catch { return raw; }
    } catch (e) {
        console.warn(`[redis/cache] get(${namespace}:${key}) failed: ${e.message}`);
        return null;
    }
}

// ttlSeconds: omit/0 for no expiration.
async function set(namespace, key, value, ttlSeconds = 0) {
    if (!client.isEnabled()) return false;
    const conn = client.getConnection();
    if (!conn) return false;
    try {
        const serialized = typeof value === "string" ? value : JSON.stringify(value);
        if (ttlSeconds > 0) {
            await conn.set(cacheKey(namespace, key), serialized, "EX", ttlSeconds);
        } else {
            await conn.set(cacheKey(namespace, key), serialized);
        }
        return true;
    } catch (e) {
        console.warn(`[redis/cache] set(${namespace}:${key}) failed: ${e.message}`);
        return false;
    }
}

async function del(namespace, key) {
    if (!client.isEnabled()) return false;
    const conn = client.getConnection();
    if (!conn) return false;
    try {
        await conn.del(cacheKey(namespace, key));
        return true;
    } catch (e) {
        console.warn(`[redis/cache] del(${namespace}:${key}) failed: ${e.message}`);
        return false;
    }
}

// Invalidate every key under a namespace. Uses SCAN (not KEYS) so it
// never blocks the Redis event loop even with a large keyspace.
async function invalidateNamespace(namespace) {
    if (!client.isEnabled()) return 0;
    const conn = client.getConnection();
    if (!conn) return 0;
    const pattern = cacheKey(namespace, "*");
    let cursor = "0";
    let deleted = 0;
    try {
        do {
            const [next, keys] = await conn.scan(cursor, "MATCH", pattern, "COUNT", 200);
            cursor = next;
            if (keys.length) {
                await conn.del(...keys);
                deleted += keys.length;
            }
        } while (cursor !== "0");
        return deleted;
    } catch (e) {
        console.warn(`[redis/cache] invalidateNamespace(${namespace}) failed: ${e.message}`);
        return deleted;
    }
}

// Fetch-through helper: return cached value, or compute via `loader`,
// cache it, and return it. `loader` is only called on a cache miss.
async function getOrSet(namespace, key, ttlSeconds, loader) {
    const cached = await get(namespace, key);
    if (cached !== null) return cached;
    const fresh = await loader();
    if (fresh !== null && fresh !== undefined) await set(namespace, key, fresh, ttlSeconds);
    return fresh;
}

module.exports = { get, set, del, invalidateNamespace, getOrSet };
