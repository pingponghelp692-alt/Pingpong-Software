// fruitWheelAudit.js
// Persistent, append-only audit trail for the Fruit Wheel game.
//
// Why this exists: the in-memory game engine in server.js already resolves
// every round correctly (server-authoritative result, atomic-per-tick
// payout, no client trust), but until now the only record of what happened
// in a given round was a console.log line — gone the moment the terminal
// scrolls or the process restarts. This module gives every round a
// permanent, structured record so a disputed bet/payout/winner can be
// traced after the fact, and so real per-user bet history can be served
// back to the client instead of nothing.
//
// One line per finished round (JSONL), same rotation strategy as
// ai/ai-logger.js so this can never grow unbounded on a long-running
// Termux server.
const fs = require("fs");
const path = require("path");
// Same PERSISTENT_DISK_PATH-aware resolution as server.js's own DATA_FOLDER
// (perf/dataFolder.js) — without this, the audit log would silently write
// to a non-persisted path and vanish on the next deploy/restart whenever a
// persistent disk is configured, defeating the entire point of this file.
const { resolveDataFolder } = require("./perf/dataFolder.js");

const DATA_FOLDER = resolveDataFolder(__dirname);
if (!fs.existsSync(DATA_FOLDER)) fs.mkdirSync(DATA_FOLDER, { recursive: true });
const LOG_FILE = path.join(DATA_FOLDER, "fruit_wheel_audit.jsonl");

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_LINES_KEPT = 5000;
function rotateIfNeeded() {
    try {
        const stat = fs.statSync(LOG_FILE);
        if (stat.size > MAX_BYTES) {
            const raw = fs.readFileSync(LOG_FILE, "utf8");
            const lines = raw.trim().split("\n");
            fs.writeFileSync(LOG_FILE, lines.slice(-MAX_LINES_KEPT).join("\n") + "\n");
        }
    } catch (e) { /* file doesn't exist yet — nothing to rotate */ }
}

// Records exactly one finished round. `entry` is expected to carry:
// roundId, roomId, winningFoodId, multiplier, totalBet, totalPayout,
// bets (full ledger), winners (with balanceBefore/After), rejectedBets,
// processingTimeMs. Never throws — a logging failure must never be able
// to block or corrupt an actual payout.
function logRound(entry) {
    rotateIfNeeded();
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n";
    try {
        fs.appendFileSync(LOG_FILE, line);
    } catch (e) {
        console.error("[fruitWheelAudit] write failed:", e.message);
    }
}

// Recent rounds overall (for an admin audit view), newest first.
function readRecentRounds(limit = 100) {
    try {
        const raw = fs.readFileSync(LOG_FILE, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean);
        return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
    } catch (e) {
        return [];
    }
}

// A single user's own bet/outcome history, most recent first — scans the
// bounded recent-line window (never the whole file) and pulls out just
// this user's line item from each round's ledger, so the response stays
// cheap even as the log grows.
function readUserHistory(userId, limit = 50, scanLines = 3000) {
    if (!userId) return [];
    let rounds;
    try {
        const raw = fs.readFileSync(LOG_FILE, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean).slice(-scanLines).reverse();
        rounds = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch (e) {
        return [];
    }
    const out = [];
    for (const round of rounds) {
        const myBet = (round.bets || []).find((b) => b.userId === userId);
        if (!myBet) continue;
        const myWin = (round.winners || []).find((w) => w.userId === userId);
        out.push({
            roundId: round.roundId,
            roomId: round.roomId,
            time: round.time,
            winningFoodId: round.winningFoodId,
            multiplier: round.multiplier,
            betFoods: myBet.perFood,
            betTotal: myBet.betTotal,
            winAmount: myWin ? myWin.amount : 0,
            profitLoss: (myWin ? myWin.amount : 0) - myBet.betTotal
        });
        if (out.length >= limit) break;
    }
    return out;
}

module.exports = { logRound, readRecentRounds, readUserHistory };
