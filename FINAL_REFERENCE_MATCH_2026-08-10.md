# PingPong — Final Reference Match UI Patch — 2026-08-10

Applied to `public/` without changing backend gift/socket APIs.

## Included
- Supplied peacock + gold PING PONG artwork is now the default room background at `public/images/room-default-theme.jpg`.
- Default room artwork covers the full room with no tiling and no white transcript block.
- Room top bar and bottom toolbar use dark transparent premium glass instead of the washed-out white treatment.
- Seat bubbles are transparent/glass, stable, and readable over the artwork.
- Chat transcript is transparent; only individual message bubbles have a premium surface.
- Gift modal keeps the existing Normal/VIP/Legend/Custom catalog and target-selection logic.
- Gift selection is separated from sending: select a gift, then press the real `Send Gift` button.
- Bottom gift controls are a single premium row: `Recharge | x1 x7 x77 x777 | Send`.
- Existing quantity, target, wallet, socket and custom video-gift flows remain wired to the original functions.

## Verification
- `node --check public/app.js` passed.
- `node --check server.js` passed.
- No `.env` file is included in the delivery archive.
