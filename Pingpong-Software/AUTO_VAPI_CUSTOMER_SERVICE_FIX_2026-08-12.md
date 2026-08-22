# Room 101 — Automatic Ritu Vapi Voice Fix

## Behavior
- Sitting in Room 101 automatically starts the configured Vapi Assistant.
- No Ritu popup, Start button, Mute button, or End Call button is shown.
- Leaving the seat automatically stops the Vapi call.
- Automatic start no longer depends on the asynchronous config-preload flag; the Vapi client loads/configures itself when the seat event fires.
- Automatic start retries while the user remains seated, preventing a slow mobile/tunnel response from permanently skipping the call.
- Duplicate starts are guarded by the Vapi client's `starting`/`active` state.
- Existing PingPong room voice is paused for the duration of the Vapi call and resumed when the call ends.
- Existing Vapi Public Key and Assistant ID in `.env` are preserved; no private Vapi key is exposed to the browser.
- Existing Room 101 operational `room_control` tool remains available to the Vapi Assistant.

## Important browser constraint
The first microphone use may still require the browser's normal microphone permission prompt. Website code cannot bypass Android/Chrome permission/security rules. Once permission is granted, the seat lifecycle can start/stop the Vapi call automatically.
