// module4/redis/routing.js
// ==================================================
// MODULE 4 — STEP 4.2: CROSS-INSTANCE SOCKET ROUTING (Redis-authoritative)
// ==================================================
// First entity in the migration order from STEP_4.1: which instance
// currently owns a given user's live socket. Chosen first because
// every other cross-instance operation (targeted emit to a user who
// may be connected elsewhere, room ops on a user on another instance)
// needs this answered correctly, and getting it wrong has a small
// blast radius (a missed/duplicate emit) compared to seat or wallet
// state.
//
// NOT WIRED INTO server.js. This is standalone, isolated Module 4
// code — server.js's existing `socketsByUserId` in-memory map is
// completely untouched and keeps being what server.js actually reads
// today. This module becomes the source of truth only once you merge
// Module 4 and swap server.js's reads/writes over to it (a small,
// explicit, reviewable change at merge time — not something this
// step does silently).
//
// CLUSTER READINESS: one hash key per user (keyspace.userKey), one
// TTL on that same key. No multi-key operation anywhere in this file,
// so nothing here changes when the deployment moves from "single" to
// "cluster"/"sentinel" — only connectionFactory.js's env config does.
//
// TTL / LIVENESS: a route expires on its own (ROUTE_TTL_MS) if not
// refreshed, so a crashed instance's stale routing entries clear
// themselves without any other instance needing to detect the crash
// and clean up — same self-expiry principle redis/roomState.js (Phase
// 2A) already uses for the same reason.

const connectionFactory = require("./connectionFactory.js");
const keyspace = require("./keyspace.js");

const INSTANCE_ID = `${require("os").hostname()}:${process.pid}`;
const ROUTE_TTL_MS = parseInt(process.env.MODULE4_ROUTE_TTL_MS || "45000", 10);
const REFRESH_INTERVAL_MS = parseInt(process.env.MODULE4_ROUTE_REFRESH_MS || "15000", 10);

let client = null;
let refreshTimer = null;
// userId -> socketId, tracked locally only so the refresh loop knows
// what to re-arm the TTL on — this is NOT a source of truth, just a
// "what do I own" list for the heartbeat below.
const ownedRoutes = new Map();

function init() {
    if (client) return; // idempotent
    client = connectionFactory.createClient("module4-routing");
    if (!client) {
        console.warn("[module4/routing] Redis unavailable — routing calls will no-op (safe: no crash, no cross-instance routing)");
        return;
    }
    refreshTimer = setInterval(refreshOwnedRoutes, REFRESH_INTERVAL_MS);
    refreshTimer.unref();
}

function isEnabled() {
    return !!client;
}

// Call when a user's socket connects on THIS instance.
async function setRoute(userId, socketId) {
    if (!client) return false;
    try {
        const key = keyspace.userKey(userId, "route");
        await client.hset(key, {
            instanceId: INSTANCE_ID,
            socketId,
            updatedAt: new Date().toISOString(),
        });
        await client.pexpire(key, ROUTE_TTL_MS);
        ownedRoutes.set(userId, socketId);
        return true;
    } catch (e) {
        console.warn(`[module4/routing] setRoute failed for ${userId}: ${e.message}`);
        return false;
    }
}

// Returns { instanceId, socketId, updatedAt } or null (nowhere in the
// cluster / Redis disabled / expired).
async function getRoute(userId) {
    if (!client) return null;
    try {
        const key = keyspace.userKey(userId, "route");
        const data = await client.hgetall(key);
        if (!data || !data.instanceId) return null;
        return data;
    } catch (e) {
        console.warn(`[module4/routing] getRoute failed for ${userId}: ${e.message}`);
        return null;
    }
}

// Call on disconnect. Only clears if THIS socketId is still the one
// recorded — prevents a delayed disconnect handler from a stale
// connection clobbering a route a fresher reconnect already set.
async function clearRoute(userId, socketId) {
    ownedRoutes.delete(userId);
    if (!client) return false;
    try {
        const key = keyspace.userKey(userId, "route");
        const current = await client.hget(key, "socketId");
        if (current === socketId) {
            await client.del(key);
        }
        return true;
    } catch (e) {
        console.warn(`[module4/routing] clearRoute failed for ${userId}: ${e.message}`);
        return false;
    }
}

// Heartbeat: re-arm the TTL on every route this instance currently
// owns, so a live connection's routing entry never expires out from
// under it, while a crashed instance's entries age out naturally.
async function refreshOwnedRoutes() {
    if (!client || !ownedRoutes.size) return;
    const entries = Array.from(ownedRoutes.entries());
    await Promise.all(entries.map(async ([userId, socketId]) => {
        try {
            const key = keyspace.userKey(userId, "route");
            const current = await client.hget(key, "socketId");
            if (current === socketId) {
                await client.pexpire(key, ROUTE_TTL_MS);
            } else {
                // Someone else (or nothing) owns this key now — stop tracking it.
                ownedRoutes.delete(userId);
            }
        } catch (e) {
            console.warn(`[module4/routing] refresh failed for ${userId}: ${e.message}`);
        }
    }));
}

async function shutdown() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (client) await client.quit().catch(() => {});
    client = null;
    ownedRoutes.clear();
}

module.exports = { init, isEnabled, setRoute, getRoute, clearRoute, shutdown, INSTANCE_ID };
