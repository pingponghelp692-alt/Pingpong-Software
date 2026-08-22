// public/voice-sfu.js
// ==================================================
// PHASE 3, STEP 3.3 — CLIENT-SIDE SFU (LIVEKIT) INTEGRATION
// ==================================================
// Dedicated, additive module (per the Step 3.3 spec's "do not mix thousands
// of lines directly into the existing mesh code" instruction). app.js's
// mesh implementation (peerConnections, connectToPeer(), getOrCreatePeer(),
// glare handling, ICE-restart/reconnect logic) is not touched by this file
// and is not touched anywhere because of this file's existence.
//
// This file only ever DOES something when app.js explicitly calls
// window.PingPongVoiceSFU.connect(...) — which app.js only does once it has
// already confirmed (via GET /api/voice-sfu/mode) that the server is
// running VOICE_MODE=sfu. On a VOICE_MODE=mesh deployment (the default),
// this script loads, defines four functions, and otherwise does nothing:
// no network request, no LiveKit SDK download, no behavior change. That is
// what keeps "everything must continue working when VOICE_MODE=mesh even
// if LiveKit SDK is absent" (spec requirement #8) true.
//
// WHY THE LIVEKIT CLIENT SDK IS LOADED FROM A CDN AT RUNTIME, NOT BUNDLED:
// this codebase has no build step / bundler (see the firebaseClient.js
// comment in index.html for the same reasoning) and ships plain <script>
// includes. Loading livekit-client only inside loadSdk() — called only
// from connect(), called only in SFU mode — means a mesh-only deployment
// never fetches it at all, matching voice_sfu/token.js's server-side
// "lazy require, only touched in SFU mode" pattern on the client side.
//
// NOT SMOKE-TESTED AGAINST A LIVE LIVEKIT SERVER (same honest caveat as
// PHASE3_STEP32_REPORT.md §6): this sandbox has no network egress. Written
// against LiveKit JS SDK v2's documented public API (Room, RoomEvent,
// Track, localParticipant.publishTrack, track.attach()/detach(),
// RoomEvent.ActiveSpeakersChanged). Treat this file as needing one real
// join test against a live LiveKit room before relying on it in
// production — flagged in PHASE3_STEP33_REPORT.md, not hidden.

