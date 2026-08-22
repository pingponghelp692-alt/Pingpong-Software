// ai/ai-monitor.js
// Real, lightweight monitoring — no external dependencies. Measures actual
// Node.js process memory, OS load average, and event-loop lag (the standard
// proxy for "is the server struggling to keep up"). Feeds the AI Dashboard.
//
// NOTE ON SCOPE: things like "CPU %", "Storage", "Database" health in the
// original spec normally come from OS/hosting-level metrics (disk usage,
// DB connection pool, etc.) which depend on your specific hosting setup —
// this module exposes a `getStats` hook (wired in server.js) so you can feed
// it real numbers for rooms/users/sockets. True infrastructure metrics
// (disk, external DB server) would need your hosting provider's own
// monitoring API — that's outside what a single Node process can see.
const os = require("os");
const logger = require("./ai-logger");
const config = require("./ai-config");

const history = [];
const MAX_HISTORY = 200;
let currentStatus = "healthy";
let lastAlertStatus = null;

function eventLoopLag() {
    return new Promise((resolve) => {
        const start = Date.now();
        setImmediate(() => resolve(Date.now() - start));
    });
}

async function snapshot(getStats) {
    const mem = process.memoryUsage();
    const load = os.loadavg()[0];
    const lag = await eventLoopLag();
    const extra = typeof getStats === "function" ? getStats() : {};

    let status = "healthy";
    if (lag > 500 || mem.heapUsed / mem.heapTotal > 0.92) status = "critical";
    else if (lag > 150 || mem.heapUsed / mem.heapTotal > 0.8) status = "warning";

    const snap = {
        time: new Date().toISOString(),
        status,
        memoryMB: Math.round(mem.heapUsed / 1024 / 1024),
        memoryTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        loadAvg: Number(load.toFixed(2)),
        eventLoopLagMs: lag,
        uptimeSec: Math.round(process.uptime()),
        ...extra,
    };

    history.push(snap);
    if (history.length > MAX_HISTORY) history.shift();
    currentStatus = status;
    if (status !== "healthy" && status !== lastAlertStatus) {
        logger.log({ module: "ai-monitor", action: "health-alert", result: status, snapshot: snap });
    }
    lastAlertStatus = status;
    return snap;
}

function start(getStats) {
    setInterval(() => { snapshot(getStats).catch((e) => logger.log({ module: "ai-monitor", action: "snapshot", result: "error", error: e.message })); }, config.MONITOR_INTERVAL_MS);
    // Take one immediately on boot so the dashboard isn't empty on first load.
    snapshot(getStats).catch(() => {});
}

function getHistory() { return history; }
function getStatus() { return currentStatus; }

module.exports = { start, snapshot, getHistory, getStatus };
