# PingPong Final Production Patch — 2026-08-11

## Applied fixes

- Room mesh voice now includes audience listeners and links only audience↔speaker / speaker↔speaker paths; audience clients remain receive-only.
- Seat changes use one centralized mesh reconciliation path, preserving healthy peers and avoiding unnecessary renegotiation.
- Private thread opening now scrolls after the hidden view becomes laid out, fixing the first-message-below-fold issue.
- Room chat transcript and bubbles no longer use backdrop blur, preventing message rendering from visually destroying the room theme background.
- Fruit Wheel now carries an authoritative per-room `roundId` through round, winners, join-resync, and per-user result events.
- Food Wheel iframe rejects stale round/winner/result events so an older winning result cannot overwrite the next round.
- Private call SDP/ICE relay now targets the exact accepted socket ID with `io.to(socketId)`, making signaling work across Socket.IO Redis-adapter Node instances.
- Live room profile style updates now propagate custom tag, name effect, active frame, VIP level, and active badges to occupied seats immediately.
- LiveKit client CDN pin updated to the current documented v2.21.0 client SDK used by this patch.
- LiveKit audio playback unlock is wired to a real user gesture for mobile autoplay restrictions.
- Production `.env.example`, production checklist, and CI workflow were completed so the repository's own preflight/readiness checks pass.

## Verification

- `npm test` — 26/26 suites passed.
- `npm run preflight` — passed; 154 JavaScript files syntax-clean.
- `npm run readiness` — passed; deployment/core assets present and JavaScript syntax-clean.
- `node --check` passed for the modified browser/server modules.

## Required live deployment values

Set these in the real production environment:

- `VOICE_MODE=sfu`
- `LIVEKIT_URL=wss://...`
- `LIVEKIT_API_KEY=...`
- `LIVEKIT_API_SECRET=...`
- TURN credentials for the private WebRTC calling path
- HTTPS for the web application

The external LiveKit/TURN network itself was not available in this build environment, so no responsible engineer can certify arbitrary real-device/mobile-network behavior as literally 100% guaranteed from this offline patch alone. The code and automated regression suite are prepared for the live verification step.
