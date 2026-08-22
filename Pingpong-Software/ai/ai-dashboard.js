// ai/ai-dashboard.js
// Exports a function that takes the existing requireAdmin middleware (from
// server.js) and returns an Express router — kept REST-only/poll-based to
// match how the rest of the admin panel already works (no socket.io there).
const express = require("express");
const monitor = require("./ai-monitor");
const logger = require("./ai-logger");
const analytics = require("./ai-analytics");
const config = require("./ai-config");

module.exports = function buildAiDashboardRouter(requireAdmin, requirePermission) {
    const router = express.Router();
    // Backward-compatible: if server.js hasn't been updated to pass
    // requirePermission yet, fall back to a no-op so this router still
    // mounts (matches the rest of the codebase's "don't break old callers"
    // pattern). server.js now passes it (see app.use("/api/admin/ai", ...)).
    const gate = typeof requirePermission === "function" ? requirePermission("ai-core:view") : (req, res, next) => next();

    router.get("/status", requireAdmin, gate, (req, res) => {
        const isOpenAi = config.AI_PROVIDER === "openai";
        res.json({
            success: true,
            status: monitor.getStatus(),
            provider: config.AI_PROVIDER,
            model: isOpenAi ? config.OPENAI_MODEL : config.GEMINI_MODEL,
            apiKeyConfigured: isOpenAi ? !!config.OPENAI_API_KEY : !!config.GEMINI_API_KEY,
        });
    });

    router.get("/monitor/history", requireAdmin, gate, (req, res) => {
        res.json({ success: true, history: monitor.getHistory() });
    });

    router.get("/logs", requireAdmin, gate, (req, res) => {
        const limit = Math.min(500, Number(req.query.limit) || 100);
        res.json({ success: true, logs: logger.readRecent(limit) });
    });

    router.get("/analytics", requireAdmin, gate, (req, res) => {
        res.json({ success: true, stats: analytics.getStats() });
    });

    return router;
};
