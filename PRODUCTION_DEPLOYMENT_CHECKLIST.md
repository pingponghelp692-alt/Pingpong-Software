# PingPong Production Deployment Checklist

## Voice
1. Set `VOICE_MODE=sfu`.
2. Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`.
3. Install the optional `livekit-server-sdk` dependency in the production lockfile/deployment.
4. Set TURN credentials for private 1:1 calls.
5. Serve the web app over HTTPS. Browser microphone/camera APIs require a secure context on real phones.
6. Run `npm run preflight` and `npm run readiness`.
7. Test: 3 seated users, 2 seated + 2 audience, seat move, seat leave/rejoin, Wi-Fi↔mobile transition, and reconnect.

## Private calls
1. Verify both users are authenticated.
2. Test audio call and video call from the private thread.
3. Test caller cancel, callee reject, accept, hang up, missed call, and reconnect.
4. Test calls when Node runs behind the Redis adapter / multiple instances.

## Fruit Wheel
1. Confirm every round carries a monotonically increasing `roundId`.
2. Confirm the iframe ignores stale round/winner/result packets.
3. Verify payout ledger and wallet balance against the server audit log.

## Room UI
1. Confirm room background remains visible while messages arrive.
2. Confirm chat does not create a full-width blurred rectangle.
3. Verify safe-area bottom padding on Android devices.

## Admin styling
1. Assign/remove Custom Tag and verify color live on every occupied seat.
2. Assign/remove Name Effect and verify the exact selected style live.
3. Verify frame, VIP, badge, and level theme changes after a room-state refresh.

## Important
No software can honestly guarantee 100% availability across arbitrary mobile networks. Production readiness requires one real-device test against the configured LiveKit/TURN infrastructure before declaring the deployment live.
