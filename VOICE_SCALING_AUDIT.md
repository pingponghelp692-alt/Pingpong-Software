# VOICE_SCALING_AUDIT.md
## PingPong — Phase 3, Step 3.1: Voice Scaling Assessment

**Scope of this document:** audit only, as instructed. No code was
changed to produce this — every claim below was verified by reading the
actual files (`server.js`, `callSignaling.js`, `voice-health.js`,
`voice-reconnect.js`, `room-recovery.js`, `turn-config.js`,
`public/app.js`) and, where relevant, running real checks (grep/counts)
rather than assuming. No compatibility bug was found, so nothing was
modified.

---

## 1. Current Architecture — What's Actually There

There are **three separate WebRTC surfaces** in this codebase, all
peer-to-peer, all signaling-only on the server:

| Surface | File(s) | Topology | Media |
|---|---|---|---|
| **Room voice** (seated speakers in a room) | `server.js` (events `voice-offer`/`voice-answer`/`voice-candidate`/`voice-activity`), `public/app.js` (`peerConnections`, `connectToPeer`, `getOrCreatePeer`) | **Full mesh**, capped at 8 seats/room | Audio only |
| **Private inbox calling** (1:1 audio/video) | `callSignaling.js` | 1:1 P2P | Audio + video |
| **Paid Call Hosting** (1:1 audio/video, monetized) | `callHosting.js` | 1:1 P2P | Audio + video |

All three follow the exact same design principle, stated explicitly in
`callSignaling.js`'s header: **"Media never touches this server."** The
Node process only relays opaque SDP offers/answers and ICE candidates
between sockets — it never decodes, mixes, records, or forwards actual
audio/video bytes. This document focuses on **room voice**, since that's
the one with a multi-party (mesh) topology and the one "SFU migration"
normally refers to; the two 1:1 surfaces don't need an SFU (a media
server adds nothing for a 2-party call) and aren't in scope for Phase 3.

### 1.1 Architecture diagram — current (room voice)

```
                    ┌─────────────┐
                    │  Socket.IO  │   signaling only:
                    │   server    │   voice-offer / voice-answer /
                    │ (server.js) │   voice-candidate / voice-activity
                    └──────┬──────┘
                relay only,│no media touches this box
        ┌───────────────────────────────────┐
        │                                    │
        ▼                                    ▼
   ┌─────────┐   direct P2P (DTLS-SRTP)  ┌─────────┐
   │ Seat 1  │◄──────────────────────────►│ Seat 2  │
   │ Client  │◄───────────┐  ┌───────────►│ Client  │
   └────┬────┘            │  │            └────┬────┘
        │                 │  │                 │
        │            ┌────▼──▼────┐            │
        └───────────►│   Seat 3   │◄───────────┘
                      │   Client   │
                      └────────────┘
   (every seated client holds a direct RTCPeerConnection
    to every OTHER seated client — full mesh)
```

With up to 8 seats/room (`Array(8).fill(null)`, confirmed in `server.js`),
a full room is a complete graph on 8 nodes: **28 total peer-to-peer
connections, up to 7 simultaneous `RTCPeerConnection`s on a single
client's device** in the worst case (all 8 seats filled).

Only seated users open any `RTCPeerConnection` at all — this is gated
client-side on `mySeatNumber !== null` in `public/app.js` (verified at
every `connectToPeer`/`getOrCreatePeer` call site). Non-seated room
visitors (the audience) receive no live audio stream today; they only
see room/seat state over the existing Socket.IO channel.

### 1.2 ICE / signaling flow (room voice)

1. Client takes a seat → server broadcasts `room-state` → client's
   `room-state` handler (`public/app.js`) diffs `room.seats` against its
   own `peerConnections` map, closes stale peers, and calls
   `connectToPeer()` for every other currently-seated socket.
2. `connectToPeer()` → `getOrCreatePeer()` creates an `RTCPeerConnection`
   seeded with `iceServers` (from `/api/calls/ice-servers`, backed by
   `turn-config.js`), attaches local audio tracks, and — if this client
   is the offering side — creates and emits a `voice-offer`.
3. Server's `relayVoiceSignal()` (in `server.js`) validates the sender
   and target are **both currently seated in the same room** before
   relaying `voice-offer`/`voice-answer`/`voice-candidate` — a real,
   already-implemented security/correctness check (not something this
   audit needs to add).
