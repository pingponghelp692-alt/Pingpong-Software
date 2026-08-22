// ==================================================
// PHASE 10 — INPUT VALIDATION & SANITIZATION
// ==================================================
// Small, dependency-free helpers used at the routes most exposed to
// user-supplied text that later gets stored and/or broadcast to other
// users (chat messages, profile name/bio, room name, announcements) —
// that's the actual XSS surface in this app, since the frontend renders
// some of these into the DOM. Financial/numeric fields (coins, quantities,
// amounts) get their own numeric guard so a negative/NaN/huge value can't
// slip through into a wallet operation.
//
// These are intentionally simple pure functions, not a validation
// framework — easy to drop into any existing route with one extra line,
// matching how the rest of this codebase favors small additive helpers
// over a new heavyweight dependency (see analyticsHub.js's own note).

// Strips characters that have no legitimate use in a display string
// (control chars, null bytes) and hard-caps length. Does NOT html-escape —
// use escapeHtml() too for anything rendered with innerHTML on the
// frontend; sanitizeText() alone is enough for anywhere the frontend
// already uses textContent/safe rendering.
function sanitizeText(input, maxLen = 500) {
    if (input === null || input === undefined) return "";
    let s = String(input);
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    s = s.trim();
    if (s.length > maxLen) s = s.slice(0, maxLen);
    return s;
}

function escapeHtml(input) {
    return String(input || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function isValidMobile(mobile) {
    return typeof mobile === "string" && /^\d{10}$/.test(mobile);
}

// Bounded finite positive integer/number check for anything touching the
// wallet (coins, diamonds, quantities). `max` guards against a client
// sending e.g. 1e300 to try to overflow/abuse downstream math.
function isValidAmount(value, { min = 0, max = 10_000_000, allowFloat = false } = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    if (!allowFloat && !Number.isInteger(n)) return false;
    return n >= min && n <= max;
}

// Path-traversal-safe filename for anything derived from a user-supplied
// original filename (multer's `file.originalname` is attacker-controlled —
// e.g. "../../server.js" or "con" on Windows hosts). Keeps only a safe
// character set and a bounded length; the timestamp prefix already added
// by every multer `filename` callback in server.js still makes it unique.
function safeFilename(originalname) {
    const name = String(originalname || "file");
    const base = path_basename(name); // strip any directory component
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
    return cleaned || "file";
}
// Tiny inline basename (avoids requiring 'path' just for this) — also
// defends against backslash-style traversal that path.basename on a POSIX
// host would NOT strip (Node's path.basename only splits on '/' unless the
// win32 variant is used explicitly).
function path_basename(p) {
    return p.split(/[\\/]/).pop();
}

// MODULE 5.2 — safe key check for route :params/query values used as a
// direct bracket-notation lookup into a plain in-memory object store
// (e.g. `rooms[req.params.roomId]`, `groupsStore[req.params.groupId]`).
// A plain `{}` object still inherits from Object.prototype, so a request
// with roomId/groupId literally set to "__proto__" (or "constructor" /
// "prototype") makes `store[key]` resolve to a real, truthy object
// (Object.prototype / Object itself) instead of undefined — bypassing the
// route's usual `if (!found) return "not found"` guard and letting a
// malformed/unexpected object flow into the rest of the handler. This
// never allowed writing to the prototype in this codebase (no route does
// `store[req.params.x] = ...`), so it was not an exploitable prototype-
// pollution write — but it is a real, easy-to-trigger format-validation
// gap that produces incorrect behavior (and, on any route that doesn't
// happen to re-check every field, a possible unhandled exception since
// Object.prototype has none of the expected fields). Reject a small
// denylist of dangerous property names plus enforce a sane length/type,
// same spirit as isValidMobile()/isValidAmount() above.
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function isSafeObjectKey(key) {
    return typeof key === "string" && key.length > 0 && key.length <= 128 && !UNSAFE_OBJECT_KEYS.has(key);
}

module.exports = { sanitizeText, escapeHtml, isValidMobile, isValidAmount, safeFilename, isSafeObjectKey };
