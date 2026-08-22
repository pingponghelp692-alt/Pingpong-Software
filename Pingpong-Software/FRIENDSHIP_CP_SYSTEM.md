# PingPong Friendship + CP System

## Rules

- Friendship request: **100,000 Coins**.
- CP request: **500,000 Coins**.
- Cost is deducted from the sender when the request is sent.
- Requests expire after **10 minutes** by default. Override with `RELATIONSHIP_REQUEST_TTL_MS`.
- Override costs with `FRIENDSHIP_COST_COINS` and `CP_COST_COINS`.
- One active relationship/request is allowed per pair; Friendship and CP cannot coexist for the same pair.
- Acceptance is handled inside the existing private-message thread with **Yes / No** actions.
- Friendship has no profile relationship banner. Its visual is room-seat only when both users are seated together.
- CP is shown on the profile as a two-ID pair after acceptance.
- Seat artwork is an absolute overlay and does not change seat/grid dimensions.
- CP uses the supplied couple-heart artwork; Friendship uses the supplied handshake-heart artwork.

## Data

`data/friendship_cp.json`

- `relationships`: accepted pair relationships
- `requests`: pending/accepted/rejected/expired request records

Wallet deductions use the existing user coin balance and transaction ledger; no second currency store is introduced.

## API

- `GET /api/relationships/status/:targetUserId`
- `POST /api/relationships/request` body `{ targetUserId, type }`
- `POST /api/relationships/respond` body `{ requestId, action }`
- `GET /api/relationships/mine/:userId`

## Room behavior

The server derives `relationshipLinks` from the authoritative room seat list. When a relationship becomes active or a seat changes, `room-relationship-update` is emitted. The client renders the artwork in an absolute overlay between the two occupied seats.

## Voice hardening included in this build

- More explicit microphone constraints (AEC, NS, AGC, mono/48 kHz request).
- Deterministic initial WebRTC offerer to reduce three-way join glare.
- Remote audio elements are configured for autoplay/inline playback and retried after a user gesture.
- Additional connection-state recovery for failed peer connections.
- Cross-instance voice signaling now validates the target user against the authoritative room seat/audience state and routes through the Socket.IO adapter by socket ID instead of requiring the target socket to exist on the same Node instance.
- Existing TURN configuration remains the preferred production path; the existing LiveKit SFU path remains available for deployments with real LiveKit credentials.
