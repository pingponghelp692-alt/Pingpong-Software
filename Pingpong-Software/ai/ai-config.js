// ai/ai-config.js
// Single place every other ai/ module reads settings from. Nothing outside
// this file should ever read process.env directly for AI settings — that's
// what keeps "swap the provider later" a one-file change (see ai-service.js).
require("dotenv").config();

module.exports = {
    // Identity of the built-in support account. Reserved userId that can
    // never collide with a real mobile-number-based user account.
    AI_USER_ID: "pingpong_ai_help",
    AI_NAME: "PingPong Help",

    // Which provider file (under ai/providers/) to use. To move off Gemini
    // later: add ai/providers/<name>-provider.js exporting the same
    // `generate(messages, systemPrompt)` function, then just change this
    // env var — no other code changes needed anywhere in the app.
    AI_PROVIDER: process.env.AI_PROVIDER || "gemini",

    // AUDIT FIX (2026-08-12): cross-provider fallback. If the primary
    // provider fails (after its own retries), and a different provider is
    // named here with its own API key configured, ai-service.js will try
    // that provider once before giving up. Leave unset to disable (old
    // single-provider behavior is unchanged).
    AI_FALLBACK_PROVIDER: process.env.AI_FALLBACK_PROVIDER || "",

    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
    GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-2.0-flash",

    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o-mini",

    // Approx cost per 1M tokens (USD) — only used for the Dashboard's cost
    // estimate, not billed anywhere. Update if you switch models.
    PROVIDER_PRICING: {
        gemini: { inputPerM: Number(process.env.GEMINI_INPUT_PRICE_PER_M) || 0.075, outputPerM: Number(process.env.GEMINI_OUTPUT_PRICE_PER_M) || 0.3 },
        openai: { inputPerM: Number(process.env.OPENAI_INPUT_PRICE_PER_M) || 0.15, outputPerM: Number(process.env.OPENAI_OUTPUT_PRICE_PER_M) || 0.6 },
    },

    // How many back-and-forth turns of chat history to keep per user session
    // (in memory only — resets on server restart, matching "session-based
    // memory" from the spec, not permanent chat-log memory).
    MAX_HISTORY_TURNS: Number(process.env.AI_MAX_HISTORY_TURNS) || 12,

    // How often the monitoring engine takes a snapshot.
    MONITOR_INTERVAL_MS: Number(process.env.AI_MONITOR_INTERVAL_MS) || 30000,
};