(function () {
  "use strict";

  // Pinned version (not "@latest") so a LiveKit SDK release can't silently
  // change behavior under this deployment without an explicit edit here.
  var LIVEKIT_CDN_URL = "https://cdn.jsdelivr.net/npm/livekit-client@2.21.0/dist/livekit-client.umd.min.js";

  var sdkLoadPromise = null;
  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    if (sdkLoadPromise) return sdkLoadPromise;
    sdkLoadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = LIVEKIT_CDN_URL;
      script.async = true;
      script.onload = function () {
        if (window.LivekitClient) resolve(window.LivekitClient);
        else { sdkLoadPromise = null; reject(new Error("[voice-sfu] livekit-client loaded but window.LivekitClient is missing")); }
      };
      script.onerror = function () {
        sdkLoadPromise = null; // allow a retry on a later connect() attempt instead of permanently failing
        reject(new Error("[voice-sfu] failed to load livekit-client from CDN"));
      };
      document.head.appendChild(script);
    });
    return sdkLoadPromise;
  }

  // Single active LiveKit Room at a time — this client only ever occupies
  // one PingPong voice room at once (same invariant the mesh path already
  // relies on for `peerConnections`/`currentRoomId`), so no room registry
  // is needed here.
  var currentRoom = null;
  var currentOnSpeakingChanged = null;
  var currentOnDisconnected = null;
  // PHASE 3, STEP 3.6 addition — the LocalTrackPublication returned by
  // publishTrack(), tracked so unpublishMicTrack() (audience downgrade)
  // can reference the exact publication without the caller (app.js)
  // needing to hold onto a LiveKit SDK object itself.
  var currentMicPublication = null;
  // ROOT-CAUSE FIX (2026-08-10) — key: "<identity>:<trackSid>" -> attached
  // <audio> element, so TrackSubscribed can never double-attach the same
  // track (duplicate audio) and TrackUnsubscribed/disconnect can always
  // find and remove the right element. Reset on every disconnect() so a
  // fresh Room connection starts with a clean registry.
  var remoteAudioEls = {};
  var audioUnlockHandler = null;
  // PRODUCTION VOICE RECOVERY: keep enough client state to heal a terminal
  // LiveKit disconnect without forcing the user to leave/re-enter the room.
  var currentMicTrack = null;
  var intentionalDisconnect = false;
  var recoveryInProgress = false;

  // micTrack: the SAME MediaStreamTrack app.js's existing getUserMedia()
  // call already produced (localStream). Reusing it — instead of asking
  // LiveKit to capture its own mic stream — means the existing Web Audio
  // VAD (startVoiceActivityDetection() in app.js) keeps analyzing exactly
  // what's being published, and the existing mic-mute toggle (which just
  // flips track.enabled) mutes the SFU-published audio too, with zero
  // SFU-specific mute code needed. This is what "preserve speaking
  // indicators, do not redesign the UI" (spec requirement #7) meant in
  // practice: nothing about the indicator path changes at all.
  //
  // onSpeakingChanged(userId, speaking): bridges LiveKit's own
  // ActiveSpeakersChanged event for REMOTE participants into app.js's
  // existing speakingUsers/renderSeats UI. Local speaking already reaches
  // every other client via the existing socket "voice-activity" broadcast
  // (transport-agnostic — it rides Socket.IO, not the peer/media path), so
  // this bridge only ever needs to cover the reverse direction.
  async function connect(opts) {
    opts = opts || {};
    var url = opts.url, token = opts.token, micTrack = opts.micTrack;
    if (!url || !token) throw new Error("[voice-sfu] connect(): url and token are required");
    intentionalDisconnect = false;
    recoveryInProgress = false;
    if (currentRoom) await disconnect(); // defensive: never let two Room instances stack up on a fast rejoin

    var LK = await loadSdk();
    var room = new LK.Room();
    currentRoom = room;
    currentOnSpeakingChanged = typeof opts.onSpeakingChanged === "function" ? opts.onSpeakingChanged : null;
    currentOnDisconnected = typeof opts.onDisconnected === "function" ? opts.onDisconnected : null;
    currentMicTrack = micTrack || null;

    // ---- connect: only around connect/disconnect/publish/subscribe/
    // reconnect/failures, per spec requirement #10 ("no noisy logging
    // elsewhere") ----
    room.on(LK.RoomEvent.TrackSubscribed, function (track, publication, participant) {
      if (track.kind !== "audio") return;
      // ROOT-CAUSE FIX (2026-08-10, "hears some participants but not
      // others" / 3+ participant partial audio): this used to rely solely
      // on the `autoplay` attribute. That is not reliable on every mobile
      // browser (same lesson already learned and fixed for the 1-to-1
      // call video/audio path — see app.js's remoteVideo.play() fix,
      // "Fix (connects but black screen)") — an audio element created and
      // appended without an explicit play() call can silently sit unplayed
      // with zero error surfaced anywhere, and which particular remote
      // participant's element gets blocked depends on unpredictable
      // per-element browser autoplay-policy timing. That produces exactly
      // the reported symptom: which peers you can/can't hear varies by
      // timing, not by any consistent logic bug. Mirrors the proven fix
      // pattern from app.js exactly, plus a guard against creating a
      // second audio element for a track that's already attached (LiveKit
      // reconnect edge case / defensive duplicate-audio hardening, task
      // requirement "PREVENT DUPLICATE OR MISSING AUDIO").
      var identity = participant && participant.identity;
      var key = (identity || "unknown") + ":" + (track.sid || publication && publication.trackSid || "");
      if (remoteAudioEls[key]) return; // already attached — never double-attach the same track
      var el = track.attach();
      el.autoplay = true;
      document.body.appendChild(el);
      remoteAudioEls[key] = el;
      var playPromise = el.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.then(function () {
          console.log("[voice-sfu] subscribed + playing remote audio track", identity || "");
        }).catch(function (err) {
          // Autoplay was blocked. Retry once immediately (covers the
          // common case where the page already has a user-gesture-granted
          // audio allowance and this was just a transient timing issue);
          // if it's still blocked, this is a real browser-autoplay-policy
          // block, not a bug this module can force past on its own — logged
          // so it's distinguishable from the silent-failure this fix
          // replaces, never hidden.
          console.warn("[voice-sfu] remote audio autoplay blocked, retrying once:", err && err.message, identity || "");
          el.play().catch(function (err2) {
            console.warn("[voice-sfu] remote audio autoplay retry failed (browser is blocking playback):", err2 && err2.message, identity || "");
          });
        });
      }
      console.log("[voice-sfu] subscribed to remote audio track", identity || "");
    });
    room.on(LK.RoomEvent.TrackUnsubscribed, function (track, publication, participant) {
      var identity = participant && participant.identity;
      var key = (identity || "unknown") + ":" + (track.sid || publication && publication.trackSid || "");
      delete remoteAudioEls[key];
      (track.detach() || []).forEach(function (el) { el.remove(); });
    });
    // Mobile browsers may require a user gesture before remote audio can
    // start. LiveKit exposes this state explicitly; use the next real tap to
    // unlock audio so audience listeners do not randomly hear some peers and
    // miss others because individual <audio> elements were created at
    // different times.
    audioUnlockHandler = function () {
      if (!currentRoom || currentRoom !== room || room.canPlaybackAudio !== false) return;
      room.startAudio().catch(function () {});
    };
    document.addEventListener("pointerdown", audioUnlockHandler, { passive: true });
    room.on(LK.RoomEvent.AudioPlaybackStatusChanged, function () {
      if (room.canPlaybackAudio && audioUnlockHandler) {
        document.removeEventListener("pointerdown", audioUnlockHandler);
        audioUnlockHandler = null;
      }
    });

    room.on(LK.RoomEvent.ActiveSpeakersChanged, function (speakers) {
      if (!currentOnSpeakingChanged) return;
      var speakingIds = {};
      (speakers || []).forEach(function (p) { if (p && p.identity) speakingIds[p.identity] = true; });
      // room.remoteParticipants is a Map<identity, Participant> in the
      // LiveKit v2 client SDK — iterate it to report both "now speaking"
      // and "no longer speaking" for every known remote participant, same
      // shape as app.js's existing socket "voice-activity" handler.
      if (room.remoteParticipants && typeof room.remoteParticipants.forEach === "function") {
        room.remoteParticipants.forEach(function (p) {
          if (p && p.identity) currentOnSpeakingChanged(p.identity, !!speakingIds[p.identity]);
        });
      }
    });
    room.on(LK.RoomEvent.Reconnecting, function () {
      console.log("[voice-sfu] reconnecting...");
      if (currentOnDisconnected) currentOnDisconnected("reconnecting");
    });
    room.on(LK.RoomEvent.Reconnected, async function () {
      console.log("[voice-sfu] reconnected");
      // LiveKit normally restores publications automatically. The explicit
      // check below covers the edge case where a mobile network handoff
      // leaves the local microphone publication absent after reconnect.
      try {
        if (currentMicTrack && currentRoom === room) {
          var existing = room.localParticipant.getTrackPublication &&
            room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
          if (!existing) {
            currentMicPublication = await room.localParticipant.publishTrack(currentMicTrack, {
              source: LK.Track.Source.Microphone,
              name: "microphone"
            });
          } else {
            currentMicPublication = existing;
          }
        }
      } catch (e) {
        console.warn("[voice-sfu] microphone restore after reconnect failed:", e && e.message);
      }
      // Re-run audio attachment/playback checks after network handoff.
      if (room.remoteParticipants && typeof room.remoteParticipants.forEach === "function") {
        room.remoteParticipants.forEach(function (participant) {
          if (!participant || !participant.trackPublications) return;
          participant.trackPublications.forEach(function (publication) {
            if (!publication || publication.kind !== "audio" || !publication.isSubscribed || !publication.track) return;
            var key = (participant.identity || "unknown") + ":" + (publication.track.sid || publication.trackSid || "");
            if (remoteAudioEls[key]) {
              remoteAudioEls[key].play().catch(function () {});
              return;
            }
            var el = publication.track.attach();
            el.autoplay = true;
            document.body.appendChild(el);
            remoteAudioEls[key] = el;
            el.play().catch(function () {});
          });
        });
      }
      if (currentOnDisconnected) currentOnDisconnected("reconnected");
    });
    room.on(LK.RoomEvent.Disconnected, function (reason) {
      console.log("[voice-sfu] disconnected", reason || "");
      if (currentRoom === room) currentRoom = null;
      if (!intentionalDisconnect && currentOnDisconnected) currentOnDisconnected("disconnected", reason);
    });

    console.log("[voice-sfu] connecting...");
    await room.connect(url, token);
    console.log("[voice-sfu] connected");

    if (micTrack) {
      currentMicTrack = micTrack;
      currentMicPublication = await room.localParticipant.publishTrack(micTrack, {
        source: LK.Track.Source.Microphone,
        name: "microphone"
      });
      console.log("[voice-sfu] published microphone track");
    }
    return room;
  }

  // PHASE 3, STEP 3.6 addition — publishes a mic track onto the CURRENT,
  // already-connected Room (audience -> seat upgrade) instead of tearing
  // down and reconnecting. Server-side publish permission for this
  // identity is granted independently by voice_sfu/sync.js's
  // onSeatChanged (fired by the very same take-seat/mod-move-seat event
  // that led here) — this function only performs the CLIENT-side publish;
  // it never grants itself permission. If LiveKit rejects the publish
  // (e.g. the server-side permission update hasn't landed yet — see
  // PHASE3_STEP36_REPORT.md's known race), this throws and the caller
  // (app.js's connectSfuRoom) decides whether to retry.
  async function publishMicTrack(micTrack) {
    if (!currentRoom || !micTrack) return false;
    var LK = await loadSdk(); // already loaded at this point in every real call path; resolves instantly from cache
    currentMicPublication = await currentRoom.localParticipant.publishTrack(micTrack, {
      source: LK.Track.Source.Microphone,
      name: "microphone"
    });
    console.log("[voice-sfu] published microphone track (in-place upgrade, no reconnect)");
    return true;
  }

  // PHASE 3, STEP 3.6 addition — the seat -> audience counterpart:
  // unpublishes the mic track WITHOUT disconnecting the Room, so the
  // participant keeps subscribing to (hearing) every other seated
  // speaker as an audience member. Safe to call with nothing currently
  // published (no-op).
  async function unpublishMicTrack() {
    if (!currentRoom || !currentMicPublication) { currentMicPublication = null; return; }
    var pub = currentMicPublication;
    currentMicPublication = null;
    try {
      await currentRoom.localParticipant.unpublishTrack(pub.track || pub);
      console.log("[voice-sfu] unpublished microphone track (kept subscribe-only connection)");
    } catch (e) {
      console.error("[voice-sfu] unpublishMicTrack failed:", e && e.message);
    }
  }

  async function disconnect() {
    intentionalDisconnect = true;
    if (!currentRoom) { currentMicTrack = null; return; }
    var room = currentRoom;
    currentRoom = null;
    currentMicPublication = null;
    currentMicTrack = null;
    currentOnSpeakingChanged = null;
    currentOnDisconnected = null;
    remoteAudioEls = {}; // ROOT-CAUSE FIX (2026-08-10) — don't carry stale keys into the next connection; any elements themselves are torn down by LiveKit's own TrackUnsubscribed firing during room.disconnect()
    if (audioUnlockHandler) { document.removeEventListener("pointerdown", audioUnlockHandler); audioUnlockHandler = null; }
    try {
      console.log("[voice-sfu] disconnecting...");
      await room.disconnect();
    } catch (e) {
      // already gone / never fully connected — safe to ignore, mirrors
      // closePeer()'s tolerance of an already-torn-down connection
    }
  }

  function isConnected() {
    return !!currentRoom;
  }

  // Bug fix (Robin/Vapi voice conflict, 2026-08-12): when a Room 101 seated
  // user's mic is already published to LiveKit and Robin (Vapi/daily-js)
  // then also calls getUserMedia() for its own separate call, some devices
  // (observed on Android Chrome) refuse the second concurrent open of the
  // same physical mic at the OS/driver level (NotReadableError), which
  // surfaces inside vapi.start() as a generic failure. This does NOT stop
  // or unpublish the SFU mic track (that would drop the user from the room
  // voice and require a full republish) — it only disables the underlying
  // hardware track for the duration of the Robin call, which frees the
  // device without losing LiveKit's publication/connection state. Muting a
  // LocalTrackPublication is a supported, reversible operation.
  function pauseMicForRobin() {
    try {
      if (currentMicPublication && typeof currentMicPublication.mute === "function") {
        currentMicPublication.mute();
        return true;
      }
      var track = currentMicPublication && (currentMicPublication.track || currentMicPublication);
      var mst = track && (track.mediaStreamTrack || track);
      if (mst && "enabled" in mst) { mst.enabled = false; return true; }
    } catch (_) { /* best-effort only, never block Robin's own call */ }
    return false;
  }

  function resumeMicAfterRobin() {
    try {
      if (currentMicPublication && typeof currentMicPublication.unmute === "function") {
        currentMicPublication.unmute();
        return true;
      }
      var track = currentMicPublication && (currentMicPublication.track || currentMicPublication);
      var mst = track && (track.mediaStreamTrack || track);
      if (mst && "enabled" in mst) { mst.enabled = true; return true; }
    } catch (_) { /* best-effort only */ }
    return false;
  }

  window.PingPongVoiceSFU = {
    loadSdk: loadSdk, connect: connect, disconnect: disconnect, isConnected: isConnected,
    publishMicTrack: publishMicTrack, unpublishMicTrack: unpublishMicTrack, // PHASE 3, STEP 3.6
    pauseMicForRobin: pauseMicForRobin, resumeMicAfterRobin: resumeMicAfterRobin // Robin/Vapi mic-conflict fix
  };
})();
