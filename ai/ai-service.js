// ai/ai-service.js
// Provider-agnostic layer. Nothing outside this file (ai-chat.js,
// ai-room-assistant.js, etc.) ever talks to Gemini/OpenAI directly — they
// all just call generateReply(messages, systemPrompt) and get text back.
const config = require("./ai-config");
const logger = require("./ai-logger");
const analytics = require("./ai-analytics");
// PRODUCTION AUDIT FIX (2026-08-10): ai-recovery.js existed (retryJob
// helper, built for exactly this purpose per its own header) but was never
// imported anywhere — a dead module. Wiring it here, at the one call site
// that talks to an external AI provider, is the safe/idempotent use its
// own comments describe: a transient Gemini/OpenAI failure (network blip,
// 503, rate-limit) gets retried a couple of times before the existing
// caller-side fallback message (ai-chat.js / ai-room-assistant.js already
// catch and show "cannot respond right now") kicks in. No change to any
// caller, no change to error shape — still rejects after retries exhausted.
const { retryJob } = require("./ai-recovery");

const providers = {
    gemini: require("./providers/gemini-provider"),
    openai: require("./providers/openai-provider"),
    // Add another provider later: create ai/providers/<name>-provider.js
    // exporting generate(messages, systemPrompt) -> {text, usage}, register
    // it here, then just set AI_PROVIDER=<name> in .env.
};

// AUDIT FIX (2026-08-12): a provider's own API key presence is what makes it
// "configured" — matches how gemini-provider.js / openai-provider.js already
// throw "<KEY> is not set" themselves, so this stays in sync automatically
// if a new provider file is added later.
function providerHasKey(name) {
    if (name === "gemini") return !!config.GEMINI_API_KEY;
    if (name === "openai") return !!config.OPENAI_API_KEY;
    return true; // unknown/custom provider — let it try and fail on its own terms
}

async function runProvider(name, messages, systemPrompt) {
    const provider = providers[name];
    if (!provider) throw new Error(`Unknown AI provider "${name}" — check ai/providers/`);
    // retryJob retries only the transient network call itself — a failed
    // attempt here never partially mutates any state (no DB write, no
    // wallet touch), so retrying is safe/idempotent.
    const result = await retryJob(() => provider.generate(messages, systemPrompt), 2);
    const text = typeof result === "string" ? result : result.text;
    const usage = (typeof result === "object" && result.usage) || { inputTokens: 0, outputTokens: 0 };
    if (!text) throw new Error(`Provider "${name}" returned an empty response`);
    return { text, usage };
}

async function generateReply(messages, systemPrompt) {
    const primary = config.AI_PROVIDER;
    if (!providers[primary]) throw new Error(`Unknown AI_PROVIDER "${primary}" — check ai/providers/`);

    const started = Date.now();
    try {
        const { text, usage } = await runProvider(primary, messages, systemPrompt);
        trackUsage(primary, usage);
        logger.log({ module: "ai-service", action: "generate", provider: primary, result: "success", durationMs: Date.now() - started, tokens: usage.inputTokens + usage.outputTokens });
        return text;
    } catch (primaryErr) {
        logger.log({ module: "ai-service", action: "generate", provider: primary, result: "error", error: primaryErr.message, durationMs: Date.now() - started });

        // Cross-provider fallback: only attempt if a different provider is
        // configured AND that provider actually has its own API key set —
        // otherwise we'd just replace one error with a less useful one.
        const fallback = config.AI_FALLBACK_PROVIDER;
        if (fallback && fallback !== primary && providers[fallback] && providerHasKey(fallback)) {
            const fbStarted = Date.now();
            try {
                const { text, usage } = await runProvider(fallback, messages, systemPrompt);
                trackUsage(fallback, usage);
                logger.log({ module: "ai-service", action: "generate", provider: fallback, result: "fallback-success", durationMs: Date.now() - fbStarted, tokens: usage.inputTokens + usage.outputTokens, primaryError: primaryErr.message });
                return text;
            } catch (fallbackErr) {
                logger.log({ module: "ai-service", action: "generate", provider: fallback, result: "fallback-error", error: fallbackErr.message, durationMs: Date.now() - fbStarted });
                // Both failed — surface the primary's error, since that's the
                // configured/expected provider; callers already show a safe
                // generic message to the customer either way.
                throw primaryErr;
            }
        }
        throw primaryErr;
    }
}

function trackUsage(providerName, usage) {
    const pricing = config.PROVIDER_PRICING[providerName] || { inputPerM: 0, outputPerM: 0 };
    const cost = (usage.inputTokens / 1e6) * pricing.inputPerM + (usage.outputTokens / 1e6) * pricing.outputPerM;
    analytics.increment("totalInputTokens", usage.inputTokens);
    analytics.increment("totalOutputTokens", usage.outputTokens);
    analytics.addCost(cost);
}

module.exports = { generateReply };
