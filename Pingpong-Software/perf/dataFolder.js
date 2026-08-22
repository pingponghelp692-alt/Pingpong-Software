// ==================================================
// PHASE 12 — PERSISTENT DISK PATH RESOLUTION (additive)
// ==================================================
// Pure path helper — changes WHERE data/uploads live on disk, never HOW
// they're read/written. Every other file in this codebase only ever
// receives DATA_FOLDER / the upload folders as already-resolved constants
// (from server.js, via plain values or dependency injection) — so
// resolving those two roots differently here is invisible everywhere else:
// no other module, route, socket event, or API response changes.
//
// Default behaviour (PERSISTENT_DISK_PATH unset) is byte-for-byte what
// this app has always done: <project root>/data and <project root>/uploads.
//
// If a Render Persistent Disk (or any mounted volume) is attached and its
// mount path is put in the PERSISTENT_DISK_PATH env var, both data/*.json
// and every uploads/* folder (photos, frames, vehicle videos, gift
// assets, KYC docs, etc.) automatically live there instead — surviving a
// Render redeploy/restart with ZERO code changes needed after the env var
// is set. This is "Option A" (persistent disk) made a one-env-var switch.

const path = require("path");

function resolveDataFolder(appRoot) {
    const base = process.env.PERSISTENT_DISK_PATH;
    return base ? path.join(path.resolve(base), "data") : path.join(appRoot, "data");
}

function resolveUploadsRoot(appRoot) {
    const base = process.env.PERSISTENT_DISK_PATH;
    return base ? path.join(path.resolve(base), "uploads") : path.join(appRoot, "uploads");
}

module.exports = { resolveDataFolder, resolveUploadsRoot };
