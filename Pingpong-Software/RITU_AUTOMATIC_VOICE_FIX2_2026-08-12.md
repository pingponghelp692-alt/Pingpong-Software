# Ritu Automatic Customer Service Voice — Fix 2 (2026-08-12)

## Root cause addressed
The automatic seat trigger was present, but the Vapi `start()` call was being given a large client-side assistant override containing a custom tool definition. If that override is rejected by the installed Vapi Web SDK / assistant configuration, `start()` fails before the call is established. That failure is only visible in the browser console, so the Node server log can show a normal `join-room` while Ritu remains silent.

## Changes
- Automatic Customer Service seat detection remains hands-free.
- Vapi starts with the configured Public Key + Assistant ID and only safe `variableValues`.
- Removed the potentially invalid client-side tool override from the initial voice-start path.
- Added explicit browser console diagnostics for Vapi config and start request.
- Extended the script-load retry window from 5 seconds to 15 seconds.
- Seat leave now stops both active and still-connecting Vapi calls.
- Existing atomic seat-move voice behavior remains intact.
- Popup/mute/end controls remain hidden.
- Cache-busted app.js and vapi-support.js so mobile browsers do not reuse the previous build.

## Important
The Vapi Assistant ID and Public Key still come from the existing `.env`; no private Vapi key is required by the browser.
