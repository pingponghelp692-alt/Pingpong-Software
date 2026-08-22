// module4/redis/lock.js
// ==================================================
// MODULE 4 — DISTRIBUTED LOCK (single-instance today, Cluster-ready)
// ==================================================
// Deliberately NOT Redlock. Redlock's multi-node quorum algorithm
// solves a problem this deployment doesn't have (multiple independent
// Redis masters you don't otherwise coordinate) and introduces real
// complexity (clock-drift assumptions, 5-node recommended minimum)
// for no benefit against a single instance or a single Cluster/
// Sentinel-managed dataset, where Redis itself already guarantees a
// single command executes atomically. Simplest thing that's actually
// correct here: SET key NX PX <ttl>.
//
// CLUSTER SAFETY: every operation below (acquire, release, extend) is
// a SINGLE key. A single-key Lua script or single-key command is
// Cluster-safe by definition — there's no second key to land in a
// different hash slot. That's why release() below uses a one-key Lua
// script (compare-and-delete) instead of a MULTI/WATCH transaction,
// which would need to be reasoned about slot-wise. Nothing here
// changes when connectionFactory.js's topology moves from "single" to
// "cluster" — this file has no topology-specific code at all.
//
// USAGE: caller passes a key already built via keyspace.js (e.g.
// keyspace.roomKey(roomId, "lock")) so lock keys naturally share a
// slot with the state they protect.

const crypto = require("crypto");

// Lua: only delete if the value still matches the token we set —
// prevents a lock holder whose TTL expired mid-operation from
// deleting a DIFFERENT holder's lock that has since been acquired.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
`;

// Same compare-then-act idea for extending a held lock's TTL.
const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
    return 0
end
`;

function makeToken() {
    return crypto.randomBytes(12).toString("hex");
}

// acquire(client, key, ttlMs) -> token string on success, null if
// already held by someone else or Redis is unavailable. Caller must
// hold onto the token to release() or extend() later — this is what
// stops a stale/expired holder from releasing a newer holder's lock.
async function acquire(client, key, ttlMs = 5000) {
    if (!client) return null;
    const token = makeToken();
    try {
        const res = await client.set(key, token, "PX", ttlMs, "NX");
        return res === "OK" ? token : null;
    } catch (e) {
        console.warn(`[module4/lock] acquire failed for ${key}: ${e.message}`);
        return null;
    }
}

async function release(client, key, token) {
    if (!client || !token) return false;
    try {
        const res = await client.eval(RELEASE_SCRIPT, 1, key, token);
        return res === 1;
    } catch (e) {
        console.warn(`[module4/lock] release failed for ${key}: ${e.message}`);
        return false;
    }
}

async function extend(client, key, token, ttlMs = 5000) {
    if (!client || !token) return false;
    try {
        const res = await client.eval(EXTEND_SCRIPT, 1, key, token, ttlMs);
        return res === 1;
    } catch (e) {
        console.warn(`[module4/lock] extend failed for ${key}: ${e.message}`);
        return false;
    }
}

// Convenience wrapper: acquire, run fn(), always release (even on
// throw), return fn()'s result. Retries acquire briefly since room
// operations are short-lived and a short wait beats failing the
// caller's whole request over a few-millisecond overlap.
async function withLock(client, key, { ttlMs = 5000, retries = 10, retryDelayMs = 50 } = {}, fn) {
    let token = null;
    for (let i = 0; i <= retries; i++) {
        token = await acquire(client, key, ttlMs);
        if (token) break;
        if (i < retries) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    if (!token) {
        throw new Error(`[module4/lock] could not acquire lock for ${key} after ${retries} retries`);
    }
    try {
        return await fn();
    } finally {
        await release(client, key, token);
    }
}

module.exports = { acquire, release, extend, withLock };