4. Glare (both sides offering near-simultaneously) is handled client-side
   with a deterministic `polite`/`impolite` tie-breaker
   (`pc.polite = socket.id > remoteSocketId`) — a real, working perfect-
   negotiation-pattern implementation, already fixed per the in-code
   "BUG FIX (glare...)" comment.
5. `voice-activity` (speaking indicator) is a separate, high-frequency,
   `.volatile` broadcast — deliberately allowed to drop under backpressure
   since only the latest value matters. This is unrelated to media and
   stays on Socket.IO regardless of any future SFU decision.

### 1.3 TURN usage

`turn-config.js` (142 lines, read in full) is already well-built for a
scale-up:
- Static STUN/TURN via env vars (`STUN_URL`, `TURN_URL`,
  `TURN_USERNAME`, `TURN_CREDENTIAL`) — always works.
- **Optional** dynamic, short-lived TURN credentials via the standard
  coturn `use-auth-secret` REST mechanism (HMAC-SHA1, configurable TTL,
  default 6h) when `TURN_SECRET`/`TURN_REALM` are set — avoids the
  single-hardcoded-credential abuse risk the file's own comments
  correctly identify.
- Explicitly documented and actually implemented as **stateless** —
  every call is a pure function of env + current time, so it already
  requires zero changes for the multi-instance/Redis world Phase 2
  already built. This module needs no work for Phase 3 either; it can be
  reused as-is to mint credentials for a future SFU/TURN pair.

### 1.4 Peer lifecycle & reconnect handling

This is the most mature part of the current system, and duplicating any
of it would violate the project's own stated rules:
- **Client-side** (`public/app.js`): per-peer ICE-restart-then-rebuild
  recovery on `oniceconnectionstatechange`, deduped ICE candidate
  sending, capped-backoff Socket.IO reconnection, automatic
  `rejoinRoom()` + full peer re-establishment on `room-state`.
- **Server-side** (`voice-reconnect.js`, `room-recovery.js`,
  `server.js`'s `pendingDisconnects`): a disconnected seated user gets a
  30s grace period (not an instant seat-clear); `voice-peer-reconnecting`/
  `voice-peer-resumed` broadcasts tell peers to hold the connection open
  instead of tearing down and rebuilding; ghost-seat cleanup and a
  boot-time recovery sweep handle stale seats after a crash/restart.
  `room-recovery.js` explicitly and deliberately does **not** do
  automatic host transfer — a prior audit fix in `server.js` made
  ownership permanent on purpose, and `room-recovery.js`'s own header
  documents why it must not revert that. Any SFU work must preserve this
  the same way.

### 1.5 Connection limits, and where the real bottleneck is

Because "media never touches this server" is true today, **the Node
process currently bears ~zero CPU/bandwidth cost for voice media
itself** — its only voice-related load is small JSON signaling messages
(offer/answer/candidate, each sent a handful of times per seat-join) and
the `.volatile` speaking-activity stream. This was confirmed by reading
`relayVoiceSignal()`: it does a socket lookup, a same-room check, and a
single `.emit()` — no decoding, no media buffers, no transcoding.

The actual bottleneck is entirely **client-side**, and it's bounded by
the existing 8-seat cap:
- **Bandwidth (client):** up to 7 simultaneous send + 7 simultaneous
  receive Opus audio streams per seated client in a full room. Opus at
  typical WebRTC default (~24–32 kbps/direction) puts a fully-seated
  client's own upload around ~170–225 kbps, which is comfortably within
  normal mobile upload capacity but is 7x the traffic a single
  server-relayed (SFU) stream would need.
- **CPU (client):** up to 7 concurrent encode + 7 decode Opus
  sessions on one device. Mobile-class CPUs handle this fine at 8
  participants (Opus is cheap), which is almost certainly *why* the
  seat cap is exactly 8 today — full mesh audio is known to degrade
  past roughly 6–8 simultaneous participants on typical hardware, and
  this app's cap sits right at that ceiling.
- **Memory:** negligible either side — `RTCPeerConnection` objects and a
  handful of `<audio>` elements per peer.

**Conclusion: the server is not the bottleneck today. The client-side
mesh is, and it's already been capped exactly where mesh audio commonly
stops being practical.** This matters for Step 3.2+: an SFU migration's
main win here isn't "server can't keep up" (it currently does nothing
costly) — it's (a) removing the client-side mesh ceiling so the seat
cap could grow past 8 if the product ever wants that, (b) cutting
client bandwidth/battery cost even at the current 8-seat cap, and (c)
enabling anything that requires the server to actually see the audio
(recording, moderation, AI transcription, per-speaker dynamic
bitrate/simulcast for weak networks) — none of which is possible under
the current "media never touches this server" model, by design.

