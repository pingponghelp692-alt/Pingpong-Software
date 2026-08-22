// module4/redis/userProfile.js
// ==================================================
// MODULE 4 — STEP 4.5: DISTRIBUTED USER PROFILE (read-through cache)
// ==================================================
// Fourth and last entity from the Step 4.1 migration order — lowest
// risk, least urgent, done last on purpose.
//
// SOURCE OF TRUTH: unchanged. server.js's `users` object (backed by
// USERS_FILE, mirrored to Postgres as a whole-blob backstop by the
// existing perf/dbPersistence.js) remains authoritative for every
// field, exactly as today. This module is NOT a second source of
// truth the way module4/wallet/ is for money — it's a cross-instance
// CACHE that the instance which made a change writes through to, so
// other instances' reads see it without waiting on anything. This is
// a materially different (and simpler/lower-risk) contract than
// Steps 4.3/4.4, which is why no lock is used here — see "Why no
// lock" below.
//
// WHAT'S IN SCOPE — chosen by inspecting two things in server.js:
//   1. POST /api/user/complete-profile ("Create Your Profile" screen)
//      — the fields a user explicitly edits as their profile:
//      name, gender, country, language, profile_completed.
//   2. publicRoom()'s seat-mapping code, which already re-reads these
//      specific fields LIVE from the user record on every request
//      specifically so a change "shows up on the seat instantly,
//      without needing a manual sync call" (see server.js's own
//      comment there): activeFrame, vipLevel, customTag, nameEffect.
//      This is the exact cross-instance correctness gap Step 4.5
//      closes — today that live-read only works because it's reading
//      the SAME process's `users` object the seat's owner connected
//      to. Once Module 4 is merged and rooms can span instances (per
//      Step 4.3), a seat on instance B needs a way to see a frame
//      change made on instance A without waiting for anything. This
//      cache is that mechanism. photo and customId are the same kind
//      of "shown next to identity everywhere" field, added for the
//      same reason.
//
// WHAT'S DELIBERATELY OUT OF SCOPE (documented, not just omitted):
//   - diamonds, coins            -> module4/wallet/ already owns these (Step 4.4)
//   - seats/room membership      -> module4/redis/roomState.js already owns these (Step 4.3)
//   - banned, verified, isHost   -> access-control-relevant. A cache
//     has a staleness window by definition; serving a stale "not
//     banned" for a just-banned user is a security bug, not a
//     performance tradeoff. Any access-control check MUST keep
//     reading the authoritative `users` object directly, never this
//     cache — this module intentionally does not offer these fields
//     at all, so a future caller can't reach for them here by mistake.
//   - passwordHash, mobile       -> auth/PII. Never belongs in a
//     cross-instance cache regardless of any other consideration.
//   - followersList, followingList, recentRooms, groups -> social
//     graph/activity, a distinct entity from "profile" that the Step
//     4.1 plan never scoped in; would be its own migration decision.
//   - svipWealth, svipLevel, svipMembershipType -> wealth-adjacent.
//     Step 4.1 explicitly scoped this step to "non-financial" fields;
//     if these are ever migrated they belong conceptually next to
//     module4/wallet/, not here.
//   - agencyId, isCoinCenter     -> admin/business role flags, not
//     user-facing profile.
//   - vehicleInventory, frameInventory -> cosmetic ownership with its
//     own expiry business logic (assignedAt/expiresAt/permanent) —
//     migrating inventory correctly is a bigger decision than a
//     display cache and isn't duplicated here. NOTE: `activeFrame` IS
//     in scope (which frame is currently shown) — the inventory that
//     backs it is not (what frames are owned).
//
// WHY NO LOCK (unlike roomState.js/wallet): every field here is
// independently meaningful — two instances writing different fields
// for the same user at the same time (one updates `name`, another
// updates `activeFrame`) can't corrupt each other via Redis HSET,
// which only touches the fields it's given. There's no "read-modify-
// write the whole document" step the way seat assignment or balance
// arithmetic requires, so there's no race to protect against. If a
// future field needs multi-field atomicity, add it via
// module4/redis/lock.js at that time — don't retrofit locking here
// speculatively.
//
// KNOWN LIMITATION (stated plainly, not glossed over): this is a
// cache, not a queryable store. getProfile() for a userId that no
// instance has ever written through returns null — there is no
// Postgres/centralized fallback this module can query, because
// profile truth intentionally stays as each instance's local
// `users` object (per Step 4.1's "Postgres/JSON as truth" framing —
// JSON here, not a new Postgres table, since that would be a bigger
// scope decision than this "lowest risk" step warrants). This means
// a user who has only ever connected to instance A is invisible to
// this cache until instance A writes their profile through — a
// caller integrating this at merge time needs to call setProfile()
// on load/connect, not only on edit, or reads on other instances
// will see gaps rather than data. This is exactly why the Step 4.1
// plan marked this entity "lowest risk, least urgent" rather than
// "solved" — closing this gap fully would mean centralizing profile
// storage, a decision explicitly deferred past Module 4.

