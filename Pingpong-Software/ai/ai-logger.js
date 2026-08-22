// ai/ai-logger.js
// Every AI action gets one line here: timestamp, which module, what it did,
// and the result. This is what powers the "Recent Logs" panel on the AI
// Dashboard admin page and is the audit trail the spec asks for.
const fs = require("fs");
const path = require("path");

const DATA_FOLDER = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_FOLDER)) fs.mkdirSync(DATA_FOLDER, { recursive: true });
const LOG_FILE = path.join(DATA_FOLDER, "ai_logs.jsonl");

// Simple size-based rotation so this file can't grow forever on a long-running server.
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
function rotateIfNeeded() {
    try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size > MAX_BYTES) {
            const raw = fs.readFileSync(LOG_FILE, "utf8");
            const lines = raw.trim().split("\n");
            fs.writeFileSync(LOG_FILE, lines.slice(-2000).join("\n") + "\n");
        }
    } catch (e) { /* file doesn't exist yet — nothing to rotate */ }
}

function log(entry) {
    rotateIfNeeded();
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n";
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) { console.error("[ai-logger] write failed:", e.message); }
}

function readRecent(limit = 100) {
    try {
        const raw = fs.readFileSync(LOG_FILE, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean);
        return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch (e) {
        return [];
    }
}

module.exports = { log, readRecent };