---

## 2. Existing Strengths (do not rebuild these)

- Signaling is already correctly scoped and rate-limited
  (`relayVoiceSignal`'s same-room check + `isRateLimited`).
- Glare handling is a real, correct perfect-negotiation implementation.
- Reconnect/grace-period handling is thorough and already
  cluster-compatible (Phase 2's Redis/presence work and this layer don't
  conflict — `voice-reconnect.js` rides on the existing
  `pendingDisconnects` mechanism, not a new one).
- `turn-config.js` is already stateless and multi-instance-safe — directly
  reusable by any SFU work with zero changes.
- Room-ownership permanence is a deliberate, documented product decision
  that any SFU work must not accidentally revert via a naive "host
  disconnect → reassign" pattern.
- Zero existing SFU/media-server dependencies in `package.json` — a
  genuinely clean slate for Step 3.2's technology choice, no half-started
  integration to reconcile.

## 3. Existing Bottlenecks / Limits (confirmed, not assumed)

1. **Seat cap of 8 is a mesh-scaling ceiling, not a product decision
   made independently of the architecture.** If there's ever a business
   reason to allow more than 8 simultaneous speakers, mesh cannot do it
   without a client-side redesign; an SFU can.
2. **No server-side visibility into actual media** — `voice-health.js`
   only has what clients self-report via `getStats()`. This is fine for
   today's trust model but blocks any future feature needing the server
   to see/process audio.
3. **Per-client upload/CPU cost scales O(n) with seated participants**,
   capped only by the seat limit — an SFU would flatten this to O(1)
   per client regardless of room size.
4. **No recording/moderation-of-voice capability exists or can exist**
   under the current model — flagging this only as an architectural fact
   for roadmap planning, not a recommendation either way.

## 4. SFU Migration Readiness

**Ready, with caveats:**
- ✅ Signaling layer is already cleanly isolated (`voice-offer`/
  `voice-answer`/`voice-candidate`/`voice-activity` are the only 4
  events involved) — swapping what's on the other end of that signaling
  (peer vs. SFU) is a contained change, not a rewrite of room/seat logic.
- ✅ `turn-config.js` needs no changes.
- ✅ Reconnect/grace-period infrastructure (`voice-reconnect.js`,
  `room-recovery.js`, `pendingDisconnects`) is reusable as-is; an SFU
  still needs "is this user's media connection alive" signaling, and
  this layer already provides the room-level context for it.
- ⚠️ `public/app.js`'s client logic (`peerConnections`,
  `getOrCreatePeer`, `connectToPeer`, glare handling) is mesh-specific
  and would need a parallel/replacement code path for an SFU (single
  `RTCPeerConnection` per client instead of one per peer). This is real,
  non-trivial client work — not a backend-only change.
- ⚠️ No existing server process is set up to run a media
  server/gateway — this needs new infrastructure (either an embedded
  Node SFU library or a separate media-server process/service),
  decided in Step 3.2.

## 5. Recommended SFU: LiveKit vs mediasoup vs Janus

Evaluated against this specific codebase's constraints — audio-only room
voice at up to 8 (potentially more later) participants, a single Node.js
process today, Phase 2's Redis-backed multi-instance/horizontal-scaling
work already in place, and a strong project convention of
additive/non-invasive modules:

