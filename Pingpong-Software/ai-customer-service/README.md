# FINAL — Official AI Customer Service Room 101

This feature is already integrated into the supplied PingPong project.

## Fixed identity
- Room ID: `101`
- Room Name: `AI Customer Service`
- AI Agent ID: `CS-AI-101`
- AI User ID: `pingpong_ai_help`
- Normal seats: 8
- AI seat: one dedicated virtual seat rendered above the 8 normal seats

## What was changed
1. Room 101 is created automatically at server startup if it does not exist.
2. It appears first in the public room list and is marked OFFICIAL.
3. Existing 8-seat room UI and voice topology are left intact.
4. A dedicated AI seat appears above the normal 8 seats only in Room 101.
5. Tapping the AI seat opens the Customer Service panel.
6. Text and voice input can be sent to the server AI service.
7. AI replies are returned through Socket.IO.
8. Browser speech synthesis reads the reply aloud with a consistent female-oriented voice selection when the device/browser exposes one.
9. The existing PingPong AI provider (`ai/ai-service.js`) is reused, so configure the existing AI provider/API key in `.env`.
10. Room 101 is protected against ordinary room deletion.

## Voice path
User microphone -> browser SpeechRecognition -> `cs101:message` -> PingPong AI service -> `cs101:reply` -> browser SpeechSynthesis -> device speaker.

This is intentionally additive: it does not replace the existing WebRTC room voice implementation.

## Important production note
Browser speech recognition and speech synthesis capabilities vary by Android browser. For a guaranteed cloud voice pipeline, configure a production STT/TTS provider and connect it to the documented `cs101` events. Never expose provider API keys in frontend JavaScript.

## Validation performed
- `node --check server.js` passed.
- `node --check public/app.js` passed.
- Existing `roomStateListRoomIds` test passed (6/6).
