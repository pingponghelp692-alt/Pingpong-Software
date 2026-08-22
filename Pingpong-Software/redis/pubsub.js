// redis/pubsub.js
// ==================================================
// PHASE 2B-1 — CROSS-INSTANCE PUB/SUB (state-awareness channels)
// ==================================================
// NOT the same mechanism as redis/socketAdapter.js. That adapter handles
// real-time delivery of actual Socket.IO events (io.to(room).emit, etc.)
// across instances — it already solves "room events"/"voice events" in
// the sense of live signaling, transparently, with no code changes
// elsewhere. This module is for a different, narrower job: lightweight
// cross-instance AWARENESS — "a user went online/offline somewhere in
// the cluster", "a room was created/removed somewhere in the cluster",
// "this instance is alive and here's its snapshot" — the kind of thing
// an admin dashboard or a future cluster-aware feature wants to know
// without querying every instance directly. Two different Redis channel
// namespaces (`socket.io#...` for the adapter, `events:*` here) so
// neither ever sees or misinterprets the other's traffic — no duplicate
// broadcast paths.
//
// FOUR CATEGORIES (per the Phase 2B-1 spec): "room", "voice",
// "presence", "system". Each is its own Redis channel
// (`{KEY_PREFIX}events:{category}`) so a future subscriber can listen to
// only what it cares about instead of filtering a firehose.
//
// LOOP / DUPLICATE-EVENT SAFETY: Redis PUBLISH delivers to every
// subscriber on a channel, including the instance that published — this
// instance's own subConn is subscribed to the same channels it publishes
// to. Every message carries the publishing instance's id, and incoming
// messages whose instanceId matches this instance are dropped before any
// handler runs. This is the one thing that prevents an accidental
// publish-on-receive handler anywhere (now or in a future phase) from
// becoming an infinite loop, so it lives here centrally rather than
// being each handler's own responsibility to remember.
//
// SAFETY CONTRACT: same as the rest of redis/ — if Redis is disabled,
// init() is a no-op and publish() resolves to `false` without throwing.
// Nothing that calls into this module needs its own Redis-availability
// check first.

const client = require("./client.js");

const INSTANCE_ID = `${require("os").hostname()}:${process.pid}`;
const CATEGORIES = ["room", "voice", "presence", "system"];

function channelFor(category) {
    return client.prefixed(`events:${category}`);
}

let initialized = false;
const handlers = { room: [], voice: [], presence: [], system: [] };

// Register a handler for one category. Handlers only ever receive
// events published by OTHER instances (see loop-safety note above) —
// this instance's own actions never loop back through here. A handler
// that throws is caught and logged; it can never take down the
// subscriber connection or affect other handlers.
function on(category, handler) {
    if (!handlers[category]) throw new Error(`[redis/pubsub] unknown category: ${category}`);
    handlers[category].push(handler);
}

function init() {
    if (initialized) return;
    initialized = true;
    if (!client.isEnabled()) return;
    const sub = client.getSubscriberConnection();
    if (!sub) return;
    const channels = CATEGORIES.map(channelFor);
    sub.subscribe(...channels).catch((e) => console.warn(`[redis/pubsub] subscribe failed: ${e.message}`));
    sub.on("message", (channel, raw) => {
        try {
            const category = CATEGORIES.find((c) => channelFor(c) === channel);
            if (!category) return; // some other channel on this connection — ignore, not ours
            const msg = JSON.parse(raw);
            if (!msg || msg.instanceId === INSTANCE_ID) return; // loop guard — see header
            for (const h of handlers[category]) {
                try { h(msg); } catch (e) { console.error(`[redis/pubsub] ${category} handler error:`, e && e.message); }
            }
        } catch (e) {
            console.warn(`[redis/pubsub] failed to process message on ${channel}: ${e.message}`);
        }
    });
    sub.on("error", (e) => console.warn(`[redis/pubsub] subscriber connection error: ${e.message}`));
    console.log(`[redis/pubsub] subscribed to ${channels.length} cross-instance event channels`);
}

// Fire-and-forget by design (callers already treat every Redis
// interaction as best-effort throughout this layer) — resolves to
// true/false rather than throwing so a publish call can never be the
// thing that breaks a request.
async function publish(category, eventName, payload) {
    if (!client.isEnabled()) return false;
    if (!handlers[category]) return false;
    const conn = client.getConnection();
    if (!conn) return false;
    try {
        const msg = JSON.stringify({ instanceId: INSTANCE_ID, event: eventName, payload, ts: Date.now() });
        await conn.publish(channelFor(category), msg);
        return true;
    } catch (e) {
        console.warn(`[redis/pubsub] publish(${category}, ${eventName}) failed: ${e.message}`);
        return false;
    }
}

module.exports = { init, on, publish, INSTANCE_ID, CATEGORIES };
