# PingPong — Friendship + CP + Voice Final Integration

## Implemented

### Friendship
- 100,000 Coins per request.
- Private-message notification with Yes / No acceptance.
- 10-minute request expiry by default.
- Accepted relationship is persisted in `data/friendship_cp.json`.
- Friendship is deliberately not rendered as a profile relationship banner.
- When both friends occupy seats in the same room, the supplied handshake-heart artwork is rendered between their seats as an absolute animated overlay.

### CP
- 500,000 Coins per request.
- Private-message notification with Yes / No acceptance.
- 10-minute request expiry by default.
- Accepted CP is persisted in `data/friendship_cp.json`.
- Accepted CP displays both user IDs together on the profile.
- The supplied couple-heart artwork is used as the CP visual and can render between two CP-linked seats without changing seat layout.

### Wallet safety
- Uses the existing Coins balance.
- Uses the existing transaction ledger.
- No Diamond deduction is used for Friendship/CP.
- Sender balance is updated and pushed through the existing wallet-update channel.

### Room safety
- Existing seat array remains 8 seats.
- Relationship visuals live in a separate absolute overlay layer.
- No relationship element changes seat dimensions, grid sizing, or seat click handlers.
- Relationship state is derived from authoritative seat state and refreshed on seat changes and relationship acceptance.

### Voice hardening
- Stronger explicit microphone constraints.
- Deterministic initial WebRTC offerer to reduce three-person join glare.
- Extra failed-connection recovery.
- Remote audio elements are explicitly configured for mobile playback and retried after a user gesture.
- Voice signaling now validates target user membership against the authoritative room state and routes through Socket.IO's adapter by socket ID, fixing the multi-instance failure mode where a third seated user could be visible but silent.
- Existing TURN and optional LiveKit SFU infrastructure remains intact.

## Validation

Passed:
- `node --check server.js`
- `node --check friendshipCp.js`
- `node --check public/app.js`
- Relationship request/accept/seat-link smoke test.
- HTML duplicate-ID check: no duplicates.

Not run in this build environment:
- Full `npm test`, because the supplied npm registry could not resolve `@socket.io/redis-adapter`; the archive did not contain `node_modules`.
- Live browser/WebRTC multi-device test against a real TURN/LiveKit deployment.

## Configuration

Optional environment variables:

- `FRIENDSHIP_COST_COINS=100000`
- `CP_COST_COINS=500000`
- `RELATIONSHIP_REQUEST_TTL_MS=600000`

For production voice reliability, configure a real TURN service through the existing `STUN_URL`, `TURN_URL`, `TURN_USERNAME`/`TURN_CREDENTIAL` or dynamic `TURN_SECRET`/`TURN_REALM` settings. For SFU voice, configure the existing LiveKit variables and set `VOICE_MODE=sfu` after real deployment validation.
