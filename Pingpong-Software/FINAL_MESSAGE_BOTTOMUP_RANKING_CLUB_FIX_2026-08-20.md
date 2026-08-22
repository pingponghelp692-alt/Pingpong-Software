# PingPong Final Message + Ranking/Club Stability Fix — 2026-08-20

## Room message path
- Room chat is bottom-anchored.
- New messages enter from the bottom and older messages stack upward.
- The room message bubble contains only the message text.
- Sender name, custom tag and other metadata are not rendered in the room message bubble.

## Gift activity path
- Gift activity uses the same bottom-up room activity feed.
- The activity item shows only the gift icon and gift name/quantity.
- Sender/receiver names and diamond values are omitted from the gift activity item.
- Existing gift crediting, wallet logic, gift-flight animation and server history are untouched.

## Private inbox
- Private thread bubbles remain incoming/outgoing bubbles.
- The thread is bottom-anchored so the first/only message is visible immediately at the bottom.
- New messages continue to appear at the bottom while older messages remain above.
- Existing message history, calls and server persistence are untouched.

## Club/ranking stability
- Ranking pages never clear `pp_auth_token` and never force a logout when a ranking API returns 401.
- Ranking pages show a retry state instead of destroying the PingPong session.
- Ranking page back navigation returns deterministically to `/` instead of restoring a stale WebView document.
- Server-side authenticated ranking/club APIs and ranking data rules remain authoritative and are not weakened.

## Validation
- Node syntax checks and the existing ranking/club tests should be run after packaging.
