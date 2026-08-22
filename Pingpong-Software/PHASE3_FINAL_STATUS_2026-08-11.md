# PHASE 3 — Voice/WebRTC/LiveKit — Final Status (2026-08-11)

## Environment limitation (unchanged from earlier reports, repeated for visibility)
This sandbox has no network egress (`npm install` → 403 from the npm
registry) and cannot reach a real LiveKit server or run `./gradlew`.
Everything below is a **static, read-the-actual-code audit + source-level
patch**, not a live/device test. **A static audit pass is not a
production test pass.** Before shipping, you must run the real
verification steps in "REQUIRED — you must run these" below, on your own
Termux/device/LiveKit environment.

## Bugs found and fixed this session (all four, source-verified)

| # | File(s) | Bug | Fix |
|---|---|---|---|
| 1 | `public/app.js` | Seated speaker's LiveKit connection never recovers after a terminal disconnect (token TTL expiry being the likely real trigger) — silent, permanent SFU silence for the rest of the session | Symmetric self-heal added to the `room-state` handler, mirroring the existing (already-correct) audience self-heal |
| 2 | `public/app.js` | Mic track can be ended by the OS during long backgrounding; `localStream` stays truthy but dead, so neither bug-#1's fix nor the mesh path notices | `visibilitychange` handler now checks `track.readyState`, re-acquires + reconnects if the track actually died |
| 3 | *(audited, no bug)* | TURN-only/restrictive-NAT — verified `iceTransportPolicy` default + `turn-config.js` wiring is already correct for mesh; SFU correctly delegates to LiveKit's own TURN by design | No code change needed |
| 4 | `android/app/src/main/AndroidManifest.xml`, new `VoiceForegroundService.kt`, `MainActivity.kt`, `public/app.js`, `strings.xml` | **No foreground service existed anywhere in the Android project** — confirmed by reading both existing Kotlin files in full. Android's Doze/App-Standby throttling on a backgrounded, non-foreground process silently kills the WebView's JS (Socket.IO + LiveKit + mic) | Added `VoiceForegroundService` (started/stopped via a new `AndroidVoiceBridge` JS interface, called from `joinRoom()`/`rejoinRoom()`/`teardownVoice()` — active only while genuinely in a room), `FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_MICROPHONE` permissions, service manifest entry, notification strings |

## What was verified as already correct (read in full, left untouched)
- Mesh WebRTC signaling, glare handling, reconnect/grace-period logic
  (`server.js`, `voice-reconnect.js`, `room-recovery.js`) — mature,
  correct, no changes needed.
- `voice_sfu/sync.js`'s seat↔LiveKit permission mirroring — all four
  claimed call sites (`take-seat`, `leave-seat`, `mod-move-seat`,
  `mod-move-to-audience`) confirmed wired correctly by direct
  cross-reference against `server.js`.
- `voice_sfu/token.js`, `voice_sfu/livekit.js` — correctly scoped, lazy,
  fail-safe.
- `turn-config.js` — dynamic + static TURN credentialing correctly wired
  into the mesh `RTCPeerConnection`.

## STATUS (per your requested format)

```
BUILD STATUS:       NOT VERIFIED — REQUIRES REAL SERVER TEST (no network egress in this sandbox; npm install returns 403)
TEST STATUS:        NOT VERIFIED — REQUIRES REAL SERVER TEST (npm test could not run here)
SECURITY STATUS:    NOT ASSESSED THIS PASS (Phase 3 scope was voice/WebRTC only, not Phase 11's security audit)
ANDROID APK:        NOT VERIFIED — REQUIRES REAL DEVICE/BUILD TEST (./gradlew could not run here; new Kotlin file added, not compiled)
ANDROID AAB:        NOT VERIFIED — REQUIRES REAL DEVICE/BUILD TEST
VOICE (mesh):       Unchanged this session — was already verified sound in the earlier VOICE_SCALING_AUDIT.md pass; not re-tested live here
VOICE (SFU):        Bug #1 fixed (source-verified) — NOT VERIFIED live against a real LiveKit server
PRIVATE CALL:       NOT AUDITED this pass (Phase 4, out of scope this session)
PRIVATE CHAT:       NOT AUDITED this pass (Phase 5, out of scope this session)
FRUIT WHEEL:        NOT AUDITED this pass (Phase 7, out of scope this session)
ADMIN:              NOT AUDITED this pass (Phase 8, out of scope this session)
AUTH:                NOT AUDITED this pass (Phase 10, out of scope this session)
PERFORMANCE:        NOT AUDITED this pass (Phase 12, out of scope this session)
```

`node --check public/app.js` passes after every edit this session
(re-confirmed after the final edit below). This confirms JS **syntax**
validity only — not runtime correctness against a live server.

## REQUIRED — you must run these before treating Phase 3 as done

1. **`npm test`** (in `pingpong_final_work/`) — confirm the existing
   172-assertion suite still passes unchanged (nothing this session
   touched server-side logic, only `public/app.js` and the Android
   client, so this should be a clean pass, but it must actually be run).
2. **`node --check public/app.js`** — already re-confirmed here, but
   re-run after pulling this zip onto your own machine as a sanity check.
3. **Android build:**
   ```
   cd android
   ./gradlew assembleDebug
   ```
   This is the first real compile of `VoiceForegroundService.kt` and the
   `MainActivity.kt`/manifest changes — I could not run Gradle in this
   sandbox (no network egress), so **treat this as unverified new code
   until it actually compiles on your machine.**
4. **Real LiveKit reconnect test (bug #1):** set
   `LIVEKIT_TOKEN_TTL_SECONDS=30` temporarily, sit in a room as a seated
   speaker past 30s, confirm the next `room-state` broadcast reconnects
   you without a manual leave/rejoin.
5. **Real backgrounding test (bugs #2 + #4):** on a real Android device
   with the new APK installed — join a room as a seated speaker,
   background the app for several minutes (screen off or switch apps),
   foreground it again, confirm: (a) the persistent "PingPong voice room
   active" notification stayed visible the whole time, (b) audio is still
   flowing both directions afterward. Repeat on iOS Safari in a browser
   tab for bug #2 specifically (no foreground-service equivalent exists
   on iOS — that fix only covers the "track actually ended" recovery
   path, not process-level backgrounding, which iOS handles differently
   from Android and was not in this session's Android-focused scope).

## Not yet covered (deferred, your instruction: no new features beyond this scope)
3+ simultaneous SFU speakers stress test, TURN-only network simulation,
private call/call-hosting (Phase 4), Fruit Wheel (Phase 7) — none of
these were touched or claimed fixed this session.
