// redis/roomOpRpc.js
// ==================================================
// GAP #2 (Cross-Instance Room Operation Forwarding)
// ==================================================
// Continuation of redis/roomJoinRpc.js's pattern, generalized from "one
// operation (join)" to "any owner-dependent room operation". The known
// limitation GAP #1 left behind: once a user is IN a room that a
// *different* cluster instance owns (joined locally, or joined via
// roomJoinRpc's cross-instance join), every subsequent room-mutating
// socket event on THIS instance hit `const room = rooms[roomId]; if
// (!room) return;` — a silent no-op, because `rooms` is this process's
// own in-memory object and the room genuinely isn't here. take-seat,
// leave-seat, and send-message simply did nothing. This module closes
// that gap the same safe, additive way roomJoinRpc.js closed the join
// case: request/response over the existing redis/pubsub.js "room"
// channel (a THIRD event pair on that channel — "op-request"/
// "op-response" — additive alongside "join-request"/"join-response",
// same category, same fire-and-forget publish primitive, no new Redis
// capability, no new connection).
//
// WHY THIS SHAPE:
//   - `rooms` (server.js's in-memory object) stays the ONLY authoritative
//     store for a room hosted on THIS instance, exactly like
//     roomJoinRpc.js. This module never reads/writes it for a room this
//     instance already has locally — the local socket handler in
//     server.js keeps running its existing local code unchanged.
//   - Every operation is registered by NAME ("take-seat", "leave-seat",
//     "send-message", ...) against a "performer" function supplied by
//     server.js — the exact same function server.js's local handler
//     already calls for the local-room case. A cross-instance operation
//     is therefore not a second code path with its own bugs to find
//     later; it's the one real mutation function, reached over pub/sub
//     instead of a direct call — identical to how roomJoinRpc.js reuses
//     performRoomJoin().
//   - Generalized (a `Map<opName, performerFn>` instead of one hardcoded
//     function) so adding another owner-dependent operation later
//     (lock-seat, kick-user, mod-* actions, etc.) is a one-line
//     `registerOp(...)` call in server.js, not a new RPC module.
//
// CONTRACT for a registered performer: `(room, payload) => result`.
// `result` is operation-specific (server.js decides the shape per op,
// same as performRoomJoin's `{ ok, error, needPassword }`) but by
// convention always has at least `{ ok: boolean }`. Whatever the
// performer returns is sent back verbatim as the RPC response payload's
// `result` field — this module never inspects or reshapes it, so a new
// op's result shape needs zero changes here.
//
// SAFETY / TIMEOUT CONTRACT: identical to roomJoinRpc.js. If nobody
// answers within RPC_TIMEOUT_MS (room doesn't exist anywhere in the
// cluster, Redis is down, or the owning instance crashed mid-flight),
// the caller gets back `{ ok: false, error: "timeout" }` and server.js's
// existing per-event fallback (silent no-op / room-error, matching what
// that event already did before GAP #2) applies — nothing here can leave
// a client hanging forever.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not touch anything
// socket-local to the REQUESTING instance (e.g. `socket.leave(roomId)`,
// `socketsByUserId` bookkeeping). Those stay exactly where they already
// are in server.js's handlers, run unconditionally on the requesting
// instance regardless of which instance owns the room — only the room's
// OWN authoritative fields are ever mutated remotely, same boundary
// roomJoinRpc.js already drew.

const pubsub = require("./pubsub.js");
const client = require("./client.js");

const RPC_TIMEOUT_MS = 4000;

function initRoomOpRpc({ rooms }) {
    const performers = new Map(); // opName -> (room, payload) => result
    const pendingRequests = new Map(); // requestId -> { resolve, timer }

    function registerOp(opName, performerFn) {
        if (typeof performerFn !== "function") throw new Error(`[redis/roomOpRpc] registerOp(${opName}): performerFn must be a function`);
        performers.set(opName, performerFn);
    }

    pubsub.on("room", (msg) => {
        if (!msg || !msg.event || !msg.payload) return;

        // ---- Someone in the cluster is asking this instance to run an
        // owner-dependent operation against a room. Only the instance
        // that actually has the room locally responds — same ownership
        // discovery-by-silence roomJoinRpc.js already uses, no separate
        // directory to keep in sync.
        if (msg.event === "op-request") {
            const { requestId, opName, roomId, payload, requestingInstanceId } = msg.payload;
            const room = rooms[roomId];
            if (!room) return; // not ours
            const performerFn = performers.get(opName);
            if (!performerFn) {
                // Op forwarded to an instance whose server.js version
                // doesn't know this op name (e.g. mid-rolling-deploy).
                // Answer honestly rather than staying silent, so the
                // requester's RPC resolves promptly instead of waiting
                // out the full timeout for what would otherwise look
                // like a crashed owner.
                pubsub.publish("room", "op-response", {
                    requestId, targetInstanceId: requestingInstanceId,
                    ok: false, error: "unknown-op", result: null,
                });
                return;
            }
            let result;
            try {
                result = performerFn(room, payload || {});
            } catch (e) {
                console.warn(`[redis/roomOpRpc] performer(${opName}, ${roomId}) threw: ${e.message}`);
                result = { ok: false, error: "op-failed" };
            }
            pubsub.publish("room", "op-response", {
                requestId, targetInstanceId: requestingInstanceId,
                ok: !!(result && result.ok),
                error: (result && result.error) || null,
                result: result || null,
            });
            return;
        }

        // ---- A reply to a request THIS instance made. Every instance
        // receives every op-response (same broadcast channel); ones
        // addressed to a different instance, or to a requestId no
        // longer pending here (already resolved / already timed out),
        // are silently ignored — not an error, same as roomJoinRpc.js.
        if (msg.event === "op-response") {
            const { requestId, targetInstanceId } = msg.payload;
            if (targetInstanceId !== pubsub.INSTANCE_ID) return;
            const pending = pendingRequests.get(requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            pendingRequests.delete(requestId);
            pending.resolve(msg.payload);
        }
    });

    // Returns a Promise<{ ok, error, result }>. Never throws — every
    // failure mode (Redis disabled, publish failure, nobody answers,
    // unknown op on the owning side) resolves to `{ ok: false, error:
    // "..." }` so the caller can always fall through to the same
    // no-op/room-error behavior the event already had before GAP #2.
    async function forwardOp(opName, roomId, payload) {
        if (!client.isEnabled()) return { ok: false, error: "redis-disabled" };
        const requestId = `${pubsub.INSTANCE_ID}:${roomId}:${opName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        let published = false;
        try {
            published = await pubsub.publish("room", "op-request", {
                requestId, opName, roomId, payload: payload || {},
                requestingInstanceId: pubsub.INSTANCE_ID,
            });
        } catch (e) {
            return { ok: false, error: "publish-failed" };
        }
        if (!published) return { ok: false, error: "redis-disabled" };

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingRequests.delete(requestId);
                resolve({ ok: false, error: "timeout" });
            }, RPC_TIMEOUT_MS);
            pendingRequests.set(requestId, { resolve, timer });
        });
    }

    return { registerOp, forwardOp };
}

module.exports = { initRoomOpRpc, RPC_TIMEOUT_MS };
