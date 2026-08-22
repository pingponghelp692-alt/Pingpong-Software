// ==================================================
// PHASE 11 — DEBOUNCED DISK-WRITE QUEUE (additive)
// ==================================================
// The problem this fixes: server.js's safeWrite() previously did a
// SYNCHRONOUS fs.writeFileSync(JSON.stringify(entireObject)) on every
// single mutation — saveUsers() alone is called 70+ times across
// server.js/svip.js/banManagement.js/diamondSeller.js/vipApproval.js/
// agencyHost.js/coinCenter.js, meaning a busy room (gifts, coin updates,
// follows) can trigger dozens of full users.json rewrites per second,
// each one BLOCKING the entire Node event loop (all users, all rooms,
// every socket) until that write finishes. That's the single biggest
// perf bottleneck in this codebase, and it gets worse as data grows
// (writeFileSync cost scales with users.json's total size, not with the
// size of the one change).
//
// The fix: coalesce writes. The in-memory object (`users`, `rooms`, etc.)
// is already the source of truth and is already updated synchronously
// before save*() is ever called — so it's safe to let the DISK copy lag
// by a short, bounded window. This module debounces per-file: multiple
// saves to the same file within DEBOUNCE_MS collapse into one actual
// write of whatever the object looks like at the end of that window,
// using the async fs.writeFile so it doesn't block the event loop.
//
// Honest tradeoff (documented, not hidden): a hard crash/power-loss
// within the debounce window (default 250ms) can lose whatever changed
// in that window, versus the old code's immediate-write guarantee. Two
// mitigations: (1) the window is short — 250ms of a busy chat app is a
// small blast radius versus every write blocking every user for that
// same class of duration; (2) flush() is called synchronously on
// graceful shutdown (SIGINT/SIGTERM) so a normal restart/deploy never
// loses anything, only an actual crash mid-window could. If that
// tradeoff isn't acceptable for a specific file, pass immediate:true.
//
// Same atomic temp-file-then-rename approach as the original safeWrite
// (still crash-safe against a half-written file on disk either way).

const fs = require("fs");
// PHASE 12 (additive, optional): if DATABASE_URL is configured, every
// successful local write below is also mirrored to Postgres in the
// background — see perf/dbPersistence.js for why this is safe (inert by
// default, never blocks, never throws back into this file).
const dbPersistence = require("./dbPersistence.js");

const DEBOUNCE_MS = 250;
// Production Hotfix — Crash Safe Write System: the debounce above resets
// on every single call, so a file under CONTINUOUS activity (a busy room
// sending gifts back-to-back, forever) could previously have its disk
// write postponed indefinitely — the in-memory data stays safe, but the
// on-disk copy (and the crash-window blast radius) could grow without
// bound. MAX_WAIT_MS is a hard ceiling: once a file has had a write
// pending for this long, it is flushed on its next debounce tick
// regardless of ongoing activity, then a fresh debounce window starts.
const MAX_WAIT_MS = 2000;

const pending = new Map(); // file -> { data, timer, firstQueuedAt }

function writeNow(file, data) {
    const tmpFile = file + ".tmp";
    try {
        // AUDIT FIX (2026-07-27, "data resets to zero"): keep a one-generation
        // rolling backup of the last known-good file BEFORE overwriting it.
        // Paired with safeRead()'s backup fallback in server.js — without
        // this, a truncated/corrupt file (crash mid-write, disk hiccup, bad
        // manual edit, or corruption predating this atomic-write setup) had
        // no fallback at all: safeRead() would silently hand back an empty
        // {} and the app would boot as if every user/room had vanished.
        if (fs.existsSync(file)) {
            try { fs.copyFileSync(file, file + ".bak"); } catch (_) { /* best-effort */ }
        }
        fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
        fs.renameSync(tmpFile, file);
        // Local write already succeeded — mirroring to Postgres from here
        // is purely a durability backstop for a future ephemeral-disk wipe
        // (Render redeploy). Fire-and-forget: no await, and any DB failure
        // is caught and logged inside dbPersistence.js, never here.
        dbPersistence.mirrorWrite(file, data);
    } catch (err) {
        console.error(`❌ Failed to write ${file}:`, err.message);
        try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
    }
}

/**
 * Queue a write of `data` to `file`. Debounced per-file: repeated calls
 * for the same file within DEBOUNCE_MS only result in one disk write
 * (the last one). Pass { immediate: true } to skip debouncing for
 * writes that must land immediately (rare — most saves in this app are
 * fine to lag by a fraction of a second since the in-memory copy is
 * already authoritative).
 */
function queueWrite(file, data, { immediate = false } = {}) {
    if (immediate) {
        const existing = pending.get(file);
        if (existing) { clearTimeout(existing.timer); pending.delete(file); }
        writeNow(file, data);
        return;
    }
    const existing = pending.get(file);
    if (existing) clearTimeout(existing.timer);
    const firstQueuedAt = existing ? existing.firstQueuedAt : Date.now();

    // If this file has already been waiting close to the max, don't push
    // it further out — flush on the next tick instead of resetting the
    // full DEBOUNCE_MS again, so continuous activity can't starve it.
    const elapsed = Date.now() - firstQueuedAt;
    const delay = elapsed + DEBOUNCE_MS >= MAX_WAIT_MS
        ? Math.max(0, MAX_WAIT_MS - elapsed)
        : DEBOUNCE_MS;

    const timer = setTimeout(() => {
        pending.delete(file);
        writeNow(file, data);
    }, delay);
    timer.unref(); // don't keep the process alive just for a pending write
    pending.set(file, { data, timer, firstQueuedAt });
}

/** Synchronously flush every pending write. Call on graceful shutdown. */
function flushAll() {
    for (const [file, { data, timer }] of pending) {
        clearTimeout(timer);
        writeNow(file, data);
    }
    pending.clear();
}

// Flush on graceful shutdown so a normal restart/deploy (not a hard
// crash) never loses a debounced write.
process.on("SIGINT", () => { flushAll(); process.exit(0); });
process.on("SIGTERM", () => { flushAll(); process.exit(0); });
process.on("beforeExit", flushAll);

module.exports = { queueWrite, flushAll, DEBOUNCE_MS };
