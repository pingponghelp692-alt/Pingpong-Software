# PingPong Voice Production Hardening — 2026-08-15

## Applied fixes
- LiveKit terminal disconnect now triggers automatic bounded exponential recovery through the existing `/api/voice-sfu/join` token path.
- LiveKit `Reconnected` explicitly verifies/restores the microphone publication and re-attaches/playbacks subscribed remote audio tracks.
- SFU recovery is cancelled on intentional room teardown, preventing reconnect loops after leaving a room.
- Audience and seated recovery paths are separated: seated users rebuild microphone capture when needed; audience users reconnect without requesting the microphone.
- Seat-to-SFU publish permission convergence now retries at 0.5s/1s/2s/4s instead of a single 1.5s retry.
- Android wrapper uses the audited foreground microphone service, safer WebView permissions/origin checks, WebView crash recovery, FileProvider camera upload support, and guarded foreground-service startup.
- Android namespace/application id remains `com.pingpong.voice` so the main ROBIN project remains the canonical application base.

## Important verification boundary
Static source checks and local Node tests can be run without a live LiveKit server. A true production sign-off still requires a live LiveKit deployment plus Android device tests for Wi-Fi/mobile handoff, background/foreground, screen lock, seat changes, and temporary packet loss. No honest source-only audit can guarantee literal 100% reliability on every carrier/OEM/network.
