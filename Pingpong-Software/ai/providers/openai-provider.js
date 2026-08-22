// ai/providers/openai-provider.js
// Same contract as gemini-provider.js: generate(messages, systemPrompt) ->
// { text, usage }. Swapping AI_PROVIDER=openai in .env is enough to use
// this — nothing else in the app needs to change.
const config = require("../ai-config");

async function generate(messages, systemPrompt) {
    if (!config.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not set in the backend .env file");
    }

    const chatMessages = [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    ];

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: config.OPENAI_MODEL,
            messages: chatMessages,
            temperature: 0.7,
            max_tokens: 500,
        }),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`OpenAI API error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("OpenAI returned an empty response");

    const usage = data.usage || {};
    return {
        text,
        usage: {
            inputTokens: usage.prompt_tokens || 0,
            outputTokens: usage.completion_tokens || 0,
        },
    };
}

module.exports = { generate };
