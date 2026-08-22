# Room 101 — Automatic Ritu Voice + AI Room Admin + Chat Fix

## Implemented
- Removed the visible Ritu support popup and support controls from the production Room 101 UI.
- Sitting in a Room 101 customer seat automatically starts the configured Vapi Assistant.
- Leaving the seat automatically stops the Vapi call and releases the AI microphone.
- Removed the browser SpeechRecognition/SpeechSynthesis fallback from the customer-service voice path; Vapi is the real voice path.
- Preserved existing `.env` values. No API key replacement or new key is required by this patch.
- Added a Vapi Web SDK client-side `room_control` tool for Room 101 operational controls.
- Added server-side Room 101 AI admin command handling for:
  - open/unlock/lock seat
  - move seated customer to another seat
  - move customer to audience
  - mute/unmute customer
  - remove customer from Room 101
  - clear Room 101 chat
- Room 101 AI cannot close the room, modify wallet/money/login/password/account deletion, assign permanent admins, or perform account-level bans.
- Seat move now uses one atomic `seat-update: move` event rather than leave + join, preserving the existing voice transport.
- Room chat is bottom-anchored, sender-separated (own messages right, other messages left), keeps each user's tag attached to that message, animates new messages upward, and visually expires each message after 60 seconds. Server history is not deleted by this visual TTL.

## Validation
- `node --check server.js` passed.
- `node --check public/app.js` passed.
- `node --check public/vapi-support.js` passed.
- Existing `.env` entries for Vapi, LiveKit, Gemini and Firebase were present and non-empty (values not printed).

## Important deployment note
The Vapi public key and assistant ID already present in `.env` are preserved. The Room 101 voice-control tool is implemented as a Web SDK client-side tool, so this patch does not require adding a Vapi private API key just to execute room-local UI/socket actions. Vapi's official Web SDK supports client-side tool calls and emits `tool-calls` events to the browser.
