# PingPong Voice Final Stability Fix — 2026-08-11

## Scope
This patch targets the room voice Mesh path already present in PingPong. It is designed to keep voice stable when users:
- join/leave/rejoin rooms,
- switch between seated speaker and audience,
- reconnect after a socket/network interruption,
- listen as audience while one or more users are seated,
- use multiple independent rooms.

## Fixes applied

### 1. Server-side reconnect events were actually wired
`voice-reconnect.js` existed and the client already listened for:
- `voice-peer-reconnecting`
- `voice-peer-resumed`

but `server.js` was not calling the module's notification methods.

The disconnect handler now broadcasts the reconnecting state, and the successful grace-period rejoin path broadcasts the resumed state.

### 2. Audience reconnect recovery
`public/app.js` previously only reacted to `voice-peer-resumed` when the local user was seated.

That prevented audience listeners from rebuilding a peer when a speaker's socket ID changed after reconnect.

The handler now reconnects to the resumed speaker for both seated and audience listeners.

### 3. Seat leave -> seat return audio recovery
The old `ensureLocalTracksSent()` only checked whether an RTCRtpSender existed.

When a user left a seat, the old microphone track was stopped but the sender remained. On returning to a seat, the code could therefore see an existing sender and never attach the new microphone track.

The new implementation:
- detects ended/stale audio tracks,
- uses `RTCRtpSender.replaceTrack()` where possible,
- renegotiates the affected peer,
- rebuilds only the affected peer if reattachment fails,
- leaves healthy peer connections untouched.

This is specifically intended to fix the case:
**speaker -> leave seat -> keep listening -> take seat again -> speak normally.**

## Validation
- `node --check server.js` — passed
- `node --check public/app.js` — passed
- Full project test suite: **26/26 suites passed**

## Important infrastructure limitation
This code does not invent or embed a public TURN credential.

The project currently falls back to STUN when `TURN_URL`/credentials are absent. STUN-only cannot guarantee connectivity across every mobile carrier/NAT/firewall.

For production reliability, configure a real TURN service through the existing environment variables. The existing LiveKit/SFU implementation can be enabled later when `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are configured.

## Files changed
- `server.js`
- `public/app.js`

Everything else in the supplied project remains as provided.
