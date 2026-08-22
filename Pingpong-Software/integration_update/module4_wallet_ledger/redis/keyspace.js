// module4/redis/keyspace.js
// ==================================================
// MODULE 4 — CLUSTER-SAFE KEY NAMING
// ==================================================
// Redis Cluster shards data by CRC16(key) mod 16384 ("hash slot").
// Any operation touching more than one key (MULTI/EXEC, a Lua script,
// even a single command like BRPOPLPUSH with two key args) requires
// every key it touches to land in the SAME slot, or it fails against
// a real cluster with a CROSSSLOT error — even though the identical
// code works fine against a single instance, which has no slots.
//
// Redis's answer to this is "hash tags": if a key contains `{...}`,
// only the text inside the braces is hashed, not the whole key. So
// `pingpong:{room:42}:seats` and `pingpong:{room:42}:lock` hash to the
// same slot (both use `room:42` as the tag) even though the full key
// strings differ.
//
// RULE FOR EVERY module4/ FILE: any set of keys that must be read or
// written together atomically (a room's lock + its state, a user's
// routing entry + its TTL sentinel, etc.) MUST be built through
// roomKey()/userKey()/tag() below, never hand-assembled with template
// strings. This costs nothing on a single instance (hash tags are
// inert there) and is the entire reason Cluster migration later needs
// no changes to locking/state logic — only to connectionFactory.js's
// topology config.

const PREFIX = process.env.REDIS_KEY_PREFIX || "pingpong:";

function tag(t) {
    return `{${t}}`;
}

// All room-scoped keys (state, lock, version, etc.) share one tag so
// they always co-locate, even under Cluster.
function roomKey(roomId, suffix) {
    return `${PREFIX}${tag(`room:${roomId}`)}:${suffix}`;
}

// Same idea for a single user's routing/session-adjacent keys.
function userKey(userId, suffix) {
    return `${PREFIX}${tag(`user:${userId}`)}:${suffix}`;
}

// Generic escape hatch for keys that are intentionally single-key and
// never combined with another key in the same operation (e.g. a
// cluster-wide counter). No hash tag needed — one key can't CROSSSLOT
// with itself.
function globalKey(suffix) {
    return `${PREFIX}global:${suffix}`;
}

module.exports = { roomKey, userKey, globalKey, tag, PREFIX };
