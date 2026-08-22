// redis/socketAdapter.js
// ==================================================
// PHASE 2B-1 — SOCKET.IO REDIS ADAPTER
// ==================================================
// Attaches the official @socket.io/redis-adapter to the app's existing
// `io` instance. This is the single highest-leverage change in Phase
// 2B-1: once attached, every `io.to(roomId).emit(...)`, `socket.emit`,
// `io.emit`, and room join/leave call ALREADY present throughout
// server.js / callSignaling.js / voice-reconnect.js / callHosting.js /
// etc. transparently broadcasts across every instance sharing this
// Redis — with ZERO changes to any of those call sites. That's the
// standard, purpose-built way Socket.IO itself supports horizontal
// scaling; reimplementing that broadcast logic by hand (e.g. a custom
// pub/sub channel per socket event) would be exactly the kind of
// duplicate, riskier logic this phase was told to avoid.
//
// WHAT THIS DOES NOT DO: it doesn't change *what* gets broadcast or
// *when* — only *how far* the existing broadcast reaches once more than
// one instance is running. Single-instance deployments (today) see zero
// behavior change: Socket.IO's default in-memory adapter already
// delivers every event correctly within one process, and this module
// only overrides that default when Redis is actually configured AND the
// adapter package is actually installed.
//
// SAFETY CONTRACT (same shape as every other redis/*.js file):
//   - If @socket.io/redis-adapter isn't installed: no-op, default
//     in-memory adapter stays active.
//   - If Redis isn't configured/enabled: no-op, default adapter stays
//     active.
//   - If attaching throws for any other reason: caught, logged, default
//     adapter stays active. Never blocks server startup.
//   - Once attached, a Redis connection hiccup does not crash the
//     process — ioredis's own reconnect logic (see client.js) keeps
//     retrying, and the adapter's error events are listened for and
//     logged rather than left to bubble up as uncaught exceptions.
//
// SECURITY NOTE (per the adapter's own docs): Redis Pub/Sub messages
// used by this adapter are not signed or encrypted. As already
// documented in redis/client.js, this Redis instance is assumed to be
// part of this app's own trusted internal infrastructure (not exposed
// publicly) — nothing new here changes that existing trust boundary.

let createAdapter = null;
try {
    ({ createAdapter } = require("@socket.io/redis-adapter"));
} catch (e) {
    // Package not installed yet — stays disabled, exactly like every
    // other optional dependency in this Redis layer (ioredis included).
    createAdapter = null;
}

const client = require("./client.js");

function initSocketIOAdapter(io) {
    if (!createAdapter) {
        console.warn("[redis/socketAdapter] @socket.io/redis-adapter not installed (npm install @socket.io/redis-adapter) — Socket.IO stays on its default in-memory (single-instance) adapter.");
        return { attached: false, reason: "package not installed" };
    }
    if (!client.isEnabled()) {
        console.warn("[redis/socketAdapter] Redis not configured — Socket.IO stays on its default in-memory (single-instance) adapter.");
        return { attached: false, reason: "redis disabled" };
    }
    const conns = client.getAdapterConnections();
    if (!conns) {
        console.warn("[redis/socketAdapter] adapter connections unavailable — staying on default in-memory adapter.");
        return { attached: false, reason: "connections unavailable" };
    }
    try {
        io.adapter(createAdapter(conns.pubClient, conns.subClient, {
            // Namespaces this adapter's own internal channels the same
            // way every other key/channel in this app already is, so a
            // shared Redis instance can't collide with another app.
            key: `${client.KEY_PREFIX}socket.io`,
        }));
        // ioredis connections throw if an "error" event has zero
        // listeners — client.js's makeConnection() already attaches one
        // for its own health tracking, so this is defense-in-depth, not
        // the only guard, but kept explicit here since a crash on this
        // specific pair would silently drop back to single-instance
        // behavior mid-flight rather than at startup.
        conns.pubClient.on("error", (e) => console.warn(`[redis/socketAdapter] pub connection error: ${e.message}`));
        conns.subClient.on("error", (e) => console.warn(`[redis/socketAdapter] sub connection error: ${e.message}`));
        console.log("[redis/socketAdapter] Socket.IO Redis Adapter attached — io.to()/emit() now broadcasts across every instance sharing this Redis.");
        return { attached: true };
    } catch (e) {
        console.warn(`[redis/socketAdapter] failed to attach, staying on default in-memory adapter: ${e.message}`);
        return { attached: false, reason: e.message };
    }
}

module.exports = { initSocketIOAdapter };
