// ai/providers/gemini-provider.js
// The ONLY file in this project that knows Gemini's specific request/response
// shape. ai-service.js talks to every provider through the same
// generate(messages, systemPrompt) function, so swapping providers later
// means adding a new file here (e.g. openai-provider.js) and changing
// AI_PROVIDER in .env — nothing else in the app has to change.
const config = require("../ai-config");

async function generate(messages, systemPrompt) {
    if (!config.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set in the backend .env file");
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.GEMINI_MODEL}:generateContent?key=${config.GEMINI_API_KEY}`;

    const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
    }));

    const body = {
        contents,
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
    };

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content
        && data.candidates[0].content.parts && data.candidates[0].content.parts[0]
        && data.candidates[0].content.parts[0].text;

    if (!text) throw new Error("Gemini returned an empty response");

    const usage = (data && data.usageMetadata) || {};
    return {
        text,
        usage: {
            inputTokens: usage.promptTokenCount || 0,
            outputTokens: usage.candidatesTokenCount || 0,
        },
    };
}

module.exports = { generate };
