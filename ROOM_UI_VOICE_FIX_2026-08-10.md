# Room UI + Gift + Voice Fix — 2026-08-10

## Applied

- Added the supplied Peacock/PingPong artwork as `public/images/room-default-theme.jpg`.
- Every room now falls back to that artwork when no custom room background is saved.
- Custom room backgrounds still override the default theme.
- Removed gift sends from the chat transcript and disabled the old gift banner, so gift sends are represented by the gift animation only.
- Reworked room chat into compact premium glass bubbles, anchored at the bottom so new messages move upward without a large white panel.
- Full-screen/custom gift effects now use a dark premium overlay so the chat/toolbar/background do not show through during the effect.
- Seating a user automatically enables the microphone; no second manual tap is required.
- Leaving a seat immediately stops local microphone capture and clears the mic-active state.
- Mesh voice now reconciles connections for both seated users and audience listeners, allowing audience users to continue hearing seated speakers.
- Audience users are prevented from manually enabling the microphone.
- Room-scoped WebRTC signaling now permits receive-only audience listeners in the same room; it still rejects stale sockets and cross-room signaling.
- Bumped `style.css` and `app.js` cache versions so the new client code is loaded after deployment.

## Validation performed

- `node --check public/app.js` — passed.
- `node --check server.js` — passed.

The supplied archive did not contain `node_modules`, so the full runtime/test suite was not executed inside the archive workspace. Run the project's normal `npm test` and then start the server in the target Termux environment before production use.