| | **LiveKit** | **mediasoup** | **Janus** |
|---|---|---|---|
| **Deployment model** | Separate Go server process (self-hosted or LiveKit Cloud) | Node.js library — embeds directly into this same Node process/cluster | Separate C server process (gateway) |
| **Fit with existing Node/Express/Socket.IO app** | Requires running + operating a second service; SDKs are clean but it's a bigger ops lift | Best backend-language fit (same Node ecosystem as `server.js`) but you write the SFU orchestration logic yourself | Separate service + its own plugin config language; steepest ops learning curve of the three |
| **Multi-instance / horizontal scaling** | Built for this already (LiveKit's own room-sharding); dovetails with Phase 2's "any instance behind a load balancer" design goal | Requires building your own worker/router sharding on top of it | Possible but least out-of-the-box support for this |
| **Client SDK maturity** | Very mature, well-documented, official mobile SDKs (relevant if this app has/plans native mobile clients beyond the existing web client) | Solid but lower-level — more client-side integration work | Mature but older API style |
| **Operational complexity to reach production** | Lowest — most is handled by LiveKit itself; smallest new surface area for this team to maintain | Highest — you own the SFU orchestration (worker management, transport routing) | High — plugin-based C service, less Node-native tooling |
| **Best fit here** | **Recommended** | Viable if the team wants to own every layer and stay 100% in Node | Not recommended for this project |

**Recommendation: LiveKit**, primarily because (a) it minimizes new
custom code this team has to build and maintain — consistent with this
codebase's own repeated "don't build a second engine, reuse what
exists" philosophy — and (b) its scaling model is a natural continuation
of the horizontal-scaling investment Phase 2 already made (Redis
adapter, distributed presence), rather than a one-off single-process
media server that would need its own separate scaling story later.
`mediasoup` is the credible runner-up if the team specifically wants to
avoid operating a second service and is willing to invest more
engineering time in SFU orchestration logic. This is a recommendation
for Step 3.2 to evaluate further, not a decision made by this audit.

## 6. Exact Implementation Roadmap (next steps, not started)

Per your instruction, **none of this is implemented yet** — listed only
so Step 3.2 approval has a concrete plan to approve or adjust.

- **Step 3.2 — SFU spike/PoC:** stand up LiveKit (self-hosted, single
  node) in a non-production environment; validate token/auth flow
  against this project's existing `requireAdmin`/session model; confirm
  `turn-config.js`'s existing TURN setup is reusable or needs a LiveKit-
  specific equivalent.
- **Step 3.3 — Parallel client path:** add an SFU-based connection path
  in `public/app.js` behind a feature flag / room-level toggle, without
  removing the existing mesh path — additive, so any room can fall back
  to mesh if needed during rollout.
- **Step 3.4 — Server-side room↔SFU room mapping:** a new, additive
  module (following this codebase's `init(deps)` pattern) that maps this
  app's `roomId`/seat model to LiveKit rooms/tracks, reusing
  `turn-config.js` and the existing `pendingDisconnects`/grace-period
  logic rather than re-implementing reconnect handling.
- **Step 3.5 — Migration + cutover plan:** gradual rollout (e.g.
  percentage of rooms, or rooms above a seat-count threshold first),
  monitoring via `voice-health.js`'s existing stats pipeline extended
  with SFU-side metrics, before any decision to deprecate the mesh path.
- **Step 3.6 — Decide seat-cap increase:** only after 3.2–3.5 are stable,
  evaluate whether to raise the 8-seat limit now that mesh's ceiling no
  longer applies.

---

## Verification performed for this audit

- Read `server.js`'s room-voice signaling block in full (lines
  ~5996–6040), `callSignaling.js`, `voice-health.js`,
  `voice-reconnect.js`, `room-recovery.js`, and `turn-config.js`
  end-to-end.
- Grepped `public/app.js` for every `RTCPeerConnection`/`peerConnections`/
  `voice-offer`/`voice-answer`/`voice-candidate`/`getUserMedia` call site
  to confirm mesh topology and the seat-gating condition
  (`mySeatNumber !== null`) rather than assuming it.
- Confirmed the 8-seat cap directly from `server.js`
  (`Array(8).fill(null)`).
- Confirmed room voice is audio-only by checking the exact
  `getUserMedia` constraints used at the room-voice call sites
  (`VOICE_AUDIO_CONSTRAINTS`, no video).
- Confirmed zero existing SFU/media-server dependencies via
  `package.json`.
- No code was modified — no bug was found that met the "real
  compatibility bug" bar for an exception to the audit-only rule.
