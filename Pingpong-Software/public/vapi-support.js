/*
 * PingPong — Robin AI Customer Support Voice
 * Additive integration: uses Vapi Web SDK only for the support channel.
 * It does not touch the existing room WebRTC/LiveKit voice engine.
 */
(function () {
  "use strict";

  const SDK_URL = "https://esm.sh/@vapi-ai/web@2.5.2";

  const state = {
    config: null,
    vapi: null,
    loading: false,
    starting: false,
    active: false,
    muted: false,
    transcript: [],
    previousRoomMic: null,
    // ROOT-CAUSE FIX (orphan Vapi call): if the user leaves the seat while
    // startCall() is still in flight (awaiting config/SDK load or the
    // Vapi start() network round-trip), endCall() previously had nothing
    // to stop yet (state.vapi.start() hadn't resolved) and silently
    // no-op'd — then the in-flight start() would resolve afterward and
    // open the mic for a call the user is no longer seated for. This flag
    // lets endCall() record "stop was requested" during that window, and
    // startCall() checks it immediately after the call actually connects,
    // tearing it straight back down instead of leaving it active.
    stopRequested: false
  };

  const $ = (id) => document.getElementById(id);

  function setStatus(text, label) {
    const status = $("vapi-robin-status");
    const labelEl = $("vapi-robin-status-label");
    if (status) status.textContent = text || "";
    if (labelEl) labelEl.textContent = label || "Ready";
  }

  // BUG FIX (2026-08-14): this function was CALLED (in the vapi.on("error")
  // handler below) but never DEFINED anywhere in this file — every real
  // Vapi runtime error threw a ReferenceError inside that event callback
  // instead of ever reaching window.PingPongRobin.onVoiceFailure. That is
  // the reason the "guarantee Robin still speaks" fallback (app.js /
  // cs101FallbackAfterVapiFailure) never actually ran: the hook that was
  // supposed to trigger it was silently broken. Defined now as a small,
  // defensive wrapper so a bad/missing hook can never itself throw.
  function notifyFailure(error) {
    try {
      window.PingPongRobin?.onVoiceFailure?.(error);
    } catch (hookErr) {
      console.warn("[Vapi Robin] onVoiceFailure hook threw:", hookErr);
    }
    // Report to the server so an admin can see Robin's real-world failure
    // rate in the Admin Panel instead of it only ever appearing in one
    // customer's own browser console. Best-effort — never throws, never
    // blocks the fallback above, and carries no credentials.
    try {
      if (window.socket && typeof window.socket.emit === "function") {
        window.socket.emit("cs101:voice-error", {
          reason: classifyVapiError(error),
          raw: String(error?.message || error?.error?.message || error || "").slice(0, 300)
        });
      }
    } catch (reportErr) {
      console.warn("[Vapi Robin] failure report to server failed:", reportErr);
    }
  }

  function setOverlay(_open) {
    const el = $("vapi-robin-overlay");
    if (el) el.classList.add("hidden");
  }

  function setActiveUi(active) {
    const button = $("btn-robin-support");
    if (button) button.classList.toggle("robin-active", !!active);
    const pulse = $("vapi-robin-pulse");
    if (pulse) pulse.style.display = active ? "inline-block" : "none";
    const end = $("btn-robin-end");
    if (end) end.disabled = !active;
    const mute = $("btn-robin-mute");
    if (mute) mute.disabled = !active;
  }

  function appendTranscript(role, text) {
    const value = String(text || "").trim();
    if (!value) return;
    state.transcript.push({ role, text: value });
    if (state.transcript.length > 20) state.transcript.shift();

    const box = $("vapi-robin-transcript");
    if (!box) return;
    box.style.display = "block";
    box.textContent = state.transcript
      .map((item) => `${item.role === "assistant" ? "Robin" : "You"}: ${item.text}`)
      .join("\n");
    box.scrollTop = box.scrollHeight;
  }

  async function loadConfig() {
    if (state.config) return state.config;
    const response = await fetch("/api/vapi/config", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Vapi config HTTP ${response.status}`);
    const config = await response.json();
    state.config = config;
    console.log("[Vapi Robin] config loaded", {
      enabled: !!config.enabled,
      hasPublicKey: !!config.publicKey,
      hasAssistantId: !!config.assistantId,
      roomId: config.roomId
    });
    // Once configured, the legacy Room 101 browser STT/TTS must stay out of
    // the way. Vapi owns the support microphone/audio path.
    window.__PINGPONG_VAPI_ENABLED = !!config.enabled;
    return config;
  }

  async function loadSdk() {
    if (window.Vapi) return window.Vapi;
    if (state.loading) {
      while (state.loading) await new Promise((resolve) => setTimeout(resolve, 50));
      if (window.Vapi) return window.Vapi;
    }

    state.loading = true;
    try {
      // Pinned SDK version: avoids silently changing the production voice
      // client when a CDN "latest" release changes.
      const mod = await import(SDK_URL);
      window.Vapi = mod.default || mod.Vapi || mod;
      if (!window.Vapi) throw new Error("Vapi Web SDK did not expose a client");
      return window.Vapi;
    } finally {
      state.loading = false;
    }
  }

  function wireEvents(vapi) {
    vapi.on("call-start", () => {
      state.active = true;
      state.muted = false;
      setActiveUi(true);
      setStatus("Connected. You can speak naturally.", "Connected");
      // A real, successful connection always wins over the fallback bridge.
      // This matters most when our own 7s "Vapi seems stuck" watchdog
      // (app.js) fired a little early on a slow network and switched the
      // seat over to the browser SpeechRecognition/SpeechSynthesis bridge,
      // and Vapi then goes on to connect anyway a few seconds later —
      // without this, both the real Vapi call AND the browser's own mic
      // listener would be open on the seat at once. Two concurrent
      // getUserMedia consumers can silently break each other on some
      // Android WebViews (only one is guaranteed reliable), which matches
      // "spoke once then stopped responding" — Robin's first reply came
      // from whichever source grabbed the mic first, then the second
      // consumer's mic request interfered with it.
      window.PingPongRobin?.onVoiceStart?.();
    });

    vapi.on("call-end", () => {
      state.active = false;
      state.muted = false;
      setActiveUi(false);
      setStatus("Support call ended.", "Ended");
      window.__PINGPONG_VAPI_CALL_ACTIVE = false;
      window.PingPongRoomVoice?.resumeMicAfterRobin?.();
    });

    vapi.on("speech-start", () => {
      setStatus("Robin is speaking…", "Speaking");
    });

    vapi.on("speech-end", () => {
      if (state.active) setStatus("Listening…", "Listening");
    });

    vapi.on("message", async (message) => {
      if (!message) return;
      if (message.type === "transcript") {
        appendTranscript(message.role || "user", message.transcript || "");
        if (state.active && message.role === "user") setStatus("Listening…", "Listening");
      }
      if (message.type === "tool-calls") {
        const calls = Array.isArray(message.toolCallList) ? message.toolCallList : [];
        for (const toolCall of calls) {
          const name = toolCall?.function?.name;
          if (name !== "room_control") continue;
          let args = {};
          try {
            const raw = toolCall?.function?.arguments;
            args = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {});
          } catch (_) {
            args = {};
          }
          try {
            const result = await new Promise((resolve) => {
              if (!window.socket || typeof window.socket.emit !== "function") return resolve({ ok:false, message:"Room control is unavailable." });
              window.socket.emit("cs101:admin-command", args, (reply) => resolve(reply || { ok:false, message:"No response from Room 101." }));
            });
            const spoken = result?.message || (result?.ok ? "The room action is complete." : "I could not complete that room action.");
            if (state.vapi?.addMessage) {
              state.vapi.addMessage({ role: "system", content: `Room control result: ${spoken}` });
            }
          } catch (err) {
            console.warn("[Vapi Robin] room control failed:", err);
            if (state.vapi?.addMessage) state.vapi.addMessage({ role: "system", content: "Room control failed. Tell the customer the action could not be completed." });
          }
        }
      }
    });

    vapi.on("error", (error) => {
      console.error("[Vapi Robin]", error);
      state.active = false;
      state.muted = false;
      setActiveUi(false);
      setStatus(classifyVapiError(error), "Error");
      window.__PINGPONG_VAPI_CALL_ACTIVE = false;
      window.PingPongRoomVoice?.resumeMicAfterRobin?.();
      notifyFailure(error);
    });
  }

  // Shared with the startCall() catch block below — previously this event
  // handler always showed the generic "Voice support could not connect.
  // Please try again." even when the Vapi SDK's own async "error" event
  // (fired after the call is already underway, separate from a rejected
  // start() promise) carried a specific, actionable reason (bad key,
  // missing/unpublished assistant, network/CSP block). Surfacing the real
  // reason here doesn't change behavior when the message truly is unknown
  // — it still falls back to the same generic text.
  function classifyVapiError(error) {
    const msg = String(error?.message || error?.error?.message || error || "");
    if (/HTTPS|secure context|microphone|mediaDevices|permission denied|NotAllowedError/i.test(msg)) {
      return "Microphone access is blocked. Allow microphone permission and open PingPong over HTTPS.";
    }
    if (/401|403|unauthori[sz]ed|forbidden|public.?key|api.?key/i.test(msg)) {
      return "Vapi rejected the Public Key. Confirm VAPI_PUBLIC_KEY and the Assistant belong to the same Vapi project.";
    }
    if (/assistant|not found|invalid.*id/i.test(msg)) {
      return "Vapi could not find the configured Assistant. Verify VAPI_ASSISTANT_ID and that the assistant is published.";
    }
    if (/network|fetch|load|import|failed to fetch|esm\.sh|ice|webrtc/i.test(msg)) {
      return "Voice support lost its connection (network/WebRTC). Please try again.";
    }
    return "Voice support could not connect. Please try again.";
  }

  async function startCall() {
    if (state.active) return true;
    if (state.starting) {
      while (state.starting) await new Promise((resolve) => setTimeout(resolve, 50));
      return !!state.active;
    }
    state.starting = true;
    state.stopRequested = false;
    try {
      const config = await loadConfig();
      if (!config.enabled || !config.publicKey || !config.assistantId) {
        const reason = "Vapi is not configured yet. Browser voice fallback will be used for this seat visit.";
        console.warn("[Vapi Robin] automatic start skipped:", reason);
        notifyFailure(new Error(reason));
        return false;
      }

      // Browser voice capture requires a secure context in normal browsers.
      // localhost is treated as a secure development origin by modern browsers.
      const host = String(location.hostname || "").toLowerCase();
      const localDevHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!window.isSecureContext && !localDevHost) {
        throw new Error("Robin voice requires HTTPS when the app is opened by an IP address or public domain.");
      }
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
        throw new Error("This browser does not expose microphone access. Open PingPong in a supported browser over HTTPS.");
      }

      setStatus("Preparing Robin voice support…", "Connecting");

      const Vapi = await loadSdk();
      if (!state.vapi) {
        state.vapi = new Vapi(config.publicKey);
        wireEvents(state.vapi);
      }

      state.transcript = [];
      const box = $("vapi-robin-transcript");
      if (box) {
        box.textContent = "";
        box.style.display = "none";
      }

      // The override only provides non-sensitive app context. The actual
      // assistant prompt/config remains controlled by the Vapi dashboard.
      const currentUser = (typeof me !== "undefined" && me) ? me : null;
      const activeRoomId = (typeof currentRoomId !== "undefined" && currentRoomId) ? currentRoomId : "";
      const userId = currentUser && currentUser.userId ? String(currentUser.userId) : "";
      const userName = currentUser && currentUser.name ? String(currentUser.name) : "";
      const roomId = String(activeRoomId || "");

      window.__PINGPONG_VAPI_CALL_ACTIVE = true;
      // Free the physical mic from PingPong's own room voice (mesh or SFU)
      // before Robin opens it for its own call — see pingpongPauseRoomMicForRobin
      // in app.js for why this exists. No-op if the user isn't seated/voice
      // isn't active.
      window.PingPongRoomVoice?.pauseMicForRobin?.();
      // Start the dashboard-configured assistant with only supported, non-sensitive
      // variable overrides. Do not inject a client-side tool definition here:
      // malformed/unsupported assistantOverrides can make start() reject before
      // the Vapi call is established, which previously made the hands-free seat
      // appear completely silent. Room-admin tools remain server-side/dashboard
      // controlled and are not required to establish the voice call.
      await state.vapi.start(config.assistantId, {
        // Robin must greet the customer immediately on connect, not wait for
        // them to speak first — this is a standard Vapi call-start override
        // (not a custom tool schema), so it can't make start() reject the
        // way an unsupported override could. Independent of whatever
        // "first message" mode happens to be set on the Vapi dashboard for
        // this assistant.
        firstMessageMode: "assistant-speaks-first",
        variableValues: {
          userId: userId.slice(0, 120),
          userName: userName.slice(0, 120),
          roomId: roomId.slice(0, 40),
          supportChannel: "pingpong-app"
        }
      });
      console.log("[Vapi Robin] automatic Customer Service call requested", { roomId, userId, assistantId: config.assistantId });
      // call-start is the authoritative success signal; this log only means
      // start() accepted the request.

      if (state.stopRequested) {
        // The seat was left (or the room/component was torn down) while
        // this start() call was still connecting. Do not leave the call
        // active — immediately stop it, same as a normal endCall(), so no
        // orphan call/microphone survives the seat visit that requested it.
        console.warn("[Vapi Robin] stop was requested while connecting — tearing down the call that just started");
        state.stopRequested = false;
        try {
          await state.vapi.stop();
        } catch (stopErr) {
          console.warn("[Vapi Robin] post-connect teardown stop failed:", stopErr);
        }
        state.active = false;
        state.muted = false;
        window.__PINGPONG_VAPI_CALL_ACTIVE = false;
        setActiveUi(false);
        setStatus("Support call ended.", "Ended");
        window.PingPongRoomVoice?.resumeMicAfterRobin?.();
        return false;
      }

      return true;
    } catch (error) {
      console.error("[Vapi Robin] start failed:", error);
      console.error("[Vapi Robin] error name:", error?.name);
      console.error("[Vapi Robin] error message:", error?.message);
      console.error("[Vapi Robin] error details:", error?.details || error?.data || error?.body || error);
      window.__PINGPONG_VAPI_CALL_ACTIVE = false;
      state.active = false;
      setActiveUi(false);
      window.PingPongRoomVoice?.resumeMicAfterRobin?.();

      const msg = String(error?.message || error || "");
      if (/HTTPS|secure context|microphone|mediaDevices/i.test(msg)) {
        setStatus(msg, "Microphone / HTTPS required");
      } else {
        setStatus(classifyVapiError(error), "Vapi error");
      }
      // Guarantee Robin still speaks even when the Vapi cloud call itself
      // can't be established (bad key, unpublished assistant, blocked
      // network, etc). notifyFailure() switches the room over to the
      // browser SpeechRecognition/SpeechSynthesis bridge for this seat
      // visit, which only needs the app's own server (already reachable)
      // — not a third-party voice vendor.
      // BUG FIX (2026-08-14): this was the primary failure path (a rejected
      // vapi.start() — bad key, unpublished assistant, blocked mic,
      // network) and it never actually called notifyFailure(), so the
      // fallback bridge never engaged here even once notifyFailure() itself
      // was fixed. Every customer whose Vapi call failed to connect in the
      // first place got silence, with no fallback and no server-side trace.
      notifyFailure(error);
      return false;
    } finally {
      state.starting = false;
    }
  }

  // Called on any failure to actually establish the call (start() reject,
  // or the SDK's own async "error" event). Not called on a normal
  // user-initiated end (call-end while state.active was true) — that's a
  // successful call ending, not a failure, and must not re-trigger a
  // fallback greeting.
  async function endCall() {
    if (state.starting) {
      // A start() is currently connecting (config/SDK load or the Vapi
      // network round-trip) and there is no established call yet to stop.
      // Record the request; startCall()'s post-connect check picks this up
      // the moment the call actually connects and tears it straight back
      // down. Also reset the UI/flags eagerly so the seat visually looks
      // stopped right away instead of waiting for that async teardown.
      state.stopRequested = true;
      state.active = false;
      state.muted = false;
      window.__PINGPONG_VAPI_CALL_ACTIVE = false;
      setActiveUi(false);
      setStatus("Support call ended.", "Ended");
      return true;
    }
    try {
      if (state.vapi) await state.vapi.stop();
    } catch (error) {
      console.warn("[Vapi Robin] stop failed:", error);
    }
    state.active = false;
    state.muted = false;
    window.__PINGPONG_VAPI_CALL_ACTIVE = false;
    setActiveUi(false);
    setStatus("Support call ended.", "Ended");
    window.PingPongRoomVoice?.resumeMicAfterRobin?.();
    return true;
  }

  function toggleMute() {
    if (!state.vapi || !state.active) return;
    try {
      state.muted = !state.muted;
      state.vapi.setMuted(state.muted);
      const button = $("btn-robin-mute");
      if (button) button.textContent = state.muted ? "🔇 Unmute" : "🎤 Mute";
      setStatus(state.muted ? "Your microphone is muted." : "Listening…", state.muted ? "Muted" : "Listening");
    } catch (error) {
      console.warn("[Vapi Robin] mute toggle failed:", error);
    }
  }

  async function init() {
    const button = $("btn-robin-support");
    if (!button) return;

    button.addEventListener("click", () => {
      // Defense-in-depth: app.js already hides this button outside Room
      // 101 on every room-state update, but a manual DOM tamper or a
      // missed update should never be able to start a support call
      // outside the Customer Service room either.
      if (typeof currentRoomId !== "undefined" && currentRoomId !== "101") return;
      if (state.active) {
        setOverlay(true);
        return;
      }
      startCall();
    });

    $("btn-robin-end")?.addEventListener("click", endCall);
    $("btn-robin-mute")?.addEventListener("click", toggleMute);
    $("btn-robin-close")?.addEventListener("click", () => {
      if (state.active) {
        setStatus("Robin is still connected. Tap End Support Call to finish.", "Connected");
        return;
      }
      setOverlay(false);
    });

    setActiveUi(false);

    // Load only the small config endpoint at startup. The Vapi SDK itself is
    // lazy-loaded after the user taps Robin, keeping normal app startup fast.
    try {
      await loadConfig();
    } catch (error) {
      console.warn("[Vapi Robin] config unavailable:", error);
      window.__PINGPONG_VAPI_ENABLED = false;
    }
  }

  window.PingPongRobin = {
    start: startCall,
    stop: endCall,
    isActive: () => state.active,
    onVoiceFailure: null,
    onVoiceStart: null,
    autoStartForCustomerServiceSeat: async () => {
      if (typeof currentRoomId !== "undefined" && currentRoomId !== "101") return false;
      if (typeof mySeatNumber !== "undefined" && mySeatNumber == null) return false;
      // Mobile networks/tunnels can make the first config or SDK request slow.
      // Retry automatically while the customer remains seated; never show a
      // popup and never require a Start button.
      for (let attempt = 1; attempt <= 5; attempt++) {
        if (typeof currentRoomId !== "undefined" && currentRoomId !== "101") return false;
        if (typeof mySeatNumber !== "undefined" && mySeatNumber == null) return false;
        const ok = await startCall();
        if (ok || state.active) return true;
        if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
      console.warn("[Vapi Robin] automatic Customer Service start exhausted retries while seated");
      return false;
    },
    // Seat/room lifecycle can call this without exposing any call controls.
    autoStopForCustomerServiceSeat: async () => endCall()
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
