// ai/ai-moderator.js
// Structural spam/abuse heuristics — repeated characters, link floods,
// duplicate messages, and (new) a simple scam/fake-link pattern check.
// Intentionally does NOT ship a profanity/slur word-list (that's a
// moderation-policy decision for you to own and curate, and hardcoding one
// here would be guesswork).
//
// evaluate() also tracks a per-room-per-user flag count with a rolling
// window and returns an escalating `action` so server.js can act on it
// automatically: 1st flag -> warn, 2nd within the window -> mute, 3rd -> kick.
// This only ever touches room-local state (mute/kick) that already exists
// in server.js — it never touches wallet/coins/bans at the account level.
const logger = require("./ai-logger");
const analytics = require("./ai-analytics");

const lastMessageByUser = new Map(); // userId -> last message text
const flagHistory = new Map(); // "roomId:userId" -> [timestamps]

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const WARN_THRESHOLD = 1;
const MUTE_THRESHOLD = 2;
const KICK_THRESHOLD = 4;
const MUTE_MINUTES = 5;

// Very common scam-message shapes (not a full list — a pattern check, same
// spirit as the link/repeat checks below). Extend as you see real abuse.
const SCAM_PATTERNS = [
    /\bfree\s+(diamond|coins?|recharge)\b/i,
    /\bwin\s+free\b.*\b(diamond|coins?)\b/i,
    /\bwhatsapp\s*[:\-]?\s*\+?\d{7,}/i,
    /\bclick\s+(this|here)\b.*https?:\/\//i,
    /\b(send|transfer)\s+(otp|password|pin)\b/i,
];

function evaluate(userId, message) {
    const flags = [];
    const trimmed = (message || "").trim();

    if (/(.)\1{9,}/.test(trimmed)) flags.push("repeated-characters");
    const linkCount = (trimmed.match(/https?:\/\//g) || []).length;
    if (linkCount >= 3) flags.push("excessive-links");
    if (SCAM_PATTERNS.some((re) => re.test(trimmed))) flags.push("possible-scam");

    const prev = lastMessageByUser.get(userId);
    if (prev && prev === trimmed && trimmed.length > 5) flags.push("duplicate-message");
    lastMessageByUser.set(userId, trimmed);

    if (flags.length) {
        analytics.increment("totalModerationFlags");
        logger.log({ module: "ai-moderator", action: "flag", result: flags.join(","), userId, message: trimmed.slice(0, 200) });
    }
    return flags;
}

// Call only when evaluate() above returned at least one flag. Tracks
// escalation per room+user and returns what server.js should do.
function escalate(roomId, userId, flags) {
    if (!flags.length) return { action: null, count: 0 };
    const key = `${roomId}:${userId}`;
    const now = Date.now();
    const history = (flagHistory.get(key) || []).filter((t) => now - t < WINDOW_MS);
    history.push(now);
    flagHistory.set(key, history);
    const count = history.length;

    let action = null;
    if (count >= KICK_THRESHOLD) action = "kick";
    else if (count >= MUTE_THRESHOLD) action = "mute";
    else if (count >= WARN_THRESHOLD) action = "warn";

    if (action) {
        analytics.increment(action === "warn" ? "totalAutoWarnings" : action === "mute" ? "totalAutoMutes" : "totalAutoKicks");
        logger.log({ module: "ai-moderator", action: "auto-" + action, roomId, userId, flagCount: count, flags: flags.join(",") });
    }
    return { action, count, muteMinutes: MUTE_MINUTES };
}

function clearUser(roomId, userId) {
    flagHistory.delete(`${roomId}:${userId}`);
}

module.exports = { evaluate, escalate, clearUser, MUTE_MINUTES };