const connectionFactory = require("./connectionFactory.js");
const keyspace = require("./keyspace.js");

const PROFILE_TTL_SECONDS = parseInt(process.env.MODULE4_PROFILE_TTL_SECONDS || "86400", 10); // 24h safety-net TTL — the primary freshness mechanism is explicit write-through, not this expiry

// The allowlist is enforced, not just documented — setProfile() rejects
// any key outside this list so scope can't silently creep at a future
// call site without a deliberate change to this file.
const PROFILE_FIELDS = [
    "name", "photo", "gender", "country", "language", "profile_completed",
    "activeFrame", "vipLevel", "customTag", "nameEffect", "customId",
];

let client = null;

function init() {
    if (client) return;
    client = connectionFactory.createClient("module4-userProfile");
    if (!client) {
        console.warn("[module4/userProfile] Redis unavailable — profile cache calls will no-op (safe: caller should fall back to its own local `users` object, which remains the real source of truth)");
    }
}

function isEnabled() {
    return !!client;
}

function assertKnownFields(patch) {
    const unknown = Object.keys(patch).filter((k) => !PROFILE_FIELDS.includes(k));
    if (unknown.length) {
        throw new Error(`[module4/userProfile] unsupported field(s) for this step's scope: ${unknown.join(", ")}. See the file header for what's in/out of scope and why.`);
    }
}

// Serializes object/array-valued fields (activeFrame, customTag) as
// JSON since Redis hash fields are strings; scalar fields pass through.
function encodeField(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

function decodeField(fieldName, raw) {
    if (raw === "" || raw === null || raw === undefined) return null;
    if (["activeFrame", "customTag"].includes(fieldName)) {
        try { return JSON.parse(raw); } catch (e) { return null; }
    }
    if (fieldName === "vipLevel") return Number(raw);
    if (fieldName === "profile_completed") return raw === "true" || raw === "1";
    return raw;
}

// Write-through: call this from whichever instance made the change,
// right after it updates its own local `users` object (not instead of
// — this module never becomes the write target, only a broadcast of
// what was already written locally). Partial patches are fine — only
// the given fields are touched, everything else in the cached hash is
// left as-is.
async function setProfile(userId, patch) {
    // BUG FIX (Module 4 verification, 2026-08-06): assertKnownFields() must
    // run BEFORE the "no client" early-return, not after — otherwise the
    // allowlist is silently skipped for the entire duration Redis is down,
    // which is exactly when a bad call site is least likely to be caught by
    // anything else. The allowlist is meant to be enforced unconditionally,
    // independent of whether the write actually reaches Redis.
    assertKnownFields(patch);
    if (!client) return false;
    if (!Object.keys(patch).length) return true; // nothing to write, not an error
    try {
        const key = keyspace.userKey(userId, "profile");
        const encoded = {};
        for (const [k, v] of Object.entries(patch)) encoded[k] = encodeField(v);
        await client.hset(key, encoded);
        await client.expire(key, PROFILE_TTL_SECONDS);
        return true;
    } catch (e) {
        console.warn(`[module4/userProfile] setProfile failed for ${userId}: ${e.message}`);
        return false;
    }
}

// Returns the cached subset of PROFILE_FIELDS present for this user,
// or null if nothing has ever been written through for them (see
// "Known limitation" above — this is NOT the same as "user doesn't
// exist", just "no instance has cached them yet").
async function getProfile(userId) {
    if (!client) return null;
    try {
        const key = keyspace.userKey(userId, "profile");
        const raw = await client.hgetall(key);
        if (!raw || !Object.keys(raw).length) return null;
        const decoded = {};
        for (const [k, v] of Object.entries(raw)) decoded[k] = decodeField(k, v);
        return decoded;
    } catch (e) {
        console.warn(`[module4/userProfile] getProfile failed for ${userId}: ${e.message}`);
        return null;
    }
}

// Explicit cleanup for account deletion — not called automatically by
// anything in this module (no code here knows when an account is
// deleted; that decision stays in server.js).
async function deleteProfile(userId) {
    if (!client) return false;
    try {
        await client.del(keyspace.userKey(userId, "profile"));
        return true;
    } catch (e) {
        console.warn(`[module4/userProfile] deleteProfile failed for ${userId}: ${e.message}`);
        return false;
    }
}

async function shutdown() {
    if (client) await client.quit().catch(() => {});
    client = null;
}

module.exports = {
    init,
    isEnabled,
    setProfile,
    getProfile,
    deleteProfile,
    shutdown,
    PROFILE_FIELDS,
};
