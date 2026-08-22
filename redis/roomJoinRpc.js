// redis/roomJoinRpc.js
// ==================================================
// GAP #1 (Redis Authoritative Runtime State) — REMAINING ITEM 2:
// CROSS-INSTANCE ROOM JOIN
// ==================================================
// Request/response RPC layered on top of the existing redis/pubsub.js
// "room" event category (previously just a reserved no-op — see
// redis/index.js's `pubsub.on("room", () => {})`, still registered
// there and untouched; handlers for a category are additive/multiple,
// this module just adds a second one). Same fire-and-forget publish
// primitive every other cross-instance feature in this layer already
// uses — no new Redis capability, no new connection.
//
// WHY THIS SHAPE (safest additive option, does not touch room
// architecture): `rooms` (server.js's in-memory object) stays the ONLY
// authoritative store for a room hosted on THIS instance — this module
// never reads or writes it for a room this instance already has
// locally. It only exists for the miss case: a `join-room` arrives on
// an instance that does not have `rooms[roomId]`. Rather than
// re-implementing the join/seat/lock logic against a second,
// eventually-consistent copy of the room (which is what the Redis
// roomState.js mirror is, and is explicitly documented as NOT safe to
// treat as live authoritative state — see clusterRead.js's header),
// this asks the cluster "whoever actually owns this room, please run
// the real join for me" and waits briefly for an answer. The instance
// that owns the room runs the *exact same* mutation function
// (`performJoin`, injected by server.js — see its `applyRoomJoin`)
// that its own local join-room handler already uses. A cross-instance
// join is therefore not a second code path with its own bugs to find
// later — it's the one real join function, reached over pub/sub
// instead of a direct function call.
//
// SECURITY NOTE: only an already-hashed room password (or null) is
// ever put on the wire, exactly like room.roomPasswordHash itself
// never leaves server.js's process memory via any other mirror in this
// codebase (see roomState.js's own "DELIBERATELY EXCLUDED" note) — the
// origin instance hashes the plaintext password the client sent using
// the same hashRoomPassword() every local join already uses, and only
// the hash crosses the wire for the owning instance to compare.
//
// TIMEOUT / SAFETY CONTRACT: if nobody answers within RPC_TIMEOUT_MS
// (room genuinely doesn't exist anywhere in the cluster, Redis is
// down, or the owning instance crashed mid-flight), the caller gets
// back `{ ok: false, error: "timeout" }` and the existing
// `room-error` fallback in server.js's join-room handler applies —
// nothing here can leave a client hanging forever.

const pubsub = require("./pubsub.js");
const client = require("./client.js");

const RPC_TIMEOUT_MS = 4000;

function initRoomJoinRpc({ rooms, performJoin, publicRoom }) {
    const pendingRequests = new Map(); // requestId -> { resolve, timer }

    pubsub.on("room", (msg) => {
        if (!msg || !msg.event || !msg.payload) return;

        // ---- Someone in the cluster is asking to join a room. Only the
        // instance that actually has it locally responds; everyone else
        // (including an instance that also doesn't have it) stays silent —
        // this is how the "owner" is discovered without any separate
        // room-ownership directory to keep in sync.
        if (msg.event === "join-request") {
            const { requestId, roomId, userId, userName, userPhoto, socketId, passwordHash, requestingInstanceId } = msg.payload;
            const room = rooms[roomId];
            if (!room) return; // not ours
            let result;
            try {
                result = performJoin(room, { userId, userName, userPhoto, socketId, passwordHash });
            } catch (e) {
                console.warn(`[redis/roomJoinRpc] performJoin(${roomId}, ${userId}) threw: ${e.message}`);
                result = { ok: false, error: "join-failed" };
            }
            pubsub.publish("room", "join-response", {
                requestId,
                targetInstanceId: requestingInstanceId,
                ok: !!(result && result.ok),
                error: (result && result.error) || null,
                needPassword: !!(result && result.needPassword),
                room: result && result.ok && typeof publicRoom === "function" ? publicRoom(room) : null,
            });
            return;
        }

        // ---- A reply to a request THIS instance made. Every instance in
        // the cluster receives every join-response (same broadcast
        // channel), so ones addressed to a different instance, or to a
        // requestId this instance no longer has pending (already resolved
        // or already timed out), are silently ignored — not an error.
        if (msg.event === "join-response") {
            const { requestId, targetInstanceId } = msg.payload;
            if (targetInstanceId !== pubsub.INSTANCE_ID) return;
            const pending = pendingRequests.get(requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            pendingRequests.delete(requestId);
            pending.resolve(msg.payload);
        }
    });

    // Returns a Promise<{ ok, error, needPassword, room }>. Never throws —
    // every failure mode (Redis disabled, publish failure, nobody
    // answers) resolves to `{ ok: false, error: "..." }` so the caller
    // can always fall through to the existing "Room not found" behavior.
    async function requestCrossInstanceJoin({ roomId, userId, userName, userPhoto, socketId, passwordHash }) {
        if (!client.isEnabled()) return { ok: false, error: "redis-disabled" };
        const requestId = `${pubsub.INSTANCE_ID}:${roomId}:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        let published = false;
        try {
            published = await pubsub.publish("room", "join-request", {
                requestId, roomId, userId, userName, userPhoto, socketId, passwordHash,
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

    return { requestCrossInstanceJoin };
}

module.exports = { initRoomJoinRpc, RPC_TIMEOUT_MS };
