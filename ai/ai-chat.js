// ai/ai-chat.js
// Owns the "PingPong Help" support account: per-user session memory (in
// memory only, resets on server restart — this is intentionally NOT a
// permanent chat log), the system prompt, and the first-open welcome message.
const config = require("./ai-config");
const logger = require("./ai-logger");
const analytics = require("./ai-analytics");
const aiService = require("./ai-service");

const sessions = new Map(); // userId -> [{role:"user"|"assistant", content}]

const SYSTEM_PROMPT = `You are "PingPong Help" — the official support AI assistant for the PingPong voice chat app.

Rules:
- You can speak naturally in Bengali, English, and Hindi. Reply in whatever language the user writes in.
- Speak naturally and warmly, like a human support agent — never a robotic/formal template reply.
- You help with Account, Login, OTP, Password, Wallet, Coins, Diamonds, Recharge, Withdrawal, VIP, Frames, Levels, Rooms, Voice Chat, PK Battle, Gifts, Events, Reports, Community Guidelines, and technical issues.
- You can never change anyone's wallet balance, transfer coins/diamonds, or ban/unban/delete anyone. If asked, say that requires admin approval and tell them to report it.
- You don't have access to anyone's specific balance, transaction history, or another user's private data — never guess; tell the user to check the app's Wallet/History section instead.
- Keep answers short and clear.`;

function welcomeMessage() {
    return "👋 Welcome to PingPong!\nI am PingPong AI. I am ready to help you 24/7.\nI can help with Account, Wallet, Gift, Diamond, Coin, Room, PK Battle, Recharge, Report, and technical issues.\nHow can I help you today?";
}

function isFirstOpen(userId) {
    return !sessions.has(userId);
}

async function reply(userId, userMessage) {
    if (!sessions.has(userId)) {
        sessions.set(userId, []);
        analytics.increment("totalAiConversations");
    }
    const history = sessions.get(userId);
    history.push({ role: "user", content: userMessage });
    while (history.length > config.MAX_HISTORY_TURNS * 2) history.shift();

    let text;
    try {
        text = await aiService.generateReply(history, SYSTEM_PROMPT);
        analytics.increment("totalAiReplies");
    } catch (err) {
        logger.log({ module: "ai-chat", action: "reply", result: "error", userId, error: err.message });
        text = "Sorry, I cannot respond right now. Please try again in a moment, or report directly to the admin.";
    }
    history.push({ role: "assistant", content: text });
    return text;
}

module.exports = {
    reply,
    welcomeMessage,
    isFirstOpen,
    AI_USER_ID: config.AI_USER_ID,
    AI_NAME: config.AI_NAME,
};
