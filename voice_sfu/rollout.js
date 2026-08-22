// voice_sfu/rollout.js
// ==================================================
// PHASE 3, STEP 3.5 — STAGED ROLLOUT DECISION ENGINE (NEW, ADDITIVE)
// ==================================================
// Adds the missing production piece Steps 3.1-3.4 deliberately left out:
// a way to move from "100% mesh" to "100% SFU" through safe intermediate
// stages, without any code change or redeploy between stages — only
// environment variables, matching this codebase's existing "VOICE_MODE
// is the single config knob" convention (provider.js).
//
// KEY SAFETY DECISION: the rollout unit is the ROOM, never the
// individual participant. Two people in the SAME PingPong room can
// never end up on different transport backends (one on LiveKit SFU,
// one on mesh WebRTC) — they would be unable to hear each other at all,
// which is a silent, confusing outage dressed up as "voice broken" for
// exactly the users a careful rollout is trying to protect. Every
// decision here is keyed on roomId (or the room's hostId), and is
// deterministic for a given room + config (same room always lands on
// the same side of the decision until an operator changes the config),
// so a room's voice mode cannot flap between requests within a rollout
// stage.
//
// NO NEW AUTHORITY: this module introduces no new admin/role concept.
// "Admin-only" rollout reuses the room's OWN existing hostId/adminIds
// (the exact fields server.js already uses for in-room moderation —
// see server.js's isOwnerOrAdmin()/getRoomRole()), not a separate RBAC
// lookup. This keeps the rollout gate answerable from the same `rooms`
// object roomManager.js already holds a reference to, with zero new
// dependencies and zero risk of the rollout gate disagreeing with the
// app's own notion of who is a host/admin for that room.
//
// VOICE_MODE now recognizes a third literal, "staged", in addition to
// the existing "mesh" (default) and "sfu". Any other/unset value keeps
// falling back to "mesh" — same fail-safe behavior provider.js already
// documents. "staged" alone does nothing (resolves every room to mesh)
// until at least one of the three knobs below is set:
//
//   SFU_STAGE_ALLOWLIST_ROOMS   comma-separated PingPong roomIds that
//                               always get SFU. Use for Stage 2
//                               (internal testing) — put your test
//                               room(s) here.
//   SFU_STAGE_ALLOWLIST_HOSTS   comma-separated userIds; any room HOSTED
//                               by one of these users gets SFU. Use for
//                               Stage 2 (internal testers by account) or
//                               Stage 3 (admin-only — put your
//                               staff/admin userIds here).
//   SFU_STAGE_PERCENT           0-100 integer. That percentage of ALL
//                               rooms (by a stable hash of roomId, not
//                               random-per-request) gets SFU. Use for
//                               Stage 4 (small percentage rollout).
//
// The three knobs are a union (a room gets SFU if it matches ANY of
// them) so an operator can combine them, e.g. keep the test rooms
// allowlisted while ALSO ramping a percentage. The five spec stages map
// to config only, no code path changes between them:
//
//   Stage 1  100% Mesh            VOICE_MODE=mesh (or unset)
//   Stage 2  Internal testing     VOICE_MODE=staged, SFU_STAGE_ALLOWLIST_ROOMS=...
//   Stage 3  Admin-only SFU       VOICE_MODE=staged, SFU_STAGE_ALLOWLIST_HOSTS=<staff ids>
//   Stage 4  Small % rollout      VOICE_MODE=staged, SFU_STAGE_PERCENT=5 (e.g.)
//   Stage 5  Full rollout         VOICE_MODE=sfu
//
// ROLLBACK: setting VOICE_MODE=mesh at ANY stage (2-5) immediately and
// completely reverts every room to mesh — see rawBaseMode() below, which
// is checked first and short-circuits before any of the three knobs are
// even read. No code rollback, no deployment rollback, no database
// rollback — exactly the spec's rollback requirement. This module does
// not persist anything; there is no rollout state to "roll back" beyond
// the env vars themselves.

function rawBaseMode() {
    const mode = (process.env.VOICE_MODE || "mesh").trim().toLowerCase();
    if (mode === "sfu" || mode === "staged") return mode;
    return "mesh"; // unrecognized value never fails open into sfu/staged
}

function parseListEnv(name) {
    const raw = process.env[name];
    if (!raw) return [];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function clampPercent(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

// Deterministic 0-99 bucket for a string. Not cryptographic — this only
// needs to be stable and roughly uniform, the same bar turn-config.js's
// existing helpers hold themselves to. FNV-1a, tiny and dependency-free.
function bucketOf(str) {
    let h = 0x811c9dc5;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return Math.abs(h) % 100;
}

function getStagedConfigSnapshot() {
    return {
        allowlistRoomsCount: parseListEnv("SFU_STAGE_ALLOWLIST_ROOMS").length,
        allowlistHostsCount: parseListEnv("SFU_STAGE_ALLOWLIST_HOSTS").length,
        percent: clampPercent(process.env.SFU_STAGE_PERCENT)
    };
}

// room may be null/undefined (e.g. a room that no longer exists at
// decision time) — treated as "no host to match", never as a reason to
// throw; callers (provider.js, sync.js) always get a mesh/sfu answer.
function resolveRoomVoiceMode(roomId, room) {
    const base = rawBaseMode();
    if (base === "mesh") return "mesh";
    if (base === "sfu") return "sfu";

    // base === "staged"
    const allowRooms = parseListEnv("SFU_STAGE_ALLOWLIST_ROOMS");
    if (roomId && allowRooms.includes(String(roomId))) return "sfu";

    const allowHosts = parseListEnv("SFU_STAGE_ALLOWLIST_HOSTS");
    const hostId = room && room.hostId;
    if (hostId && allowHosts.includes(String(hostId))) return "sfu";

    const percent = clampPercent(process.env.SFU_STAGE_PERCENT);
    if (percent > 0 && roomId && bucketOf(roomId) < percent) return "sfu";

    return "mesh"; // staged but matched none of the three knobs -> safe default
}

module.exports = { rawBaseMode, resolveRoomVoiceMode, getStagedConfigSnapshot, bucketOf, parseListEnv, clampPercent };
