// ai/ai-room-assistant.js
// The AI's presence *inside* voice rooms (separate from ai-chat.js, which
// only owns the private "PingPong Help" inbox). Two jobs:
//   1) welcomeMessage() — greet a user the first time they join a room.
//   2) reply() — answer when someone @-mentions the AI in room chat.
// server.js owns the actual socket emit; this module just decides *what*
// to say and *whether* to say anything, same pattern as ai-chat.js.
const config = require("./ai-config");
const logger = require("./ai-logger");
const aiService = require("./ai-service");

const AI_BOT_ID = "pingpong_ai_room";
const AI_BOT_NAME = "PingPong AI";

// Keep a little memory per room+user so a back-and-forth with the bot in a
// room feels continuous, same idea as ai-chat.js's per-user sessions but
// scoped per room (a user might be a totally different context in Room A
// vs Room B).
const roomSessions = new Map(); // "roomId:userId" -> [{role, content}]
const welcomedInRoom = new Set(); // "roomId:userId" — welcomed once per join

const TRIGGER_REGEX = /(^|\s)@ai\b|(^|\s)ai[,:]\s|^ai\s|^\/ai\b|^\/help\b/i;

function shouldRespond(message) {
    return TRIGGER_REGEX.test((message || "").trim());
}

function stripTrigger(message) {
    return (message || "").replace(TRIGGER_REGEX, " ").trim();
}

function welcomeMessage(roomName, userName) {
    return `👋 Welcome ${userName ? userName : "friend"}, to "${roomName}"!\nI am ${AI_BOT_NAME}, this room's assistant. If you have any question, just type "@AI" to ask — I am always here to help.`;
}

function markWelcomed(roomId, userId) {
    welcomedInRoom.add(`${roomId}:${userId}`);
}

function needsWelcome(roomId, userId) {
    return !welcomedInRoom.has(`${roomId}:${userId}`);
}

function clearRoom(roomId) {
    for (const key of welcomedInRoom) if (key.startsWith(`${roomId}:`)) welcomedInRoom.delete(key);
    for (const key of roomSessions.keys()) if (key.startsWith(`${roomId}:`)) roomSessions.delete(key);
}

async function reply(roomId, roomName, hostName, userId, userName, rawMessage) {
    const key = `${roomId}:${userId}`;
    if (!roomSessions.has(key)) roomSessions.set(key, []);
    const history = roomSessions.get(key);

    const message = stripTrigger(rawMessage) || rawMessage;
    history.push({ role: "user", content: message });
    while (history.length > config.MAX_HISTORY_TURNS * 2) history.shift();

    const systemPrompt = `You are "${AI_BOT_NAME}" — the Room Assistant for the Voice Room "${roomName}" (Host: ${hostName || "N/A"}) on the PingPong voice chat app.
Rules:
- Reply in whatever language the user writes in (Bengali/English/Hindi/etc).
- Keep replies short and friendly, matching the room chat vibe (1-3 sentences, not a long essay).
- You can help with room rules, seats, gifts, music, games, and how to reach the Admin/Host.
- You cannot kick/mute/ban anyone yourself, and cannot change anyone's coins/gifts — tell them to ask the Host/Admin for that.
- Even without an Admin present, you are always here to help.`;

    try {
        const text = await aiService.generateReply(history, systemPrompt);
        history.push({ role: "assistant", content: text });
        return text;
    } catch (err) {
        logger.log({ module: "ai-room-assistant", action: "reply", result: "error", roomId, userId, error: err.message });
        return "Sorry, I cannot respond right now. Please try again in a moment.";
    }
}

module.exports = {
    AI_BOT_ID,
    AI_BOT_NAME,
    shouldRespond,
    welcomeMessage,
    needsWelcome,
    markWelcomed,
    clearRoom,
    reply,
};
