# PingPong Final Club + 3 Ranking Integration

Integrated features:

- CP Ranking: `/api/rankings/cp?period=daily|weekly|monthly`
- Room Ranking: `/api/rankings/rooms?period=daily|weekly|monthly`
- Room detail ranking: `/api/rankings/rooms/:roomId`
- Top Gifters: `/api/rankings/gifters?period=daily|weekly|monthly`
- Club home: `/club/`
- Club API: `/api/clubs/*`
- Club ranking: `/api/clubs/ranking`

## Production data flow

Confirmed gift -> existing `recordGiftHistory()` -> persistent `gift_history.json` -> ranking aggregation and club contribution hook.

The ranking services do not deduct coins/diamonds and do not invent users or rooms. Club EXP is derived from confirmed gift diamond value for a member's current club and is deduplicated by the same persistent gift transaction ID.

Club state is persisted in:

- `data/clubs.json`
- `data/club_members.json`
- `data/club_invites.json`
- `data/club_contributions.json`

Existing authentication is required for all club/ranking APIs. Client-supplied user IDs are not used as identity. Wallet and gift sending remain owned by the existing PingPong gift/wallet implementation.

## UI entry points

Home -> Popular -> Club opens `/club/`.
Home -> Popular -> Ranking opens `/rankings/rooms.html`.
Home -> Popular -> CP opens `/rankings/cp.html`.

All ranking pages render only API data and show loading/empty/error/retry states.
