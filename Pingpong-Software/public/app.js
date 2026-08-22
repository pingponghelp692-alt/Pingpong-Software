/* ==========================================================================
   PingPong frontend — talks to server.js exactly as written.
   ========================================================================== */

// ---------------------------------------------------------------------------
// Global crash safety net (audit fix, 2026-07-29).
// This file has a documented history of a single uncaught exception ANYWHERE
// in top-level script execution silently aborting everything below it,
// including the bootstrap()/login-restore call at the very bottom (see the
// "fatal crash on every page load" and "settings-icon-does-nothing" fix
// notes further down for two real past incidents of exactly this). Per-call
// try/catch has been added at every known past failure point, but that only
// protects against failures we've already seen once. This block is placed
// as the very first executable code in the file, before anything else that
// could throw, so it is guaranteed to register regardless of what happens
// later in the script:
//   1. Logs every uncaught error/rejection clearly to the console instead of
//      failing silently, so a future issue is diagnosable from one refresh
//      instead of a multi-round guessing process.
//   2. A watchdog: if no view has become visible within 6s of the page
//      loading (the one observable symptom every past "silent crash" case
//      shared), force the login screen instead of leaving the user on a
//      frozen/blank page that looks like nothing happened.
// This changes no normal-path behavior — enterApp()/bootstrap() already
// show a view almost immediately, so the watchdog never fires in the
// working case.
(function () {
  window.addEventListener("error", (e) => {
    console.error("[GLOBAL ERROR]", e.message, "at", e.filename + ":" + e.lineno);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[GLOBAL ERROR] unhandled promise rejection:", e.reason);
  });
  setTimeout(() => {
    const anyViewVisible = document.querySelector(".view.active");
    if (!anyViewVisible) {
      console.error("[WATCHDOG] no view became visible within 6s of page load — a top-level script error likely aborted bootstrap(); forcing login screen instead of leaving a blank page.");
      const loginView = document.getElementById("view-login");
      if (loginView) loginView.classList.add("active");
    }
  }, 6000);
})();

const API = ""; // same-origin
const GIFT_CATALOG_CACHE = { gifts: [] };
const DEFAULT_ROOM_THEME_URL = "/images/room-default-theme.jpg";

function applyRoomBackground(url) {
  const view = $("view-room");
  if (!view) return;
  const background = url || DEFAULT_ROOM_THEME_URL;
  view.style.backgroundImage = `url("${background}")`;
  view.classList.toggle("room-default-theme", !url);
}

const VIDEO_GIFT_CATALOG_CACHE = { gifts: [] };
// Full-screen video gift playback queue — if several arrive at once, they
// play one after another instead of overlapping.
const videoGiftQueue = [];
let videoGiftPlaying = false;
// Vehicle Entry System (add-on) — same one-at-a-time full-screen queue
// pattern as Video Gifts above, kept completely separate so a burst of
// room joins never fights with a Video Gift for the overlay.
const vehicleEntryQueue = [];
let vehicleEntryPlaying = false;

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let me = null;
let socket = null;
let currentRoom = null;
let currentRoomId = null;
// ROOT-CAUSE FIX (2026-08-14, reconnect / duplicate join-room / room-switch
// audit): three pieces of join-lifecycle state that did not exist before.
// - joinedRoomId: the room this socket has actually completed a join for
//   (server has ack'd via "room-state" for THIS join). currentRoomId, by
//   contrast, is set optimistically the instant the user taps a room and is
//   also used for other bookkeeping (saveActiveRoom, etc.) — it is not safe
//   to reuse as an idempotency key.
// - joinInProgress: true while a join-room request is in flight (covers
//   both the synchronous local-room ack and any brief round trip), so a
//   double-tap or a rapid-fire reconnect cannot emit a second "join-room"
//   on top of one that hasn't been acknowledged yet.
// - pendingJoinRequest: if the user taps ANOTHER room while a join is still
//   in flight, only the LAST tap is remembered and is dispatched once the
//   in-flight one resolves — earlier taps are dropped so rapid room-switch
//   tapping (A -> B -> A) never races and only the final destination wins.
let joinedRoomId = null;
let joinInProgress = false;
let pendingJoinRequest = null;
let mySeatNumber = null;
let seatMap = {};
let localStream = null;
let micEnabled = false;

// Bug fix (Robin/Vapi voice conflict, 2026-08-12): Robin's own call
// (public/vapi-support.js, via Daily.co) needs the physical microphone for
// the duration of the support call. If the user is also seated with an
// active PingPong room-voice mic (mesh mode: localStream; SFU mode:
// window.PingPongVoiceSFU), two independent subsystems opening the same
// hardware mic at once can fail on some devices. This pauses (mutes, does
// NOT stop/unpublish) whichever subsystem currently owns the mic, and
// restores it after Robin's call ends — room voice connection/seat state
// is never touched, only the hardware track's enabled flag.
function pingpongPauseRoomMicForRobin() {
  try {
    if (window.PingPongVoiceSFU?.isConnected?.()) {
      window.PingPongVoiceSFU.pauseMicForRobin?.();
    }
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
    }
  } catch (_) { /* best-effort only, never block Robin's own call */ }
}
function pingpongResumeRoomMicAfterRobin() {
  try {
    if (window.PingPongVoiceSFU?.isConnected?.()) {
      window.PingPongVoiceSFU.resumeMicAfterRobin?.();
    }
    // Only restore the mesh mic if the user is still actually seated with
    // mic enabled — don't turn a mic back on the user had already muted.
    if (localStream && micEnabled) {
      localStream.getAudioTracks().forEach((t) => { t.enabled = true; });
    }
  } catch (_) { /* best-effort only */ }
}
window.PingPongRoomVoice = {
  pauseMicForRobin: pingpongPauseRoomMicForRobin,
  resumeMicAfterRobin: pingpongResumeRoomMicAfterRobin
};
const peerConnections = {};
// Official AI Customer Service Room 101 state. Kept isolated from normal
// room voice state so the existing 8-seat WebRTC topology is untouched.
let cs101History = [];
let cs101Recognition = null;
let cs101Listening = false;
// Phase 1 / Tier A: userIds the server says are inside their reconnect
// grace period (see voice-peer-reconnecting/voice-peer-resumed above) —
// consulted by getOrCreatePeer()'s ICE-failure handling so a brief drop
// doesn't get torn down and rebuilt from scratch mid-recovery.
const reconnectingPeerUserIds = new Set();
const remoteAudioEls = {};
const speakingUsers = new Set(); // userIds currently detected as speaking (real-time)

// Phase 3 / Step 3.3: which voice transport this client should use for the
// CURRENT room. "mesh" is the safe default (matches the server's own
// currentVoiceMode() fail-safe in voice_sfu/provider.js) until
// refreshVoiceMode() actually resolves, and stays "mesh" forever on any
// deployment that never sets VOICE_MODE=sfu server-side — the mesh code
// below (peerConnections, connectToPeer(), getOrCreatePeer(), etc.) is
// completely unmodified and remains the only thing that ever runs in that
// case. sfuConnected only tracks THIS client's own LiveKit Room lifecycle
// (see public/voice-sfu.js); it is not room/seat authority.
let voiceMode = "mesh";
let sfuConnected = false;

let followListMode = "followers";
let threadPeerId = null;
let threadPeerName = null;
let threadPeerPhoto = "";

// ---------------------------------------------------------------------------
// First Time Profile Setup — country/language catalogue cache (fetched once
// from GET /api/meta/countries, the same list the server validates against)
// ---------------------------------------------------------------------------
let COUNTRIES_CACHE = [];
async function loadCountriesCache() {
  if (COUNTRIES_CACHE.length) return COUNTRIES_CACHE;
  const r = await api("/api/meta/countries", "GET");
  if (r.success) COUNTRIES_CACHE = r.countries;
  return COUNTRIES_CACHE;
}
// Regional-indicator flag emoji from an ISO country code — same computation
// as countries.js server-side, kept in sync manually since it's one line.
function flagEmoji(code) {
  if (!code || code.length !== 2) return "";
  return code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
}

// ---------------------------------------------------------------------------
// YouTube Room Player — state
// ---------------------------------------------------------------------------
let ytPlayer = null;             // YT.Player instance, created lazily on first use
let ytApiReady = false;          // set true by window.onYouTubeIframeAPIReady
let ytPendingLoad = null;        // { videoId, position, isPlaying } queued if player not ready yet
let ytCurrentPlaylist = [];
let ytPlayerState = { mode: false, currentIndex: -1, isPlaying: false, position: 0, updatedAt: Date.now() };
let canControlYt = false;        // owner/admin of the current room
let ytDriftTimer = null;         // owner-side periodic position broadcast while playing
let ytSuppressEvents = false;    // true while we're programmatically seeking/loading, so onStateChange doesn't re-broadcast our own remote update

// ---------------------------------------------------------------------------
// Fix (pinch/double-tap zoom bug): some mobile browsers/WebViews still let
// people zoom the page even with user-scalable=no and touch-action set —
// which breaks every fixed-position overlay (room TV screen, modals, the
// bottom toolbar). This is a hard JS-level safety net on top of those:
// block any multi-finger touch move, any native pinch gesture, and any
// double-tap that's fast enough to be a zoom tap rather than two real taps.
document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener("gesturestart", (e) => e.preventDefault());
let __lastTouchEndTs = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - __lastTouchEndTs <= 300) e.preventDefault();
  __lastTouchEndTs = now;
}, { passive: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

// ---------------- Panel exclusivity (UI-only, no feature/backend change) ----------------
// Every full-screen panel (Gift / Music / YouTube playlist / Chest info /
// Room Game) is mutually exclusive: opening one always closes any other
// that happens to be open first, so the room never shows two overlays
// stacked on top of each other. This only toggles the existing "hidden"
// class / calls the existing close functions for each panel — it does not
// change what any panel does once open.
const EXCLUSIVE_PANEL_IDS = ["modal-gift", "modal-music", "modal-yt-playlist", "modal-chest-info", "modal-chest-reward", "modal-room-ranking", "modal-level-info", "room-more-menu"];
function closeAllPanels(exceptId) {
  EXCLUSIVE_PANEL_IDS.forEach((id) => {
    if (id === exceptId) return;
    const el = $(id);
    if (el && !el.classList.contains("hidden")) el.classList.add("hidden");
  });
  if (exceptId !== "room-tv-screen") {
    const tv = $("room-tv-screen");
    if (tv && tv.classList.contains("tv-open")) closeRoomGame();
  }
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(id).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(`.nav-btn[data-nav="${navKeyFor(id)}"]`).forEach((b) => b.classList.add("active"));
  // 3D Animated Room Header: play the one-shot "drop-in" entrance every
  // time the room view becomes active (fresh join, rejoin, or coming back
  // from a sub-screen). Re-triggering an already-applied CSS animation
  // needs a reflow in between remove/add, otherwise the browser just
  // no-ops the second time.
  if (id === "view-room") {
    const topbar = document.querySelector(".room-topbar");
    if (topbar) {
      topbar.classList.remove("header-enter-3d");
      void topbar.offsetWidth;
      topbar.classList.add("header-enter-3d");
    }
  }
}

// Wallet iframe back bridge: wallet-ui.html runs in the same origin but inside
// an iframe, so its back button asks the parent app to return to Home.
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data && event.data.type === "PINGPONG_CLOSE_WALLET") {
    showView("view-home");
  }
});
function navKeyFor(viewId) {
  return { "view-home": "home", "view-inbox": "inbox", "view-profile": "profile" }[viewId] || "";
}

// Phase 14 (client): session token issued at login, resolved server-side to
// the real logged-in mobile. Attached automatically to every api()/
// apiUpload() call below so identity-sensitive endpoints (migrated one
// group at a time — see server.js Phase 14/15 comments) can trust it
// instead of a client-supplied mobile/userId. Old server builds that don't
// look for this header simply ignore it — fully backward compatible.
let authToken = null;

async function api(path, method = "GET", body = null, headers = {}, _retried = false) {
  try {
    const authHeaders = authToken ? { "Authorization": "Bearer " + authToken } : {};
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json();
    // Server-side token expiry/invalidations respond 401 + forceLogout so a
    // stale client doesn't keep silently failing every subsequent action.
    //
    // FIX (auto-logout-on-refresh, take 3): this used to force-clear the
    // session and bounce to the login screen the INSTANT any authenticated
    // call got a 401 — no retry, no Logout Lock check — unlike bootstrap()'s
    // much more careful handling of the exact same "is this session really
    // dead" question. Right after a refresh, enterApp() fires several
    // authenticated calls (wallet, treasure, etc.) in parallel with
    // bootstrap()'s own validation call, so a single brief glitch on any ONE
    // of them was enough to log someone out — even with a perfectly valid
    // account and token. Now this mirrors bootstrap(): retry once after a
    // short pause, and only then honor Logout Lock exactly the way it
    // already works there. This is always a stale/expired-token case, never
    // a real ban — bans are pushed live via the separate "kicked" socket
    // event (see its handler) and are correctly unaffected by Logout Lock.
    if (res.status === 401 && data && data.forceLogout) {
      if (!_retried) {
        await new Promise((r) => setTimeout(r, 500));
        return api(path, method, body, headers, true);
      }
      if (isLogoutLockOn()) {
        console.log("[SESSION] 401 forceLogout ignored — Logout Lock is ON:", path);
        return data;
      }
      // BUG FIX (refresh-logout / settings-not-opening root cause, 2026-07-29):
      // clearSession() used to run here with no navigation change at all.
      // That leaves `me` as null while the user visually stays on whatever
      // screen they were on (Home, a room, etc.) — every other handler in
      // this file that reads me.xxx (e.g. the Room Settings gear at
      // btn-room-mod, which reads me.userId) then throws silently and does
      // nothing when tapped, which is exactly what "touching Settings shows
      // no features" looks like from the outside. And because localStorage
      // was already wiped, the NEXT refresh finds no cached session and
      // bootstrap() shows the login screen — which is what "refresh keeps
      // sending me back to login" actually was: the session was silently
      // killed by an earlier background call, not by the refresh itself.
      // Now this mirrors the "kicked" socket handler above: clearing the
      // session always immediately shows the login view too, so the app
      // state and the screen never disagree with each other.
      showDebugBadge("SESSION CLEARED BY A BACKGROUND CALL (401 forceLogout) at path=" + path + ". THIS IS A DIFFERENT CODE PATH FROM BOOTSTRAP — it means an already-logged-in session was killed by some OTHER api() call (not the initial page-load check). message=" + (data.message || "(none)"));
      clearSession("auth-token-invalid");
      if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
      showView("view-login");
      toast(data.message || "Session expired — please log in again");
    }
    return data;
  } catch (err) {
    toast("Network problem occurred");
    return { success: false, message: "network error", networkError: true };
  }
}

async function apiUpload(path, formData, headers = {}) {
  try {
    const authHeaders = authToken ? { "Authorization": "Bearer " + authToken } : {};
    const res = await fetch(API + path, { method: "POST", body: formData, headers: { ...authHeaders, ...headers } });
    return await res.json();
  } catch (err) {
    toast("Upload problem occurred");
    return { success: false, message: "network error", networkError: true };
  }
}

function vipClass(level) { return "vip-" + Math.max(0, Math.min(5, Number(level) || 0)); }
function applyVipBadge(el, level) {
  el.className = "vip-badge " + vipClass(level);
  el.textContent = "VIP " + (Number(level) || 0);
}
// Custom ID Number (Admin-assigned, "Golden Light" style) — shown instead of
// the permanent userId wherever a user's ID is displayed. The real userId
// keeps working everywhere else internally (copy-ID, follow, gifts, etc.);
// this only swaps what's rendered in the ID text itself.
// Country flag shown right next to the ID — computed from the user's own
// selected country (First Time Profile Setup), so it's the actual flag of
// wherever that account is from rather than any one hardcoded flag.
function countryFlagPrefix(user) {
  if (!user || !user.country) return "";
  const flag = flagEmoji(user.country);
  return flag ? `<span class="id-flag" title="${escapeHtml(user.country)}">${flag}</span> ` : "";
}
function applyIdDisplay(el, user) {
  if (!el) return;
  const idText = user && user.customId ? user.customId : (user ? user.userId : "");
  el.innerHTML = countryFlagPrefix(user) + escapeHtml(idText);
  el.classList.toggle("custom-id-golden", !!(user && user.customId));
}
// Admin-uploaded SVIP PNG tag, shown right next to the VIP badge — exactly
// like the VIP logo, in the same spot, using whatever PNG Admin uploaded
// for the user's current SVIP level (no separate demo image).
function applySvipTag(el, resources) {
  if (!el) return;
  const url = resources && resources.tag;
  if (url) {
    const v = resources.tagVersion ? ("?v=" + resources.tagVersion) : "";
    el.src = url + v;
    el.classList.remove("hidden");
  } else {
    el.removeAttribute("src");
    el.classList.add("hidden");
  }
}
async function refreshSvipTagFor(userId, el) {
  if (!userId || !el) return;
  const r = await api("/api/svip/status/" + userId);
  if (r.success) applySvipTag(el, r.resources);
}
// "Me" specifically also updates `me.svipLevel` + is what the real-time
// svip_level_changed/svip_resource_update socket handlers call to refresh
// both places my own tag shows (home chip + profile) at once.
async function refreshMySvipTag() {
  if (!me) return;
  const r = await api("/api/svip/status/" + me.userId);
  if (r.success) {
    me.svipLevel = r.svipLevel;
    applySvipTag($("home-svip-tag"), r.resources);
    applySvipTag($("profile-svip-tag"), r.resources);
  }
}
// Admin-assigned coloured tag (e.g. "VIP") shown next to a username.
// `small` renders the compact inline variant used in chat/seats instead of
// the full pill used on profile screens.
function tagTextColor(hex) {
  const h = (hex || "").replace("#", "");
  if (h.length !== 6) return "#1c1424";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#1c1424" : "#fbf6ea";
}
function applyCustomTag(el, tag, small) {
  if (!el) return;
  el.className = "tag-badge" + (small ? " tag-badge-sm" : "");
  if (tag && tag.text) {
    el.textContent = tag.text;
    el.style.background = tag.color || "#F7CE7E";
    el.style.color = tagTextColor(tag.color);
    el.classList.remove("hidden");
  } else {
    el.textContent = "";
    el.classList.add("hidden");
  }
}
function applyFrameRing(wrapEl, level) {
  wrapEl.className = wrapEl.className.replace(/\bvip-\d\b/g, "").trim();
  wrapEl.classList.add(vipClass(level));
}
// Admin-issued custom PNG frame overlay — decorates the avatar without
// ever resizing it (absolutely positioned, own layer, see CSS).
function applyCustomFrame(wrapEl, activeFrame) {
  if (!wrapEl) return;
  const existing = wrapEl.querySelector(".custom-frame-img");
  if (activeFrame && activeFrame.imageUrl) {
    wrapEl.classList.add("has-custom-frame");
    if (existing) existing.src = activeFrame.imageUrl;
    else {
      const img = document.createElement("img");
      img.className = "custom-frame-img";
      img.src = activeFrame.imageUrl;
      img.alt = "";
      wrapEl.appendChild(img);
    }
  } else {
    wrapEl.classList.remove("has-custom-frame");
    if (existing) existing.remove();
  }
}

// Premium badge catalog cache (id -> {imageUrl, seatSize, profileSize}) —
// SIZE ADJUSTMENT (2026-08-05): sizes are now admin-configurable from the
// panel (badges.js /api/badges/size), so the client fetches current px
// values instead of using the fixed CSS defaults. Those CSS defaults
// (.seat-blue-badge 16px, .profile-blue-badge 72px) stay as a safe
// fallback if this fetch hasn't completed yet or fails.
let badgeCatalogCache = {};
async function primeBadgeCatalog() {
  try {
    const r = await api("/api/badges/catalog");
    if (r.success && Array.isArray(r.catalog)) {
      badgeCatalogCache = {};
      r.catalog.forEach((b) => { badgeCatalogCache[b.id] = b; });
    }
  } catch (e) { /* keep whatever was cached, CSS defaults still apply */ }
}
primeBadgeCatalog();

// Premium badge display (Blue Diamond V etc., admin-granted only — see
// badges.js). Only shows an element that's already sitting hidden in the
// markup (public/index.html) — no DOM created here, just toggled.
function applyBlueBadge(el, activeBadges) {
  if (!el) return;
  const has = Array.isArray(activeBadges) && activeBadges.includes("blue_diamond_v");
  el.classList.toggle("hidden", !has);
  if (has) {
    const cfg = badgeCatalogCache.blue_diamond_v;
    if (cfg && cfg.profileSize) { el.style.width = cfg.profileSize + "px"; el.style.height = cfg.profileSize + "px"; }
  }
}

function saveSession() {
  console.log("[SESSION] saveSession ->", me ? { mobile: me.mobile, userId: me.userId } : null);
  localStorage.setItem("pp_user", JSON.stringify(me));
  if (authToken) localStorage.setItem("pp_auth_token", authToken);
}
function loadSession() {
  const raw = localStorage.getItem("pp_user");
  console.log("[SESSION] loadSession raw pp_user present:", !!raw);
  if (raw) { try { me = JSON.parse(raw); } catch (e) { console.log("[SESSION] loadSession JSON.parse failed:", e); me = null; } }
  authToken = localStorage.getItem("pp_auth_token") || null;
}
function clearSession(reason) {
  console.log("[SESSION] clearSession called, reason:", reason);
  // Best-effort server-side revoke so a copied/leaked token stops working
  // immediately rather than just sitting idle until its own expiry. Fire
  // and forget — logout must not be blocked by a slow/failed network call.
  if (authToken) {
    fetch(API + "/api/auth/logout", {
      method: "POST",
      headers: { "Authorization": "Bearer " + authToken }
    }).catch(() => {});
  }
  localStorage.removeItem("pp_user");
  localStorage.removeItem("pp_auth_token");
  saveActiveRoom(null);
  me = null;
  authToken = null;
  // FIX (requirement #4 — if refresh fails, sign out of Firebase and clear
  // ALL cached auth data): the app's own pp_* keys are cleared above; this
  // additionally signs out of Firebase itself and sweeps its own
  // "firebase:"-prefixed localStorage/sessionStorage keys, so a dead
  // Firebase session can never linger and cause the next login attempt to
  // fail again for the same reason. Guarded because clearSession() can run
  // before firebaseClient.js has finished loading (e.g. a very early boot
  // error) — this must never be why a logout fails.
  if (window.ppFirebaseAuth && window.ppFirebaseAuth.fullFirebaseSignOut) {
    window.ppFirebaseAuth.fullFirebaseSignOut().catch((err) => console.error("[SESSION] fullFirebaseSignOut failed:", err));
  }
}

// Feature: Logout Lock (Profile screen toggle). When ON, the app will not
// clear a saved login on its own for any reason short of the user tapping
// Logout themselves — specifically the "account temporarily unreachable"
// case in bootstrap() below. It deliberately does NOT protect against a
// real ban/account-deletion pushed by an admin (see socket.on("kicked",…)):
// that's a moderation action, not an accidental logout, and letting a
// client-side toggle block it would let anyone dodge a ban just by turning
// this on first.
function isLogoutLockOn() { return localStorage.getItem("pp_logout_lock") === "1"; }
function setLogoutLock(on) { localStorage.setItem("pp_logout_lock", on ? "1" : "0"); }
const logoutLockToggleEl = document.getElementById("toggle-logout-lock");
if (logoutLockToggleEl) {
  logoutLockToggleEl.addEventListener("change", (e) => {
    setLogoutLock(e.target.checked);
    toast(e.target.checked ? "Logout Lock enabled 🔒" : "Logout Lock disabled");
  });
}

// ---------------------------------------------------------------------------
// God Power System (Super Admin panel feature) — client side.
// Shows the 5s grant/revoke popup, and (only for is_invisible holders)
// the Invisible toggle on the Profile screen.
// ---------------------------------------------------------------------------
function showGodPowerPopup(text, kind) {
  const el = document.createElement("div");
  el.className = "godpower-popup" + (kind === "revoke" ? " revoke" : "");
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 5000);
}
function refreshGodPowerInvisibleRow() {
  const row = $("row-godpower-invisible");
  const toggle = $("toggle-godpower-invisible");
  if (!row || !toggle) return;
  const eligible = !!(me && me.is_invisible);
  row.classList.toggle("hidden", !eligible);
  if (eligible) toggle.checked = !!me.invisibleActive;
}
const godPowerInvisibleToggleEl = document.getElementById("toggle-godpower-invisible");
if (godPowerInvisibleToggleEl) {
  godPowerInvisibleToggleEl.addEventListener("change", () => {
    socket.emit("toggle-invisible");
  });
}

// Fix (session/room loss on refresh): currentRoomId previously lived only
// in a JS variable, so refreshing the page while inside a voice room reset
// it to null — the user landed back on the home screen even though their
// login session was completely fine, which read as "got logged out". We
// now persist which room the user was in and rejoin it automatically once
// the socket reconnects (see connectSocket()'s "connect" handler below).
function saveActiveRoom(roomId) {
  if (roomId) {
    localStorage.setItem("pp_room", roomId);
    // Timestamp lets bootstrap() below tell "this is a refresh/reconnect
    // gap, rejoin seamlessly" apart from "the app was closed and reopened
    // much later, don't silently drop them into a stale room" — see
    // loadActiveRoomIfFresh().
    localStorage.setItem("pp_room_ts", String(Date.now()));
  } else {
    localStorage.removeItem("pp_room");
    localStorage.removeItem("pp_room_ts");
  }
}
function loadActiveRoom() { return localStorage.getItem("pp_room"); }

// FIX (room lost on browser refresh, 2026-07-29): the "Auto-Join Room bug"
// fix elsewhere in this file made bootstrap() stop calling loadActiveRoom()
// at all, to stop the app from silently dropping a user into whatever room
// they happened to be in the LAST time they used the app, even hours/days
// later with no tap. That fixed the unwanted case, but as a side effect it
// also killed the wanted case: a person mid-conversation in a room hits
// browser refresh (or the app reloads after a crash/deploy) and lands on
// Home instead of seamlessly back in their room/seat — even though the
// server-side 8s grace period (server.js pendingDisconnects) was designed
// to hold their seat open for exactly this. The room was never actually
// "lost" server-side; the client just stopped asking to go back.
//
// Fix: bring loadActiveRoom() back into bootstrap(), but gate it on
// freshness via the pp_room_ts timestamp (kept rolling by a heartbeat —
// see the setInterval near connectSocket()). A refresh happens seconds
// after the timestamp was last written, so it passes; an app reopened
// after being closed for a long time does not, and falls back to Home
// exactly like before.
const ROOM_REJOIN_FRESHNESS_MS = 20000; // comfortably covers the 8s server grace period + slow-network bootstrap time
function loadActiveRoomIfFresh() {
  const roomId = localStorage.getItem("pp_room");
  if (!roomId) return null;
  const ts = Number(localStorage.getItem("pp_room_ts") || 0);
  if (!ts || Date.now() - ts > ROOM_REJOIN_FRESHNESS_MS) {
    saveActiveRoom(null); // stale marker — don't let it resurface on some later boot either
    return null;
  }
  return roomId;
}

// ===========================================================================
// AUTH — Self-hosted Mobile OTP (own server + local SMS gateway) + Google Sign-In
// ===========================================================================
// Password login UI has been removed (server-side password endpoints are
// untouched). Mobile Number + OTP card below now talks directly to this
// server's own /api/auth/send-otp and /api/auth/verify-otp (see
// security/otpService.js + sms/gateway.js) — no Firebase, no third-party
// SMS provider is involved in the OTP flow. "Continue with Google" is
// unchanged and still goes through Firebase (see firebaseClient.js).
let lastOtpMobile = "";
let otpResendTimer = null;

function startOtpResendCountdown(seconds) {
  const btn = $("btn-resend-otp");
  if (!btn) return;
  clearInterval(otpResendTimer);
  let remaining = seconds;
  const render = () => {
    btn.disabled = remaining > 0;
    btn.textContent = remaining > 0 ? `Resend OTP (${remaining}s)` : "Resend OTP";
  };
  render();
  otpResendTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) clearInterval(otpResendTimer);
    render();
  }, 1000);
}

function showAuthCard(id) {
  ["step-mobile", "step-otp"].forEach((cid) => {
    $(cid).classList.toggle("hidden", cid !== id);
  });
}

// Shared success path — identical shape to the old OTP/password handlers,
// so session storage, socket connect, and app entry all behave exactly as
// before regardless of which door the user came through.
//
// ROOT-CAUSE FIX (requirements #3, #4, #5 — never show "Invalid or expired
// Firebase session" if a silent refresh can fix it): the server tells us
// exactly why a token was rejected via `r.code`. Only "token-expired" is
// something a refresh can fix — a genuinely revoked/malformed token or a
// server config problem cannot, so those still surface immediately.
async function finishFirebaseLogin(idToken, isRetry) {
  const r = await api("/api/auth/firebase-login", "POST", { idToken });
  if (r.success) {
    me = r.user;
    authToken = r.authToken || authToken;
    saveSession();
    connectSocket();
    enterApp();
    return;
  }
  if (!isRetry && r.code === "token-expired" && window.ppFirebaseAuth && window.ppFirebaseAuth.getFreshIdTokenIfPossible) {
    console.log("[FIREBASE-AUTH] server reported an expired token — attempting one silent refresh before showing anything to the user");
    const freshToken = await window.ppFirebaseAuth.getFreshIdTokenIfPossible();
    if (freshToken) {
      return finishFirebaseLogin(freshToken, true); // retry exactly once
    }
  }
  // Refresh wasn't possible or didn't help (or this IS the retry and it
  // still failed) — requirement #4: a Firebase session that can't be
  // salvaged is fully cleared, not left half-alive to fail the same way
  // again on the next attempt.
  if (window.ppFirebaseAuth && window.ppFirebaseAuth.fullFirebaseSignOut) {
    window.ppFirebaseAuth.fullFirebaseSignOut().catch(() => {});
  }
  console.error("[FIREBASE-AUTH] firebase-login failed:", r.code, r.message);
  toast(r.message || "Login failed");
}

async function requestOtp(mobile) {
  const r = await api("/api/auth/send-otp", "POST", { mobile });
  if (r.success) {
    lastOtpMobile = mobile;
    $("otp-mobile-display").textContent = mobile;
    showAuthCard("step-otp");
    startOtpResendCountdown(60);
  } else if (r.code === "resend-cooldown" && r.retryAfterSec) {
    // A valid OTP is already outstanding for this number — go straight to
    // the OTP screen and resume its countdown instead of showing an error.
    lastOtpMobile = mobile;
    $("otp-mobile-display").textContent = mobile;
    showAuthCard("step-otp");
    startOtpResendCountdown(r.retryAfterSec);
    toast(r.message || "Please wait before requesting another OTP");
  } else {
    toast(r.message || "Could not send OTP — try again");
  }
  return r;
}

$("btn-send-otp").addEventListener("click", async () => {
  const mobile = $("mobile-input").value.trim();
  if (mobile.length !== 10) { toast("Enter a valid 10-digit number"); return; }
  await requestOtp(mobile);
});

$("btn-resend-otp") && $("btn-resend-otp").addEventListener("click", async () => {
  if (!lastOtpMobile) return;
  await requestOtp(lastOtpMobile);
});

$("btn-back-mobile").addEventListener("click", () => {
  showAuthCard("step-mobile");
});

$("btn-verify-otp").addEventListener("click", async () => {
  const otp = $("otp-input").value.trim().replace(/[০-৯]/g, d => String("০১২৩৪৫৬৭৮৯".indexOf(d)));
  if (!otp) { toast("Enter the OTP"); return; }
  if (!lastOtpMobile) { toast("Request an OTP first"); showAuthCard("step-mobile"); return; }
  try {
    const r = await api("/api/auth/verify-otp", "POST", { mobile: lastOtpMobile, otp });
    if (r.success) {
      me = r.user;
      authToken = r.authToken || authToken;
      saveSession();
      connectSocket();
      enterApp();
      return;
    }
    // expired / too-many-attempts / not-found -> back to the mobile step so
    // the user requests a fresh OTP; wrong-otp -> let them retry in place.
    if (r.code === "expired" || r.code === "too-many-attempts" || r.code === "not-found") {
      showAuthCard("step-mobile");
    }
    toast(r.message || "Wrong or expired OTP");
  } catch (err) {
    console.error("[OTP-AUTH] verify-otp failed:", err);
    toast("Network error — try again");
  }
});

$("btn-google-login").addEventListener("click", async () => {
  try {
    const idToken = await window.ppFirebaseAuth.signInWithGoogle();
    await finishFirebaseLogin(idToken);
  } catch (err) {
    console.error("[FIREBASE-AUTH] signInWithGoogle failed:", err);
    // Popup closed by the user is not a real error — no toast needed.
    if (err.code !== "auth/popup-closed-by-user") toast(err.message || "Google sign-in failed");
  }
});

// ===========================================================================
// SCREEN WAKE LOCK
// ===========================================================================
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (e) { /* not supported / denied — fail silently */ }
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && me) await requestWakeLock();
  // ROOT-CAUSE FIX (2026-08-11, Phase 3 item #2 — "seated speaker stays
  // silent after prolonged backgrounding"): some mobile browsers (most
  // reliably iOS Safari; Android under memory pressure can do the same)
  // end the getUserMedia mic track outright while the tab/app is
  // backgrounded for a while, rather than only dropping the Socket.IO
  // connection. `localStream` then keeps referencing a now-dead
  // MediaStreamTrack (readyState "ended"). Neither the mesh path
  // (ensureLocalTracksSent()'s `hasAudioSender` check still sees a
  // sender already holding that dead track, so it does nothing) nor the
  // SFU seated-speaker self-heal added above this file's room-state
  // handler can recover a live mic from a truthy-but-dead `localStream` —
  // both only check "do we have a stream", not "is the track still
  // live". On resume, if we're seated and the current track has actually
  // ended, drop the stale reference so the normal init path (same one a
  // fresh seat-take already uses) re-acquires a real track and
  // reconnects, instead of silently doing nothing.
  if (document.visibilityState === "visible" && mySeatNumber !== null && currentRoomId) {
    const track = localStream && localStream.getAudioTracks()[0];
    if (track && track.readyState === "ended") {
      console.warn("[voice] mic track ended while backgrounded — re-acquiring");
      localStream = null;
      await initMicIfNeeded();
      ensureLocalTracksSent(); // no-op in SFU mode (peerConnections stays empty there) — mirrors the existing room-state handler's own call pattern
    }
  }
});

function enterApp() {
  applyLanguage(me && me.language);
  // First Time Profile Setup — a brand-new account lands here first no
  // matter which entry point logged them in (OTP or password), and this
  // check runs every time enterApp() is reached (including bootstrap on
  // refresh) so a half-finished setup can never be skipped by accident.
  // Once profile_completed flips to true on the server, this branch is
  // never hit again for that account.
  if (me && me.profile_completed === false) {
    showProfileSetupScreen();
    return;
  }
  fillHomeProfile();
  const lockToggle = $("toggle-logout-lock");
  if (lockToggle) lockToggle.checked = isLogoutLockOn();
  loadRoomList();
  loadActiveSocialTab();
  loadAnnouncements();
  requestWakeLock();
  showView("view-home");
}

// ===========================================================================
// FIRST TIME PROFILE SETUP (new user only) — also reused by Edit Profile
// ===========================================================================
let psSelectedGender = null;

function buildCountryOptions(selectEl, selectedId) {
  selectEl.innerHTML = '<option value="" disabled selected hidden>...</option>';
  COUNTRIES_CACHE.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `${c.flag} ${c.name_bn} (${c.name_en})`;
    if (c.id === selectedId) opt.selected = true;
    selectEl.appendChild(opt);
  });
}
function buildLanguageOptions(selectEl, countryId, selectedLang) {
  const country = COUNTRIES_CACHE.find((c) => c.id === countryId);
  selectEl.innerHTML = "";
  (country ? country.languages : []).forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = l.name;
    if (l.code === selectedLang) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

function setGenderPills(rowEl, gender) {
  rowEl.querySelectorAll(".ps-gender-pill").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.gender === gender);
    btn.onclick = () => {
      rowEl.querySelectorAll(".ps-gender-pill").forEach((b) => b.classList.remove("selected"));
      btn.classList.add("selected");
      rowEl.dataset.selected = btn.dataset.gender;
    };
  });
  rowEl.dataset.selected = gender || "";
}

let usernameCheckTimer = null;
function wireUsernameCheck(inputEl, statusEl) {
  inputEl.addEventListener("input", () => {
    clearTimeout(usernameCheckTimer);
    const val = inputEl.value.trim();
    if (!val) { statusEl.textContent = ""; statusEl.className = "ps-field-status"; return; }
    statusEl.textContent = "Checking...";
    statusEl.className = "ps-field-status";
    usernameCheckTimer = setTimeout(async () => {
      const r = await api("/api/user/check-username", "POST", { username: val });
      if (r.success && r.available) {
        statusEl.textContent = "✓ Available";
        statusEl.className = "ps-field-status ok";
      } else {
        statusEl.textContent = (r.message) || "Not available";
        statusEl.className = "ps-field-status err";
      }
    }, 450);
  });
}

async function showProfileSetupScreen() {
  await loadCountriesCache();
  $("ps-avatar-preview").src = me.photo || placeholderAvatar(me.name);
  $("ps-username").value = "";
  $("ps-username-status").textContent = "";
  setGenderPills($("ps-gender-row"), null);
  buildCountryOptions($("ps-country"), null);
  $("ps-language").innerHTML = "";
  showView("view-profile-setup");
}

wireUsernameCheck($("ps-username"), $("ps-username-status"));

$("ps-country").addEventListener("change", () => {
  buildLanguageOptions($("ps-language"), $("ps-country").value, null);
});

// Avatar: tapping the edit button opens a small sheet offering Camera vs
// Gallery (guideline Section 1) — Skip is always fine, a default avatar is
// used, and it can be added later from Edit Profile.
$("ps-avatar-btn").addEventListener("click", () => $("ps-photo-sheet").classList.toggle("hidden"));
$("ps-photo-sheet-close").addEventListener("click", () => $("ps-photo-sheet").classList.add("hidden"));
$("ps-pick-camera").addEventListener("click", () => { $("ps-photo-sheet").classList.add("hidden"); $("ps-photo-camera").click(); });
$("ps-pick-gallery").addEventListener("click", () => { $("ps-photo-sheet").classList.add("hidden"); $("ps-photo-gallery").click(); });
async function handlePsPhoto(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("photo", file);
  const r = await apiUpload("/api/user/upload-photo", fd);
  if (r.success) { me.photo = r.url; saveSession(); $("ps-avatar-preview").src = r.url; }
  else toast(r.message || "Upload failed");
}
$("ps-photo-camera").addEventListener("change", (e) => handlePsPhoto(e.target.files[0]));
$("ps-photo-gallery").addEventListener("change", (e) => handlePsPhoto(e.target.files[0]));

$("btn-save-profile-setup").addEventListener("click", async () => {
  const username = $("ps-username").value.trim();
  const gender = $("ps-gender-row").dataset.selected;
  const country = $("ps-country").value;
  const language = $("ps-language").value;
  if (!username) { toast("Enter a Username"); return; }
  if (!gender) { toast("Select a Gender"); return; }
  if (!country) { toast("Select a Country"); return; }
  if (!language) { toast("Select a Language"); return; }
  const r = await api("/api/user/complete-profile", "POST", { username, gender, country, language });
  if (r.success) {
    me = r.user;
    saveSession();
    applyLanguage(me.language);
    toast("Profile saved");
    enterApp();
  } else toast(r.message || "Something went wrong");
});

// ===========================================================================
// SOCKET.IO
// ===========================================================================
// Keeps the pp_room_ts freshness marker (see loadActiveRoomIfFresh()) from
// aging out while someone is genuinely, continuously in a room — only an
// actual gap (refresh, brief disconnect) should ever let it go stale.
setInterval(() => {
  if (currentRoomId && socket && socket.connected) saveActiveRoom(currentRoomId);
}, 5000);

// Phase 3 / Step 3.3: asks the server which voice transport is active
// (GET /api/voice-sfu/mode, added in Step 3.2 — inert until now). Any
// failure (network error, older server without this route, bad JSON)
// leaves voiceMode at its "mesh" default rather than throwing, so a
// broken or missing endpoint can never accidentally send this client down
// an SFU path it can't actually use. Safe to call repeatedly — cheap,
// unauthenticated, no side effects server-side.
async function refreshVoiceMode() {
  try {
    const res = await fetch("/api/voice-sfu/mode");
    const data = await res.json();
    voiceMode = data && data.success && data.voiceMode === "sfu" ? "sfu" : "mesh";
  } catch (e) {
    voiceMode = "mesh";
  }
}

function connectSocket() {
  if (socket) return;
  // FIX (repeated disconnect/rejoin loop, 2026-07-29): this was plain
  // io() with library defaults, which back off between reconnect attempts
  // (starting at 1s, growing up to 5s, and that's on top of however long
  // the attempt itself takes to fail on a bad connection). On a flaky
  // mobile network or a tunnel (ngrok/cloudflared-style, common for a
  // Termux-hosted server), a handful of slow/failed attempts in a row can
  // add up to more than the server's room-seat grace period, so the seat
  // gets freed while the client is still genuinely trying to get back in
  // — which looks exactly like the join→leave→join→leave loop we saw in
  // the server logs. Retrying quickly and persistently (capped at 3s
  // between tries, never giving up) gives every attempt the best realistic
  // chance to land inside the grace window instead of outside it.
  socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 20000,
    transports: ["websocket", "polling"]
  });
  window.socket = socket;
  registerCallSocketEvents();
  chRegisterSocketHandlers();

  socket.on("connect", () => {
    // SECURITY HARDENING (Module 5.1): now also sends authToken so the
    // server can cryptographically verify this identify claim instead of
    // trusting a bare userId — see server.js's identify handler.
    if (me && me.userId) socket.emit("identify", { userId: me.userId, authToken });
    if (currentRoomId === "101") socket.emit("cs101:start");
    // Fire-and-forget: a reconnect (refresh, brief drop) can land back in a
    // room before this resolves, in which case voiceMode simply keeps
    // whatever value it already had (or the "mesh" default) for that one
    // round-trip — never blocks the reconnect itself.
    refreshVoiceMode();
    if (currentRoomId) rejoinRoom();
  });

  // Real winner feed for Food Wheel / Teen Patti (replaces the old fake
  // demo names/tickers with actual players and actual amounts won,
  // sourced from real game-wheel-sync coin gains on the server).
  socket.on("real-win", (entry) => {
    recentWins.unshift(entry);
    if (recentWins.length > 30) recentWins = recentWins.slice(0, 30);
    sendRealWinsToGame();
  });

  socket.on("room-list", renderRoomList);

  // ---- Official AI Customer Service Room 101 ----
  socket.on("cs101:ready", (info) => {
    if (currentRoomId !== "101") return;
    cs101ConfigClient = { ...cs101ConfigClient, ...(info || {}) };
    renderCs101Seat();
    cs101MaybeGreetOnSeat();
  });

  socket.on("cs101:config", (info) => {
    if (!info) return;
    cs101ConfigClient = { ...cs101ConfigClient, ...info };
    renderCs101Seat();
  });

  socket.on("cs101:reply", (payload) => {
    if (currentRoomId !== "101") return;
    cs101AppendMessage("ai", payload.text || "");
    cs101Speak(payload.text || "", payload.voice || {});
  });

  socket.on("cs101:error", () => {
    // Deliberately silent in the customer UI. Failures are logged server-side
    // and the AI can retry without exposing technical errors to the user.
  });
  socket.on("room-ranking-data", (payload) => {
    if (payload.roomId !== currentRoomId) return;
    rankingCache = { daily: payload.daily, weekly: payload.weekly, monthly: payload.monthly };
    if (!$("modal-room-ranking").classList.contains("hidden")) renderRanking();
  });
  socket.on("room-ranking-update", (payload) => {
    if (payload.roomId !== currentRoomId) return;
    rankingCache = { daily: payload.daily, weekly: payload.weekly, monthly: payload.monthly };
    if (!$("modal-room-ranking").classList.contains("hidden")) renderRanking();
  });
  socket.on("follow-status-update", handleFollowStatusUpdate);
  // Home no longer exposes the Groups tab; group features remain available elsewhere.

  // MESH VOICE TOPOLOGY (production hardening): a seated speaker must be
  // audible to BOTH seated peers and audience listeners. The previous
  // implementation built the mesh from room.seats only, so an audience
  // member never created a receiving RTCPeerConnection and could not hear
  // anyone. Build the desired graph from onlineUsers, but only create an
  // edge when at least one endpoint is seated (audience-to-audience is
  // unnecessary). Audience clients have no localStream, so they receive only.
  function reconcileMeshVoice(room) {
    if (voiceMode === "sfu" || !room || !Array.isArray(room.seats)) return;
    const selfId = me && me.userId;
    const seatedByUser = new Map();
    room.seats.forEach((seat) => {
      if (seat && seat.userId && seat.socketId) seatedByUser.set(seat.userId, seat.socketId);
    });
    const online = Array.isArray(room.onlineUsers) ? room.onlineUsers : [];
    const sockets = new Map();
    online.forEach((u) => {
      if (u && u.userId && u.socketId && u.userId !== selfId) sockets.set(u.userId, u.socketId);
    });
    // If the public room snapshot is briefly behind seat-update, preserve
    // the authoritative seat socket IDs as a fallback.
    seatedByUser.forEach((sid, uid) => { if (uid !== selfId) sockets.set(uid, sid); });

    const desired = new Set();
    sockets.forEach((sid, uid) => {
      const remoteIsSeated = seatedByUser.has(uid);
      const selfIsSeated = !!(mySeatNumber !== null && mySeatNumber !== undefined);
      if (selfIsSeated || remoteIsSeated) desired.add(sid);
    });

    Object.keys(peerConnections).forEach((sid) => {
      if (!desired.has(sid)) closePeer(sid);
    });
    desired.forEach((sid) => {
      if (!peerConnections[sid]) connectToPeer(sid);
    });
  }

  // Vapi client-side room-control tool needs the authenticated Socket.IO
  // channel. Expose only the socket object, never credentials.
  window.socket = socket;

  socket.on("room-state", (room) => {
    currentRoom = room;
    // ROOT-CAUSE FIX (2026-08-14, reconnect / duplicate join-room audit):
    // "room-state" for OUR own room is the server's acknowledgement that a
    // "join-room" we sent has actually completed (see finishJoin() in
    // server.js — it always emits "room-state" directly back to the
    // joining socket right after the join finishes). This is the one
    // place that clears joinInProgress / advances joinedRoomId, so a
    // join is never considered "done" client-side until the server has
    // actually confirmed it — closing the window where a double-tap or a
    // rapid reconnect could fire a second "join-room" on top of one still
    // in flight. If the user tapped a different room while this join was
    // in flight, dispatch that queued request now instead of settling on
    // the room that just arrived (only the LAST requested room should win).
    if (room && room.roomId === currentRoomId) {
      joinedRoomId = room.roomId;
      joinInProgress = false;
      if (pendingJoinRequest && pendingJoinRequest.roomId !== room.roomId) {
        const next = pendingJoinRequest;
        pendingJoinRequest = null;
        joinRoom(next.roomId, next.password);
      } else {
        pendingJoinRequest = null;
      }
    }
    // PHASE 1 FIX (2026-08-16, seat/mic authoritative-state audit): hydrate
    // seatMap/mySeatNumber from THIS room-state snapshot BEFORE any UI element
    // (mic button, Robin button, etc.) reads mySeatNumber below. Previously
    // hydrateSeatMap() ran after this block, so every visibility decision in
    // this block was made using the PREVIOUS snapshot's seat state — a stale-
    // by-one-broadcast bug (frontend briefly not matching backend room state).
    // seatsFromMap()/renderSeats() were already tolerant of this since they
    // re-run below, but toggles that read mySeatNumber directly (like the mic
    // button below) were not.
    hydrateSeatMap(room.seats);
    // The Robin toolbar button must exist only in Room 101 — it must not be
    // reachable (or even visible) from any other room, and this fires on
    // every room-state snapshot so it can't get stuck showing after a
    // room switch either way.
    const robinBtn = $("btn-robin-support");
    if (robinBtn) robinBtn.classList.toggle("hidden", !(room && room.roomId === "101"));
    if (room && room.roomId === "101") {
      $("btn-mic-toggle")?.classList.toggle("hidden", mySeatNumber != null);
      if (room.aiSeat) cs101ConfigClient = { ...cs101ConfigClient, agentName: room.aiSeat.userName || cs101ConfigClient.agentName, avatarUrl: room.aiSeat.avatarUrl || cs101ConfigClient.avatarUrl };
      renderCs101Seat();
      initCs101Ui();
      if (socket) socket.emit("cs101:start");
    } else {
      cs101StopRecognition();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      cs101GreetedSeatKey = null;
      // Safety net: any path that lands a room-state snapshot for a room
      // other than 101 (e.g. force-moved to a different room, or a
      // reconnect that resumes into a different room than Robin's call was
      // started in) must not leave a Vapi call — and its open microphone —
      // running in the background. The explicit leave-seat/leave-room
      // handlers already stop Robin for the ordinary paths; this covers
      // the remaining ones so no AI voice state can ever survive outside
      // Room 101.
      if (window.PingPongRobin?.isActive?.()) window.PingPongRobin.stop();
      // PHASE 1 FIX (§12 — bottom control bar must reflect seat state): in
      // every non-101 room the mic-toggle button was always visible/tappable
      // regardless of seat state. It was already functionally guarded (the
      // click handler toasts "Take a seat to talk" and never requests a mic
      // or opens a voice connection when mySeatNumber is null — no rogue
      // voice connection was ever created), but an unseated audience member
      // could still see what looks like a live mic control. Hide it exactly
      // like Room 101 already does for its own AI-seat case, keyed off the
      // now-freshly-hydrated mySeatNumber above.
      $("btn-mic-toggle")?.classList.toggle("hidden", mySeatNumber == null);
    }
    currentRelationshipLinks = Array.isArray(room.relationshipLinks) ? room.relationshipLinks : [];
    if (!relationshipVisualConfigLoaded) fetchRelationshipVisualConfig(); // once per session is enough; live changes come via the socket event above
    renderSeats(room.seats);
    if (room && room.roomId === "101") cs101MaybeGreetOnSeat();
    // Fix (voice goes silent after reconnect/refresh): seat data is hydrated
    // above, but that alone doesn't re-establish WebRTC audio to peers who
    // were already seated before we (re)connected — previously you'd see
    // them on their seat but hear nothing until they happened to re-take a
    // seat. If we're seated ourselves, (re)connect to every other occupied
    // seat's current socket, and drop any peer connection that's stale
    // (pointing at a socket id that's no longer actually seated here).
    // Phase 3 / Step 3.3: mesh-only. In SFU mode this whole peer-mesh
    // reconciliation is skipped — LiveKit's own subscription/publish
    // lifecycle (see public/voice-sfu.js) is what re-establishes audio
    // after a reconnect there, not per-peer RTCPeerConnections.
    if (voiceMode !== "sfu" && me) reconcileMeshVoice(room);
    renderChatLog(room.messages || []);
    $("room-name-display").firstChild.textContent = room.roomName + " ";
    $("room-lock-badge").classList.toggle("hidden", !room.roomLocked);
    $("room-host-display").textContent = "#" + room.roomNumber;
    if (room.music && room.music.url) setMusicUI(room.music);
    applyRoomBackground(room.background || "");
    setRoomLogo(room.logo);
    // BUG FIX (settings-icon-does-nothing, 2026-07-29): this used to read
    // me.userId unconditionally. If `me` was ever momentarily null when a
    // room-state update arrived, this whole handler threw right here and
    // every line after it (including showing/hiding the Settings gear,
    // chat rendering, YouTube state, etc.) silently never ran for that
    // update. `me` is guarded now so one bad tick can't wedge the UI.
    const canModerate = !!me && (room.hostId === me.userId || (room.adminIds || []).includes(me.userId));
    $("btn-room-mod").classList.toggle("hidden", !canModerate);
    if (room.treasureChest) renderChest(room.treasureChest);

    // YouTube Room Player — hydrate playlist + playback state, same
    // control permission as room moderation (owner/admin).
    canControlYt = canModerate;
    $("btn-toggle-yt").classList.toggle("hidden", !canControlYt);
    ytCurrentPlaylist = room.videoPlaylist || [];
    renderYtPlaylist();
    if (room.videoPlayer) {
      ytPlayerState.mode = !!room.videoPlayer.mode;
      setYtModeUI(ytPlayerState.mode, true);
      applyYtPlayerState(room.videoPlayer);
    }
    initMicIfNeeded().then(ensureLocalTracksSent);
    // PHASE 3, STEP 3.6 — audience (non-seated) SFU listening. Fires on
    // every room-state sync (initial join, reconnect, refresh), so this
    // single hook covers all entry points without needing separate calls
    // in joinRoom()/rejoinRoom(). connectSfuAsAudience() is idempotent
    // (no-op if already connected — see its own isConnected() guard), and
    // is skipped entirely if we're already seated (initMicIfNeeded()
    // above already handles that case by connecting as a full publisher).
    if (voiceMode === "sfu" && mySeatNumber === null) connectSfuAsAudience();
    // ROOT-CAUSE FIX (2026-08-11, "seated speaker goes permanently silent
    // over SFU after a dropped LiveKit connection"): connectSfuAsAudience()
    // above self-heals on every room-state sync, but a SEATED publisher had
    // no equivalent. Root cause: initMicIfNeeded() (called a few lines up)
    // starts with `if (localStream || !mySeatNumber) return;` — so once
    // localStream exists (mic hardware already granted), it returns
    // immediately and never re-enters initSfuMicIfNeeded()/connectSfuRoom(),
    // regardless of whether the LiveKit Room itself is still connected. If
    // LiveKit's own internal reconnect ever gives up for good — the token
    // TTL (LIVEKIT_TOKEN_TTL_SECONDS, default 6h) elapsing mid-session is
    // the most likely real-world trigger for a long-running voice room, but
    // any other terminal LiveKit disconnect has the same effect — the only
    // symptom was `onDisconnected` quietly setting `sfuConnected = false`:
    // no toast, no automatic recovery, and the existing mic-toggle button
    // can't fix it either (it only calls connectSfuRoom() from inside the
    // `if (!localStream)` branch, which is already false here). The seated
    // user's mic UI stays "on" and they keep talking into a socket nobody
    // is listening to for the rest of the session, until they leave and
    // re-take a seat. Mirrors connectSfuAsAudience()'s exact self-heal
    // shape: fires on every room-state sync, no-ops unless we're actually
    // seated, on SFU, already holding a live mic track, and NOT currently
    // connected — connectSfuRoom() itself is already idempotent/guarded, so
    // this cannot double-connect or double-publish.
    if (voiceMode === "sfu" && mySeatNumber !== null && localStream && !window.PingPongVoiceSFU.isConnected()) connectSfuRoom();

    // Fix: the game overlay's toggle button is only shown when an admin has
    // actually enabled games for this room (see Admin Panel → Rooms). If an
    // admin turns it off while someone has it open, close it for them too.
    const gameAllowed = room.gameEnabled !== false;
    $("btn-toggle-game").classList.toggle("hidden", !gameAllowed);
    if (!gameAllowed) closeRoomGame();
  });

  socket.on("user-count", (data) => {
    const pill = $("room-online-count");
    const next = "👥 " + data.count;
    // Live pulse ring: only fire the bump animation when the number itself
    // actually changed, so the pill doesn't visually "flicker" on every
    // redundant server broadcast of the same count.
    if (pill.textContent !== next) {
      pill.textContent = next;
      pill.classList.remove("count-bump");
      void pill.offsetWidth;
      pill.classList.add("count-bump");
    }
  });

  $("room-online-count").addEventListener("click", () => {
    const list = $("online-members-list");
    list.innerHTML = "";
    const users = currentRoom?.onlineUsers || [];
    if (!users.length) {
      list.innerHTML = '<div class="gift-target-empty">No one yet</div>';
    } else {
      users.forEach((u) => {
        const row = document.createElement("div");
        row.className = "gift-target-row";
        row.style.cursor = "pointer";
        row.innerHTML = `<img class="avatar avatar-sm" src="${escapeHtml(u.userPhoto || placeholderAvatar(u.userName))}" alt=""><span>${escapeHtml(u.userName)}${u.userId === currentRoom.hostId ? " 👑" : ""}</span>`;
        row.addEventListener("click", () => {
          $("modal-online-members").classList.add("hidden");
          const seatNumber = seatNumberForUser(u.userId);
          openSeatProfileSheet(u.userId, seatNumber);
        });
        list.appendChild(row);
      });
    }
    $("modal-online-members").classList.remove("hidden");
  });
  $("btn-close-online-members").addEventListener("click", () => $("modal-online-members").classList.add("hidden"));

  socket.on("seat-update", (data) => {
    if (data.action === "take") {
      if (data.oldSeatNumber && seatMap[data.oldSeatNumber]) delete seatMap[data.oldSeatNumber];
      // BUG FIX: "take" dropped customTag while "move" (below) kept it — a
      // freshly-seated user's tag/name-color badge stayed missing on the
      // seat until an unrelated seat "move" or full room-state refresh
      // happened to repopulate it. Server already sends customTag on take
      // (see server.js seat-update "take" emit); the client just wasn't
      // storing it. Mirrors the "move" branch below exactly.
      seatMap[data.seatNumber] = { userId: data.userId, socketId: data.socketId, userName: data.userName, userPhoto: data.userPhoto, role: data.role, activeFrame: data.activeFrame || null, vipLevel: data.vipLevel || 0, customTag: data.customTag || null, nameEffect: data.nameEffect || null };
      if (data.userId === me.userId) {
        // BUG FIX: this used to only set mySeatNumber and stop — the mic
        // (getUserMedia) never got requested here, only inside the
        // "room-state" handler. take-seat only ever emits "seat-update", so
        // a freshly-seated user's mic stayed uninitialized (localStream ===
        // null) until some unrelated room-state broadcast happened to fire
        // later. Meanwhile every other seated user immediately tries to
        // connectToPeer() them (see the `else` branch below) — their side
        // answers with zero audio tracks, so nobody hears the new seat even
        // though the connection itself "succeeds". Requesting the mic here,
        // then pushing tracks into any peer connections that already exist
        // (see ensureLocalTracksSent), closes that gap.
        mySeatNumber = data.seatNumber;
        if (currentRoomId === "101") {
          cs101MaybeGreetOnSeat();
          $("btn-mic-toggle")?.classList.add("hidden");
        } else {
          // PHASE 1 FIX: mirror the room-state handler's seat-based
          // visibility here too — take-seat only ever emits "seat-update"
          // (see BUG FIX note above), never a fresh "room-state", so if we
          // only unhid the button on room-state it could stay stuck hidden
          // after a real seat-take until an unrelated room-state broadcast.
          $("btn-mic-toggle")?.classList.remove("hidden");
        }
        // Sitting down means the mic is immediately live. No second manual
        // tap is required; the toolbar button is only the mute/unmute control.
        micEnabled = true;
        $("btn-mic-toggle").classList.add("active");
        initMicIfNeeded().then(ensureLocalTracksSent);
        // Also proactively connect to everyone already sitting, instead of
        // only ever waiting to be connected to — makes voice come up
        // immediately even if the other side's connectToPeer() call for us
        // fires first and loses a race with our getUserMedia() prompt.
        // Phase 3 / Step 3.3: mesh-only — in SFU mode initMicIfNeeded()
        // above joins the LiveKit room instead, which already both
        // publishes our mic and subscribes to every other participant, so
        // there is no per-peer connection step to do here.
        // ROOT-CAUSE FIX (voice drops on seat change, production symptom
        // 2026-08-10): this used to call connectToPeer() unconditionally for
        // every other seated peer, with no check for whether a connection to
        // them already existed. That's correct for a brand-new seat-join
        // (audience -> seat: no peer connection yet, must be created) but
        // wrong for a same-user seat MOVE (seat A -> seat B: same socketId,
        // connection to every other peer is already live and healthy) —
        // every already-seated peer's stable connection was getting a fresh,
        // pointless renegotiation offer purely because we sat down somewhere
        // else. That's exactly the "duplicate/unnecessary negotiation" class
        // of bug: harmless in the common case (glare handling in
        // getOrCreatePeer() resolves it), but under load (several people
        // already speaking) the resulting rollback/renegotiate churn is what
        // produced the observed "voice sometimes stops after a seat change,
        // recovers after a bit" symptom. Only reconnect to peers we don't
        // already have a connection to — mirrors the identical
        // `!peerConnections[sid]` guard the room-state reconciliation above
        // already uses for the same reason.
        if (voiceMode !== "sfu") {
          reconcileMeshVoice(currentRoom || { seats: seatsFromMap(), onlineUsers: [] });
        }
      } else if (voiceMode !== "sfu") {
        // Reconcile the complete seated/audience graph. This covers both a
        // new speaker joining and an audience listener joining an existing
        // room, without tearing down healthy peers on ordinary seat moves.
        reconcileMeshVoice(currentRoom || { seats: seatsFromMap(), onlineUsers: [] });
      }
    } else if (data.action === "move") {
      const from = Number(data.fromSeatNumber);
      const to = Number(data.seatNumber);
      const entry = seatMap[from];
      if (entry && entry.userId === data.userId) delete seatMap[from];
      seatMap[to] = { ...(entry || {}), userId: data.userId, socketId: data.socketId || entry?.socketId, userName: data.userName || entry?.userName, userPhoto: data.userPhoto || entry?.userPhoto, role: data.role || entry?.role, activeFrame: data.activeFrame || entry?.activeFrame || null, vipLevel: data.vipLevel || entry?.vipLevel || 0, customTag: data.customTag || entry?.customTag || null, nameEffect: data.nameEffect || entry?.nameEffect || null };
      if (data.userId === me.userId) {
        // Atomic seat move: preserve the existing voice transport/mic. Only
        // the seat number changes; no leave/join voice teardown occurs.
        mySeatNumber = to;
        if (currentRoomId === "101") {
          $("btn-mic-toggle")?.classList.add("hidden");
          cs101MaybeGreetOnSeat();
        } else {
          // PHASE 1 FIX: seat move keeps the user seated throughout, so the
          // button must stay visible/unhidden — explicit for clarity and to
          // guard against any earlier hidden state left over from a stale
          // snapshot.
          $("btn-mic-toggle")?.classList.remove("hidden");
        }
      }
      if (currentRoom) {
        currentRoom.seats = seatsFromMap();
        renderSeats(currentRoom.seats);
        if (voiceMode !== "sfu") reconcileMeshVoice(currentRoom);
      }
    } else if (data.action === "leave") {
      const entry = seatMap[data.seatNumber];
      if (entry) {
        if (entry.userId === me.userId) {
          mySeatNumber = null;
          if (currentRoomId === "101" && typeof window.PingPongRobin?.stop === "function") {
            // Stop both an active call and a call that is still connecting.
            // This is the authoritative seat-leave boundary.
            void window.PingPongRobin.stop();
          }
          if (currentRoomId === "101") $("btn-mic-toggle")?.classList.remove("hidden");
          // PHASE 1 FIX: leaving a seat in a non-101 room must hide the mic
          // control again immediately — matches §1/§12 ("when a user leaves
          // a seat, the mic/voice UI must disappear immediately").
          else $("btn-mic-toggle")?.classList.add("hidden");
          micEnabled = false;
          $("btn-mic-toggle").classList.remove("active");
          if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
          stopVoiceActivityDetection();
          // PHASE 3, STEP 3.6 — covers BOTH self-initiated (leave-seat)
          // and admin-forced (mod-move-to-audience) moves, since server.js
          // broadcasts the same "seat-update"/action:"leave" event for
          // both. Mesh mode is untouched (guarded by voiceMode check) —
          // closePeer(entry.socketId) below already handles the mesh side
          // exactly as before this step.
          if (voiceMode === "sfu") downgradeSfuToAudience();
        }
        closePeer(entry.socketId);
        speakingUsers.delete(entry.userId);
        delete seatMap[data.seatNumber];
      }
    }
    if (currentRoom) {
      renderSeats(seatsFromMap());
      if (voiceMode !== "sfu") reconcileMeshVoice({ seats: seatsFromMap() });
    }
  });

  // Real-time voice activity from other participants — drives the speaking
  // ring/waveform on the correct seat, independent of who's just "seated".
  socket.on("voice-activity", (data) => {
    if (data.speaking) speakingUsers.add(data.userId); else speakingUsers.delete(data.userId);
    if (currentRoom) renderSeats(seatsFromMap());
  });

  socket.on("room-relationship-update", (data) => {
    if (!currentRoomId || !data || data.roomId !== currentRoomId) return;
    currentRelationshipLinks = Array.isArray(data.links) ? data.links : [];
    if (currentRoom) currentRoom.relationshipLinks = currentRelationshipLinks;
    renderRelationshipLinks(currentRelationshipLinks);
  });

  // Admin Panel (2026-08-11): CP/Friendship size/opacity/animation/position
  // + custom asset changes push here live — no page refresh needed (TEST 9).
  socket.on("relationship-config-update", (config) => {
    applyRelationshipVisualConfig(config);
  });

  socket.on("relationship-update", (data) => {
    if (!data) return;
    if (sheetTargetUserId && data.relationship) {
      const a = data.relationship.userA, b = data.relationship.userB;
      if ((a === me.userId && b === sheetTargetUserId) || (b === me.userId && a === sheetTargetUserId)) {
        loadSheetRelationshipStatus(sheetTargetUserId);
      }
    }
    if (otherProfileUser && data.relationship) {
      const a = data.relationship.userA, b = data.relationship.userB;
      if ((a === me.userId && b === otherProfileUser.userId) || (b === me.userId && a === otherProfileUser.userId)) {
        loadOtherRelationshipStatus(otherProfileUser.userId);
      }
    }
    if (data.request && data.request.status === "accepted") toast("💞 Relationship accepted");
  });

  socket.on("relationship-request-sent", (data) => {
    if (data && data.type) toast(`${data.type === "cp" ? "💞 CP" : "🤝 Friendship"} request sent`);
  });

  socket.on("new-message", (msg) => appendChatMsg(msg));

  socket.on("gift-received", (data) => {
    if (!data || !data.gift) return;
    // HARDENING (2026-08-18, receiver sees nothing on gift send fix): each
    // step now runs independently. Previously a throw in any one step (fly
    // animation DOM math, sound playback, seat lookup) silently skipped
    // every step after it — including the receiver's own toast/notification
    // and their local diamonds bump — even though the gift itself had
    // already been credited server-side. Now every receiver-visible signal
    // (toast, chat notice, balance) is guaranteed to run regardless of
    // whether the fancier animation/sound pieces succeed.
    try { spawnGiftFly(data.gift, data.fromUserId, data.toUserId); } catch (e) { console.error("gift-received: fly animation", e); }
    try { playGiftSound(data.gift); } catch (e) { console.error("gift-received: sound", e); }
    try { flashSeatReceive(data.toUserId); } catch (e) { console.error("gift-received: seat flash", e); }
    try { appendGiftMsg(data); } catch (e) { console.error("gift-received: chat notice", e); }
    try { toast(`🎁 ${data.fromName} sent ${data.gift.name}`); } catch (e) { console.error("gift-received: toast", e); }
    if (data.toUserId === me.userId) {
      // Restored on request (2026-08-04): server now credits the recipient
      // in Diamonds again (see send-gift on the server), so this local
      // optimistic update matches — the real wallet-update push that
      // follows corrects it either way.
      try {
        me.diamonds = (me.diamonds || 0) + (data.gift.price || 0);
        saveSession();
        fillHomeProfile();
      } catch (e) { console.error("gift-received: local balance update", e); }
    }
  });

  socket.on("music-update", (music) => setMusicUI(music));

  // ---- YouTube Room Player ----
  socket.on("yt-mode-update", (data) => {
    ytPlayerState.mode = !!data.on;
    setYtModeUI(ytPlayerState.mode);
    if (data.byName) appendChatMsg({ system: true, message: `${data.byName} ${data.on ? "has turned on" : "has turned off"} the video room mode` });
  });
  socket.on("yt-playlist-update", (playlist) => {
    ytCurrentPlaylist = playlist || [];
    renderYtPlaylist();
  });
  socket.on("yt-player-update", (state) => {
    applyYtPlayerState(state);
  });

  // Video Gift catalog changes app-wide (any admin Add/Update/Delete) —
  // refresh the cache and, if the Custom tab happens to be open, re-render
  // it immediately. No refresh needed on the user's end.
  socket.on("video-gift-catalog", (gifts) => {
    VIDEO_GIFT_CATALOG_CACHE.gifts = gifts;
    if (!$("modal-gift").classList.contains("hidden") && activeGiftTier === "custom") renderGiftGrid();
  });

  // Gift Manager catalog changes (Normal/VIP/Legend tabs) — any admin
  // Add/Edit/Delete/Toggle refreshes the cache and re-renders live, same
  // pattern as the Video Gift "Custom" tab above.
  socket.on("gift-catalog", (gifts) => {
    GIFT_CATALOG_CACHE.gifts = gifts;
    if (!$("modal-gift").classList.contains("hidden") && activeGiftTier !== "custom") renderGiftGrid();
  });

  // Full-screen Video Gift playback — queued so simultaneous sends never
  // overlap; deducting Coins already happened server-side before this
  // event was broadcast, so by the time it arrives it's guaranteed valid.
  socket.on("video-gift-play", (data) => {
    if (data.fromUserId === me.userId && data.gift.price) {
      me.coins -= data.gift.price;
      saveSession(); fillHomeProfile();
    }
    videoGiftQueue.push(data);
    playNextVideoGift();
  });

  // Vehicle Entry System (add-on) — a room member's Active Vehicle plays a
  // full-screen entry clip the moment they join. Server already checked
  // ownership/expiry before broadcasting this, so the client just plays it.
  socket.on("vehicle-entry", (data) => {
    vehicleEntryQueue.push(data);
    playNextVehicleEntry();
  });

  // Fix (game coins vs wallet coins looked like two separate balances):
  // wallet-update only fired for gifts/chest/admin changes, while the
  // Food Wheel / Teen Patti sync result only patched me.coins + the home
  // screen. Both now go through the same function so every place coins are
  // shown (home, menu, wallet modal, gift modal, an open game) updates
  // together, in real time, from a single source of truth.
  function applyWalletUpdate(data) {
    if (typeof data.coins === "number") me.coins = data.coins;
    if (typeof data.diamonds === "number") me.diamonds = data.diamonds;
    if (typeof data.level === "number") me.level = data.level;
    if (typeof data.vipLevel === "number") me.vipLevel = data.vipLevel;

    // HARDENING (2026-08-18, live-balance-not-updating fix): the visible
    // number updates are done FIRST and each wrapped so one broken widget
    // can never silently block the rest. Previously fillHomeProfile() ran
    // first — if ANY of its side calls (svip tag refresh, agency/coin-
    // center menu checks, frame/badge rendering) ever threw, every update
    // below it (menu pill, wallet modal, gift modal) silently never ran,
    // even though `me.coins`/`me.diamonds` themselves were already correct
    // — which is exactly why a relogin (full re-render from scratch) always
    // showed the right balance while the live, already-open app did not.
    try { const menuCoins = $("menu-wallet-coins"), menuDiamonds = $("menu-wallet-diamonds");
      if (menuCoins) menuCoins.textContent = me.coins;
      if (menuDiamonds) menuDiamonds.textContent = me.diamonds; } catch (e) { console.error("wallet-update: menu pill", e); }
    try { const walletCoins = $("wallet-coins"), walletDiamonds = $("wallet-diamonds");
      if (walletCoins) walletCoins.textContent = me.coins;
      if (walletDiamonds) walletDiamonds.textContent = me.diamonds; } catch (e) { console.error("wallet-update: wallet modal", e); }
    try { const homeCoins = $("home-coins"), homeDiamonds = $("home-diamonds");
      if (homeCoins) homeCoins.textContent = me.coins;
      if (homeDiamonds) homeDiamonds.textContent = me.diamonds; } catch (e) { console.error("wallet-update: home pill", e); }
    try { const pill = $("gift-modal-coins");
      if (pill && !$("modal-gift").classList.contains("hidden")) { pill.textContent = me.coins; renderGiftLevelCard(); } } catch (e) { console.error("wallet-update: gift modal", e); }

    // Coins can change for any reason while a room game is open (a gift
    // sent/received, a reward, an admin adjustment) — not just from
    // playing. Push the fresh real balance straight into whichever game is
    // currently loaded so its on-screen wallet always matches the account,
    // in real time, not just at open.
    try {
      const tvScreen = $("room-tv-screen"), tvFrame = $("room-tv-frame");
      if (tvScreen && tvFrame && tvScreen.classList.contains("tv-open") && tvFrame.src) {
        const gameType = roomTvActiveGame === "teenpatti" ? "TEENPATTI_INIT" : "FOODWHEEL_INIT";
        try { tvFrame.contentWindow.postMessage({ type: gameType, balance: me.coins || 0 }, "*"); } catch (e) {}
      }
    } catch (e) { console.error("wallet-update: room tv sync", e); }

    saveSession();
    try { fillHomeProfile(); } catch (e) { console.error("wallet-update: fillHomeProfile", e); }
  }

  socket.on("wallet-update", applyWalletUpdate);
  socket.on("game-wheel-sync-result", applyWalletUpdate);
  // SVIP level/resource changes (level up, membership expiry, Admin
  // re-uploading a tag PNG) — refresh the tag + badge live, no refresh
  // needed, exactly like the VIP logo already behaves.
  socket.on("svip_level_changed", (data) => {
    if (!me || data.userId !== me.userId) return;
    refreshMySvipTag();
  });
  socket.on("svip_resource_update", (data) => {
    if (!me || data.userId !== me.userId) return;
    applySvipTag($("home-svip-tag"), data.resources);
    applySvipTag($("profile-svip-tag"), data.resources);
  });

  // ---- Fruit Wheel: the server decides the round phase/result and the
  // real winners, this just relays those broadcasts into whichever game
  // iframe is currently open so it can play the matching animation. ----
  socket.on("fruitwheel-round", (data) => {
    const frame = $("room-tv-frame");
    if (roomTvActiveGame === "foodwheel" && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "FRUITWHEEL_ROUND", ...data }, "*");
    }
  });
  socket.on("fruitwheel-winners", (data) => {
    const frame = $("room-tv-frame");
    if (roomTvActiveGame === "foodwheel" && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "FRUITWHEEL_WINNERS", ...data }, "*");
    }
  });
  // Real per-user outcome (win or lose) for the round that just resolved —
  // targeted just at this socket, only ever sent by the server after it has
  // actually settled the payout. Replaces any client-side guess at "did I
  // win / how much".
  socket.on("fruitwheel-result", (data) => {
    const frame = $("room-tv-frame");
    if (roomTvActiveGame === "foodwheel" && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "FRUITWHEEL_MY_RESULT", ...data }, "*");
    }
  });
  // STABILIZATION (Full Lucky Fruit audit, 2026-08-06): the server used to
  // silently drop a bad/late bet with no reply at all, so a tap that failed
  // server-side still looked "placed" in the UI until the next wallet-update
  // quietly proved otherwise. Both outcomes are now explicit and forwarded
  // to the game so it can confirm or roll back its own optimistic UI state
  // instead of guessing.
  socket.on("fruitwheel-bet-ack", (data) => {
    const frame = $("room-tv-frame");
    if (roomTvActiveGame === "foodwheel" && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "FRUITWHEEL_BET_ACK", ...data }, "*");
    }
  });
  socket.on("fruitwheel-bet-rejected", (data) => {
    const frame = $("room-tv-frame");
    if (roomTvActiveGame === "foodwheel" && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "FRUITWHEEL_BET_REJECTED", ...data }, "*");
    }
  });
  // Real, persistent Jackpot Ranking — cumulative real winnings per user,
  // pushed whenever it changes (a real payout just happened) and also
  // requested fresh on join so the modal isn't empty until the next round.
  socket.on("fruitwheel-leaderboard", (data) => {
    const frame = $("room-tv-frame");
    if (roomTvActiveGame === "foodwheel" && frame && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "FRUITWHEEL_LEADERBOARD", ...data }, "*");
    }
  });

  socket.on("god_power_granted", (data) => {
    if (me) { me.is_immune = true; me.can_manage_all = true; me.is_invisible = true; me.invisibleActive = false; saveSession(); }
    showGodPowerPopup(data.message || "You are now an Official God Power Holder", "grant");
    refreshGodPowerInvisibleRow();
  });
  socket.on("god_power_revoked", (data) => {
    if (me) { me.is_immune = false; me.can_manage_all = false; me.is_invisible = false; me.invisibleActive = false; saveSession(); }
    showGodPowerPopup(data.message || "Your God Power has been removed", "revoke");
    refreshGodPowerInvisibleRow();
  });
  socket.on("invisible-state", (data) => {
    if (me) { me.invisibleActive = !!data.active; saveSession(); }
    refreshGodPowerInvisibleRow();
    toast(data.active ? "You are now Invisible 👻" : "You are now visible to everyone");
  });

  socket.on("room-error", (data) => {
    // ROOT-CAUSE FIX (2026-08-14): "room-error" means the "join-room" we
    // sent did NOT complete — without clearing joinInProgress here it would
    // stay stuck true forever (no "room-state" ack is ever coming for a
    // rejected join), permanently blocking every future join attempt.
    joinInProgress = false;
    if (pendingJoinRequest) {
      const next = pendingJoinRequest;
      pendingJoinRequest = null;
      joinRoom(next.roomId, next.password);
      return;
    }
    toast(data.message || "A problem occurred in the room");
    if (data.needPassword) {
      // Wrong/missing password on a locked room — ask again instead of
      // bouncing the user back to the room list.
      promptRoomPassword(data.roomId || currentRoomId);
      return;
    }
    // The room we tried to (re)join is gone/locked — don't keep retrying it
    // on every future refresh/reconnect.
    if (currentRoomId && (!currentRoom || currentRoom.roomId !== currentRoomId)) {
      currentRoomId = null; currentRoom = null;
      joinedRoomId = null; // join-lifecycle guard (2026-08-14 fix) — not joined to anything anymore
      saveActiveRoom(null);
      showView("view-home"); loadRoomList();
    }
  });

  socket.on("announcement", (entry) => {
    const banner = $("announce-banner");
    banner.textContent = "📢 " + entry.text;
    banner.classList.remove("hidden");
    setTimeout(() => banner.classList.add("hidden"), 6000);
    toast("📢 " + entry.text);
  });

  socket.on("seat-lock-update", (data) => {
    if (!currentRoom) return;
    currentRoom.lockedSeats = currentRoom.lockedSeats || [];
    if (data.locked) {
      if (!currentRoom.lockedSeats.includes(data.seatNumber)) currentRoom.lockedSeats.push(data.seatNumber);
    } else {
      currentRoom.lockedSeats = currentRoom.lockedSeats.filter(n => n !== data.seatNumber);
    }
    renderSeats(seatsFromMap());
  });

  socket.on("room-background-update", (data) => {
    applyRoomBackground(data.url || "");
    if (currentRoom) currentRoom.background = data.url || "";
  });

  socket.on("room-logo-update", (data) => {
    setRoomLogo(data.url);
    if (currentRoom) currentRoom.logo = data.url;
  });

  socket.on("chat-cleared", (data) => {
    $("chat-log").innerHTML = "";
    appendChatMsg({ system: true, message: `${data.by} cleared the chat` });
  });

  socket.on("kicked", (data) => {
    console.log("[SOCKET] kicked event received:", data);
    toast(data.message || "You have been removed from the room");
    teardownVoice();
    closeRoomGame();
    teardownYtPlayer();
    currentRoomId = null; currentRoom = null;
    joinedRoomId = null; joinInProgress = false; pendingJoinRequest = null; // join-lifecycle guard (2026-08-14 fix)
    saveActiveRoom(null);
    if (data.forceLogout) {
      // Account-level action (ban/delete) — the session itself is no
      // longer valid, not just the current room, so fully log out rather
      // than leaving the person on the home screen still "signed in" as
      // an account that can no longer act.
      console.log("[SOCKET] kicked with forceLogout -> clearing session");
      clearSession("kicked-forceLogout");
      if (socket) { socket.disconnect(); socket = null; }
      showView("view-login");
      return;
    }
    showView("view-home"); loadRoomList();
  });

  // SECURITY HARDENING (Module 5.1): server rejected our identify claim —
  // this only fires if we sent an authToken that's invalid/expired/doesn't
  // match the claimed userId, so the session itself is no longer trustworthy.
  // Same handling as "kicked" with forceLogout.
  socket.on("identify-rejected", (data) => {
    console.log("[SOCKET] identify-rejected:", data);
    clearSession("identify-rejected");
    if (socket) { socket.disconnect(); socket = null; }
    showView("view-login");
    toast(data.message || "Session expired — please log in again");
  });

  socket.on("chest-opened", (data) => {
    const amRecipient = (currentRoom && currentRoom.hostId === me.userId) ||
      (data.topContributors || []).some((c) => c.userId === me.userId);
    if (amRecipient) {
      if (data.reward.type === "coins") me.coins += data.reward.amount;
      else me.diamonds += data.reward.amount;
      saveSession(); fillHomeProfile();
    }
    playChestOpenAnimation(data);
  });

  socket.on("new-private-message", (msg) => {
    if (threadPeerId && (msg.from === threadPeerId || msg.to === threadPeerId)) {
      appendThreadMsg(msg);
    } else {
      const notice = msg.type === "agency_invite" ? "🏢 New Agency Invitation received" : msg.type === "relationship_request" ? (msg.data && msg.data.relationshipType === "cp" ? "💞 New CP request" : "🤝 New Friendship request") : "New message received";
      toast(notice);
    }
  });

  // ---- Phase 3: Agency & Host System live updates ----
  socket.on("host-status-update", (data) => {
    // Fired the moment an Agency invite is accepted — updates the menu
    // immediately without needing a full page reload.
    me.isHost = true;
    if (data.agencyId) me.agencyId = data.agencyId;
    saveSession();
    checkHostCenterMenu();
    toast("🎉 You are now an Agency Host!");
  });
  socket.on("host-stats-update", handleHostStatsUpdate);
  socket.on("host-gift-received", handleHostGiftReceived);
  socket.on("agency-invite-updated", () => { if (currentAgencyId) renderAgencyDashboard(); });
  socket.on("agency-host-list-update", () => { if (currentAgencyId) renderAgencyDashboard(); });
  socket.on("agency-stats-update", (data) => {
    if (currentAgencyId && data.agencyId === currentAgencyId && $("view-agency").classList.contains("active")) {
      renderAgencyDashboard();
    }
  });

  // Admin assigned a frame to THIS account only — private receipt notice.
  // Does not equip it; open My Frames to select and use it.
  socket.on("frame-inventory-updated", () => {
    toast("🖼️ You received a new profile frame.");
  });

  // This account's active frame changed (equipped/removed via My Frames,
  // possibly from another device) — sync silently, no "received" toast.
  socket.on("frame-active-updated", (frame) => {
    me.activeFrame = frame;
    saveSession();
    fillHomeProfile();
  });

  // Admin assigned (or removed) a coloured tag while we're online.
  socket.on("tag-updated", (tag) => {
    me.customTag = tag;
    saveSession();
    fillHomeProfile();
    applyCustomTag($("profile-tag-badge"), me.customTag);
    toast(tag ? `🏷️ You got the "${tag.text}" tag!` : "Tag removed");
  });

  // Admin assigned (or removed) a VIP Name Effect style while we're online.
  // Only affects the Room Seat name glow/animation (see renderSeats) — the
  // active room, if any, is already refreshed via the "room-state" push
  // that comes alongside this from the server; this just keeps `me` and a
  // friendly toast in sync.
  socket.on("name-effect-updated", (nameEffect) => {
    me.nameEffect = nameEffect;
    saveSession();
    toast(nameEffect ? "✨ You received a new VIP Name Style!" : "VIP Name Style removed");
  });

  socket.on("room-profile-style-update", (data) => {
    if (!data || !data.userId) return;
    Object.values(seatMap).forEach((seat) => {
      if (!seat || seat.userId !== data.userId) return;
      seat.customTag = data.customTag || null;
      seat.nameEffect = data.nameEffect || null;
      seat.activeFrame = data.activeFrame || null;
      seat.vipLevel = data.vipLevel || 0;
      seat.activeBadges = Array.isArray(data.activeBadges) ? data.activeBadges : [];
    });
    if (currentRoom) renderSeats(seatsFromMap());
  });

  // Admin set (or cleared) our Custom ID Number while we're online.
  socket.on("custom-id-updated", (data) => {
    me.customId = data.customId;
    saveSession();
    applyIdDisplay($("profile-userid"), me);
  const genderBadge = $("pp-gender-badge");
  if (genderBadge) {
    genderBadge.textContent = me.gender === "Female" ? "♀" : me.gender === "Male" ? "♂" : "⚧";
    genderBadge.style.background = me.gender === "Female" ? "#ff8ab5" : me.gender === "Male" ? "#5AA9FF" : "#b48cff";
  }
  const countryBadge = $("pp-country-badge");
  if (countryBadge) countryBadge.textContent = flagEmoji(me.country) || "🌐";
    toast(me.customId ? `✨ Your Custom ID: ${me.customId}` : "Custom ID removed");
  });

  // Admin sent (or removed) a premium badge (Blue Diamond V etc. — see
  // badges.js). If it's about us, keep `me` in sync so it shows on our own
  // seat/profile immediately. If we currently have that user's profile
  // open (view-other-profile), refresh the badge there too — Room Seat
  // itself already refreshes on its own via the "room-state" push that
  // comes alongside this from the server (see badges.js's notifyUser()).
  socket.on("user_badges_update", (data) => {
    if (!data || !data.userId) return;
    if (data.userId === me.userId) {
      me.activeBadges = data.badges || [];
      saveSession();
      toast((data.badges || []).includes("blue_diamond_v") ? "💎 You received a new Badge!" : "A badge was removed");
    }
    if (otherProfileUser && otherProfileUser.userId === data.userId) {
      otherProfileUser.activeBadges = data.badges || [];
      applyBlueBadge($("other-blue-badge"), otherProfileUser.activeBadges);
    }
  });

  // Admin changed a badge's Room Seat / Profile size from the panel
  // (badges.js /api/admin/badges/size) — broadcast to everyone since it
  // changes how the badge renders for every viewer, not just its owner.
  // Re-render whatever's currently visible so it takes effect without a
  // page refresh.
  socket.on("badge_catalog_update", (data) => {
    if (!data || !Array.isArray(data.catalog)) return;
    badgeCatalogCache = {};
    data.catalog.forEach((b) => { badgeCatalogCache[b.id] = b; });
    if (otherProfileUser) applyBlueBadge($("other-blue-badge"), otherProfileUser.activeBadges);
    if (currentRoom) renderSeats(seatsFromMap());
  });

  socket.on("voice-offer", async (data) => {
    const pc = getOrCreatePeer(data.from);
    // Perfect-negotiation-style collision handling: if we're also in the
    // middle of sending our own offer to this same peer, the "polite" side
    // rolls its offer back and accepts theirs instead; the "impolite" side
    // ignores the incoming one and lets its own offer win. Without this,
    // whichever side's setRemoteDescription(offer) landed second used to
    // throw (wrong signalingState) and silently kill that pair's audio.
    const collision = pc.makingOffer || pc.signalingState !== "stable";
    if (collision && !pc.polite) return; // impolite side: ignore, our offer wins
    try {
      if (localStream) {
        const hasAudioSender = pc.getSenders().some(s => s.track && s.track.kind === "audio");
        if (!hasAudioSender) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      }
      if (collision) {
        await Promise.all([
          pc.setLocalDescription({ type: "rollback" }),
          pc.setRemoteDescription(new RTCSessionDescription(data.offer))
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(applyOpusFEC(answer));
      socket.emit("voice-answer", { target: data.from, targetUserId: userIdForSocketId(data.from), answer: pc.localDescription });
    } catch (e) { /* stale/duplicate offer arrived after peer was already torn down */ }
  });

  socket.on("voice-answer", async (data) => {
    const pc = peerConnections[data.from];
    // Duplicate-answer guard: an answer only ever makes sense while we're
    // actually waiting on one (have-local-offer). A retransmitted/duplicate
    // signaling message or one that arrives after the negotiation already
    // settled would otherwise throw on setRemoteDescription and, in some
    // browsers, leave the connection in a half-negotiated state.
    if (pc && pc.signalingState === "have-local-offer") {
      try { await pc.setRemoteDescription(new RTCSessionDescription(data.answer)); } catch (e) { /* stale answer */ }
    }
  });

  socket.on("voice-candidate", async (data) => {
    const pc = peerConnections[data.from];
    if (pc && data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
    }
  });

  // Phase 1 / Tier A (server-side complement, see voice-reconnect.js): the
  // server tells the room when a seated peer enters/leaves its reconnect
  // grace period. This doesn't replace the existing ICE-restart/rebuild
  // logic in getOrCreatePeer() — it just gives it context: hold off on
  // tearing a peer connection down while `reconnectingPeerUserIds` has
  // them, and actively re-offer the instant they're confirmed back rather
  // than waiting on our own ICE timers to notice.
  socket.on("voice-peer-reconnecting", ({ userId }) => {
    if (userId) reconnectingPeerUserIds.add(userId);
  });
  socket.on("voice-peer-resumed", ({ userId }) => {
    if (!userId) return;
    reconnectingPeerUserIds.delete(userId);
    const entry = Object.values(seatMap).find((s) => s && s.userId === userId);
    // Audience listeners must also recover when a speaker's socket changes.
    // Previously this was gated by mySeatNumber, so an audience member could
    // keep an old peer connection forever and never re-offer to the speaker's
    // new socket after a reconnect.
    if (entry && entry.socketId && entry.socketId !== socket.id) {
      connectToPeer(entry.socketId, true);
    }
  });

  // Fix (fatal crash on every page load): these four handlers used to sit
  // at the top level of the script, far below this function, calling
  // socket.on(...) while the module-level `socket` variable was still null
  // (this function — the only place that assigns it — hadn't run yet). That
  // threw an uncaught TypeError on every single page load, which silently
  // aborted the rest of the script's top-to-bottom execution, including the
  // bootstrap() call at the very end of the file. Login still worked
  // because its button listener happened to be registered earlier in the
  // file, before the crash point — but refresh never ran bootstrap() at
  // all, so no session/room restore ever happened; the socket from before
  // the refresh was just gone, and after 8s the grace period expired and
  // the seat got freed. Moved here, alongside every other socket.on(...)
  // call, where `socket` is guaranteed to actually exist.
  socket.on("seat-invite", ({ seatNumber, fromName }) => {
    if (!currentRoomId) return;
    if (confirm(`${fromName} invited you to seat ${seatNumber}. Join?`)) {
      socket.emit("take-seat", { roomId: currentRoomId, seatNumber });
    }
  });
  socket.on("mod-mute-update", ({ targetUserIds, mutedUntil }) => {
    if (!targetUserIds.includes(me.userId)) return;
    hostMutedUntil = mutedUntil || 0;
    if (hostMutedUntil) {
      micEnabled = false;
      if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
      $("btn-mic-toggle").classList.remove("active");
      $("btn-mic-toggle").disabled = true;
      toast("The Host has muted your mic");
    } else {
      $("btn-mic-toggle").disabled = false;
      toast("Your mic has been unmuted");
    }
  });
  socket.on("mod-announcement", ({ fromName, message }) => {
    toast(`${fromName}: ${message}`);
  });
  socket.on("theme-library-update", (themes) => { themeLibraryCache = themes; renderThemeLibraryGrid(); });
  // Fix (Room Lock save had no explicit confirmation, 2026-07-29): the
  // server has emitted "room-lock-saved" right after persisting a lock/
  // unlock since Phase 11, but no client handler ever listened for it —
  // the UI only updated indirectly via the room-wide "room-state" broadcast
  // a moment later, with no direct feedback to the person who just tapped
  // Save. That's not what caused settings to fail to persist, but it is
  // exactly why a successful save could still read as "did that even do
  // anything?" from the owner's side. Now it gives an explicit toast.
  socket.on("room-lock-saved", ({ locked }) => {
    toast(locked ? "Room Lock enabled 🔒" : "Room Lock disabled");
  });

  // ROOT-CAUSE FIX (2026-08-01, session-restore / settings-icon dead —
  // the real cause, not the earlier partial fixes): these two listeners
  // used to sit at the very bottom of this file as bare top-level
  // statements — `socket.on("level-info-data", ...)` and
  // `socket.on("id-level-up", ...)` — instead of inside connectSocket()
  // like every other socket.on(...) call in this file. `socket` is
  // `null` until connectSocket() actually runs, so on every single page
  // load the browser hit `socket.on(...)` on a null value while
  // executing the script top-to-bottom, threw a TypeError right there,
  // and — because this is a plain synchronous <script> tag, not
  // something wrapped in try/catch — every line AFTER that point in the
  // file simply never ran. That included the Settings-gear click-handler
  // registration (btn-room-mod, further down) and the bootstrap() call
  // at the very end of the file. So: the Settings icon looked dead
  // because its click listener was never attached, and refresh always
  // showed the login screen because bootstrap()/loadSession()/session-
  // restore never even ran — not because the token or session logic
  // itself was wrong. All the earlier defensive fixes (retry logic,
  // try/catch, Logout Lock, etc.) were real improvements but could never
  // fix this, because the crash happened before any of that code was
  // reachable on page load. Moving these two listeners inside
  // connectSocket() — where they're re-registered on every (re)connect,
  // exactly like the other handlers above — removes the null-socket
  // crash entirely.
  socket.on("level-info-data", (info) => {
    levelInfoCache = info;
    if (!$("modal-level-info").classList.contains("hidden")) renderLevelInfo();
  });
  socket.on("id-level-up", (info) => {
    levelInfoCache = info;
    if (!$("modal-level-info").classList.contains("hidden")) renderLevelInfo();
    toast(`🎉 Level Up! You're now Level ${info.currentLevel}`);
    const badge = $("level-info-badge");
    badge.classList.remove("level-up-pulse");
    void badge.offsetWidth; // restart the animation even if it's already mid-play
    badge.classList.add("level-up-pulse");
  });
  // UPGRADE (2026-08-04, Level Management) — GLOBAL THEME UPDATE: when an
  // admin saves a new theme for a level group, every online user currently
  // in that group sees it live, no reload. Registered here inside
  // connectSocket() (not as a bare top-level statement) for the exact same
  // reason as the two listeners above — see the ROOT-CAUSE FIX comment.
  socket.on("level-theme-update", (data) => {
    if (levelInfoCache && levelInfoCache.groupIndex === data.groupIndex) {
      levelInfoCache.theme = data.theme;
      if (!$("modal-level-info").classList.contains("hidden")) renderLevelInfo();
    }
  });
}

function rejoinRoom() {
  if (!currentRoomId) return;
  // ROOT-CAUSE FIX (2026-08-14, reconnect/duplicate join-room audit): a
  // real Socket.IO reconnect always gets a brand-new socket.id server-side
  // (server-side room/seat/presence state is keyed off the connection, not
  // the browser tab), so any previous joinedRoomId ack was for a socket
  // that no longer exists and must never be treated as "still joined" —
  // always rejoin here. Still guarded by joinInProgress so two "connect"
  // events firing close together (observed in the rapid-reconnect logs)
  // cannot fire two overlapping "join-room" emits for the same socket.
  joinedRoomId = null;
  if (joinInProgress) {
    pendingJoinRequest = { roomId: currentRoomId, password: undefined };
    return;
  }
  joinInProgress = true;
  pendingJoinRequest = null;
  $("chat-log").innerHTML = "";
  setRoomLogo(null);
  applyRoomBackground("");
  socket.emit("join-room", { roomId: currentRoomId, userId: me.userId, userName: me.name, userPhoto: me.photo || "" });
  loadGiftBanner(currentRoomId);
  showView("view-room");
  notifyAndroidVoiceSession(true); // PHASE 3 item #4 fix
}

// ===========================================================================
// HOME / ROOM LIST
// ===========================================================================
function fillHomeProfile() {
  // Home no longer renders the old profile/name/VIP strip. Keep this updater
  // backward-compatible with other screens by guarding optional Home nodes.
  const coins = $("home-coins");
  const diamonds = $("home-diamonds");
  if (coins) coins.textContent = me.coins;
  if (diamonds) diamonds.textContent = me.diamonds;
  try { refreshGodPowerInvisibleRow(); } catch (e) { console.error("fillHomeProfile: godpower row", e); }
  try { const el = $("home-avatar"); if (el) el.src = me.photo || placeholderAvatar(me.name); } catch (e) { console.error("fillHomeProfile: avatar", e); }
  try { const el = $("home-username"); if (el) el.textContent = me.name; } catch (e) { console.error("fillHomeProfile: username", e); }
  try { const el = $("home-vip-badge"); if (el) applyVipBadge(el, me.vipLevel); } catch (e) { console.error("fillHomeProfile: vip badge", e); }
  try { const el = $("home-tag-badge"); if (el) applyCustomTag(el, me.customTag); } catch (e) { console.error("fillHomeProfile: custom tag", e); }
  try { const el = $("home-avatar-frame"); if (el) applyFrameRing(el, me.vipLevel); } catch (e) { console.error("fillHomeProfile: frame ring", e); }
  try { const el = $("home-avatar-frame"); if (el) applyCustomFrame(el, me.activeFrame); } catch (e) { console.error("fillHomeProfile: custom frame", e); }
  try { refreshMySvipTag(); } catch (e) { console.error("fillHomeProfile: svip tag", e); }
  try { checkAgencyMenu(); } catch (e) { console.error("fillHomeProfile: agency menu", e); }
  try { checkCoinCenterMenu(); } catch (e) { console.error("fillHomeProfile: coin center menu", e); }
  try { checkHostCenterMenu(); } catch (e) { console.error("fillHomeProfile: host center menu", e); }
}

async function loadAnnouncements() {
  const r = await api("/api/announcements");
  if (r.success && r.announcements.length) {
    const box = $("home-announcements");
    box.classList.remove("hidden");
    box.textContent = "📢 " + r.announcements[0].text;
  }
}

async function checkAgencyMenu() {
  const r = await api("/api/agency/mine/" + me.userId);
  $("menu-agency").classList.toggle("hidden", !(r.success && r.agency));
}
// Host Center menu entry shows only once this account has actually become
// an Agency Host (via admin assignment or accepting an Agency invitation) —
// agencyId is the reliable signal; isHost alone just means "owns a room".
function checkHostCenterMenu() {
  $("menu-host-center").classList.toggle("hidden", !me.agencyId);
}
// Shows the Coin Center menu entry only if Admin has designated this exact
// User ID as a Coin Center operator (see /api/coin-center/mine/:userId).
// Never a self-service toggle — only Admin Panel controls this.
async function checkCoinCenterMenu() {
  const r = await api("/api/coin-center/mine/" + me.userId);
  $("menu-coin-center").classList.toggle("hidden", !(r.success && r.account && r.account.enabled));
}
function placeholderAvatar(name) {
  const initial = (name || "U").trim().charAt(0).toUpperCase();
  return "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#34244C"/><text x="50" y="62" font-size="40" fill="#F0A868" text-anchor="middle" font-family="sans-serif">${initial}</text></svg>`
  );
}

let roomListCache = [];
async function loadRoomList() {
  const r = await api("/api/room/list");
  if (r.success) {
    roomListCache = Array.isArray(r.rooms) ? r.rooms : [];
    renderRoomList(getHomeRoomsForMode());
  }
}

function renderRoomList(rooms) {
  renderHomeMyRoomCard();
  renderMyRoomPanel();
  const wrap = $("room-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  const visibleRooms = Array.isArray(rooms) ? rooms : getHomeRoomsForMode();
  $("room-empty")?.classList.toggle("hidden", visibleRooms.length > 0);
  visibleRooms.forEach((room) => {
    const card = document.createElement("div");
    card.className = "room-card";
    const avatarUrls = (room.onlineAvatars || []).filter(Boolean).slice(0, 4);
    const extraCount = Math.max(0, (room.onlineCount || 0) - avatarUrls.length);
    const avatarsHtml = avatarUrls.map((url) => `<img src="${escapeHtml(url)}" alt="">`).join("") +
      (extraCount > 0 ? `<span class="avatar-stack-more">+${extraCount}</span>` : "");
    const badge = room.hostBadge;
    const badgeColor = badge && badge.color ? badge.color : "#B8860B";
    const badgeHtml = badge && badge.text ? `<span class="host-badge" style="background:${escapeHtml(badgeColor)}22;color:${escapeHtml(badgeColor)}">👑 ${escapeHtml(badge.text)}</span>` : "";
    const roomId = room.roomNumber || room.roomId || "—";
    const hostId = room.hostId || "—";
    card.innerHTML = `
      <div class="room-card-icon">${room.logo ? `<img src="${escapeHtml(room.logo)}" alt="">` : "🎙️"}</div>
      <div class="room-card-body">
        <h3>${room.countryFlag ? `<span class="room-flag">${room.countryFlag}</span>` : ""}${escapeHtml(room.roomName || "Room")}${room.roomLocked ? '<span class="room-card-lock" title="Locked">🔒</span>' : ""}</h3>
        <span class="room-card-host">ID: ${escapeHtml(hostId)} · Room #${escapeHtml(roomId)}</span>
        ${badgeHtml}
        <div class="room-card-meta"><div class="avatar-stack">${avatarsHtml}</div><span class="online-pill"><span class="live-dot"></span> ${Number(room.onlineCount || 0)}</span></div>
      </div>`;
    card.addEventListener("click", () => joinRoom(room.roomId));
    wrap.appendChild(card);
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

// ===========================================================================
// HOME SCREEN — PRIMARY NAV + FIXED SECONDARY TABS
// ===========================================================================
const SOCIAL_PAGE_SIZE = 20;
let socialTab = "recently";
let homePrimaryTab = "mine";
let recentRoomsCache = [], recentRoomsShown = 0;
let followingCache = [], followingShown = 0;
let myRoomCache = [];
let popularFilter = "recommend";
let homeSearchOpen = false;
let homeSearchTerm = "";

function formatVisitTime(iso) {
  if (!iso) return "";
  const d = new Date(iso), now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const timeStr = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Today • ${timeStr}`;
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return `Yesterday • ${timeStr}`;
  return d.toLocaleDateString("en-GB") + " • " + timeStr;
}

document.querySelectorAll(".social-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchSocialTab(btn.dataset.tab));
});

document.querySelectorAll(".home-primary-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchHomePrimaryTab(btn.dataset.homeTab));
});

function setHomePopularChrome(isPopular) {
  $("banner-slider-container")?.classList.toggle("hidden", !isPopular);
  $("home-popular-tools")?.classList.toggle("hidden", !isPopular);
  $("home-popular-filter")?.classList.toggle("hidden", !isPopular);
  $("social-tabs")?.classList.toggle("hidden", isPopular);
  $("home-my-room-card")?.classList.toggle("hidden", isPopular || !getMyRooms().length);
}

function getHomeRoomsForMode() {
  let rooms = [...roomListCache];
  const term = homeSearchTerm.trim().toLowerCase();
  if (term) {
    rooms = rooms.filter((r) =>
      String(r.roomName || "").toLowerCase().includes(term) ||
      String(r.hostName || "").toLowerCase().includes(term) ||
      String(r.hostId || "").toLowerCase().includes(term) ||
      String(r.roomNumber || "").toLowerCase().includes(term) ||
      String(r.roomId || "").toLowerCase().includes(term)
    );
  }
  if (homePrimaryTab === "mine") {
    const mine = rooms.filter((r) => String(r.hostId || "") === String(me.userId));
    const others = rooms.filter((r) => String(r.hostId || "") !== String(me.userId));
    return [...mine, ...others];
  }
  if (homePrimaryTab === "popular") {
    if (popularFilter === "new") {
      return rooms.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }
    return rooms.sort((a, b) => (b.onlineCount || 0) - (a.onlineCount || 0));
  }
  return rooms;
}

function renderPopularSummary() {
  const rooms = [...roomListCache];
  const live = rooms.filter(r => (r.onlineCount || 0) > 0);
  const hosts = new Set(rooms.map(r => String(r.hostId || "")).filter(Boolean));
  const cp = rooms.reduce((n, r) => n + Number(r.onlineCount || 0), 0);
  if ($("popular-ranking-count")) $("popular-ranking-count").textContent = String(Math.min(99, live.length));
  if ($("popular-club-count")) $("popular-club-count").textContent = String(Math.min(99, hosts.size));
  if ($("popular-cp-count")) $("popular-cp-count").textContent = String(Math.min(999, cp));
}

function switchHomePrimaryTab(tab) {
  homePrimaryTab = tab;
  document.querySelectorAll(".home-primary-tab").forEach((b) => b.classList.toggle("active", b.dataset.homeTab === tab));
  setHomePopularChrome(tab === "popular");
  if (tab === "popular") {
    ["live", "recently", "following", "myroom"].forEach((t) => $("social-panel-" + t)?.classList.add("hidden"));
    $("home-room-section-title").textContent = "Popular Rooms";
    renderPopularSummary();
    renderRoomList(getHomeRoomsForMode());
    return;
  }
  $("home-room-section-title").textContent = tab === "explore" ? "Explore Rooms" : "Rooms";
  $("social-panel-live")?.classList.remove("hidden");
  $("social-panel-recently")?.classList.add("hidden");
  $("social-panel-following")?.classList.add("hidden");
  $("social-panel-myroom")?.classList.add("hidden");
  renderRoomList(getHomeRoomsForMode());
}

function switchSocialTab(tab) {
  socialTab = tab;
  ["live", "recently", "following", "myroom"].forEach((t) => {
    const panel = $("social-panel-" + t);
    if (panel) panel.classList.toggle("hidden", t !== tab && !(t === "live" && tab === "recently"));
  });
  document.querySelectorAll(".social-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  // Recently is the default room-discovery pane. Following/My Room are
  // independent panes and replace the room list in the scroll area.
  if (tab === "recently") {
    $("social-panel-live")?.classList.remove("hidden");
    $("social-panel-recently")?.classList.add("hidden");
    $("social-panel-following")?.classList.add("hidden");
    $("social-panel-myroom")?.classList.add("hidden");
    loadRoomList();
  } else if (tab === "following") {
    $("social-panel-live")?.classList.add("hidden");
    $("social-panel-recently")?.classList.add("hidden");
    $("social-panel-myroom")?.classList.add("hidden");
    $("social-panel-following")?.classList.remove("hidden");
    loadFollowingLive();
  } else {
    $("social-panel-live")?.classList.add("hidden");
    $("social-panel-recently")?.classList.add("hidden");
    $("social-panel-following")?.classList.add("hidden");
    $("social-panel-myroom")?.classList.remove("hidden");
    renderMyRoomPanel();
  }
}
function loadActiveSocialTab() { switchSocialTab(socialTab); }

// ---- Recently ----
async function loadRecentRooms() {
  const r = await api(`/api/recent-rooms/${me.userId}`);
  if (!r.success) return;
  recentRoomsCache = r.recentRooms; recentRoomsShown = 0;
  renderRecentRoomsPage();
}
function renderRecentRoomsPage() {
  const wrap = $("recent-rooms-list");
  if (recentRoomsShown === 0) wrap.innerHTML = "";
  $("recent-rooms-empty").classList.toggle("hidden", recentRoomsCache.length > 0);
  recentRoomsCache.slice(recentRoomsShown, recentRoomsShown + SOCIAL_PAGE_SIZE).forEach((entry) => {
    const item = document.createElement("div");
    item.className = "social-item";
    item.innerHTML = `
      <div class="social-item-icon">🎙️</div>
      <div class="social-item-body">
        <h3>${escapeHtml(entry.roomName)}</h3>
        <span class="sub">#${escapeHtml(entry.roomNumber)} · Visited: ${formatVisitTime(entry.lastVisitAt)} · ${entry.isLive ? `👥 ${entry.onlineCount} Online` : "Closed"}</span>
      </div>
      <button class="btn btn-primary btn-sm join-btn" ${entry.isLive ? "" : "disabled"}>Join</button>
    `;
    if (entry.isLive) item.querySelector(".join-btn").addEventListener("click", () => joinRoom(entry.roomId));
    wrap.appendChild(item);
  });
  recentRoomsShown += Math.min(SOCIAL_PAGE_SIZE, recentRoomsCache.length - recentRoomsShown);
  $("btn-recent-load-more").classList.toggle("hidden", recentRoomsShown >= recentRoomsCache.length);
}
$("btn-recent-load-more").addEventListener("click", renderRecentRoomsPage);
$("btn-clear-recent").addEventListener("click", async () => {
  if (!confirm("Clear all history?")) return;
  const r = await api(`/api/recent-rooms/${me.userId}`, "DELETE");
  if (r.success) loadRecentRooms();
});

// ---- Following ----
async function loadFollowingLive() {
  const r = await api(`/api/following-live/${me.userId}`);
  if (!r.success) return;
  followingCache = r.following; followingShown = 0;
  renderFollowingPage();
}
function followingItemHtml(f) {
  const statusClass = (f.live || f.online) ? "online" : "offline";
  return `
    <div class="social-item-icon">${f.photo ? `<img src="${escapeHtml(f.photo)}" alt="">` : "👤"}<span class="status-dot ${statusClass}"></span></div>
    <div class="social-item-body">
      <h3>${escapeHtml(f.name)}${f.live ? '<span class="live-badge">Live</span>' : ""}</h3>
      <span class="sub">ID: ${escapeHtml(f.userId)}${f.live ? ` · Room: #${escapeHtml(f.roomNumber)} ${escapeHtml(f.roomName)}` : (f.online ? " · Online" : " · Offline")}</span>
    </div>
    <button class="btn btn-primary btn-sm join-btn" ${f.live ? "" : "disabled"}>Join</button>
  `;
}
function renderFollowingPage() {
  const wrap = $("following-list");
  if (followingShown === 0) wrap.innerHTML = "";
  $("following-empty").classList.toggle("hidden", followingCache.length > 0);
  followingCache.slice(followingShown, followingShown + SOCIAL_PAGE_SIZE).forEach((f) => {
    const item = document.createElement("div");
    item.className = "social-item";
    item.dataset.userId = f.userId;
    item.innerHTML = followingItemHtml(f);
    if (f.live) item.querySelector(".join-btn").addEventListener("click", () => joinRoom(f.roomId));
    wrap.appendChild(item);
  });
  followingShown += Math.min(SOCIAL_PAGE_SIZE, followingCache.length - followingShown);
  $("btn-following-load-more").classList.toggle("hidden", followingShown >= followingCache.length);
}
$("btn-following-load-more").addEventListener("click", renderFollowingPage);
function handleFollowStatusUpdate(update) {
  const idx = followingCache.findIndex((f) => f.userId === update.userId);
  if (idx === -1) return; // someone we don't follow, or Following tab not loaded yet
  followingCache[idx] = {
    ...followingCache[idx],
    online: update.status !== "offline", live: update.status === "live",
    roomId: update.roomId, roomNumber: update.roomNumber, roomName: update.roomName
  };
  if (socialTab !== "following") return;
  const el = document.querySelector(`#following-list .social-item[data-user-id="${update.userId}"]`);
  if (!el) return;
  el.innerHTML = followingItemHtml(followingCache[idx]);
  if (followingCache[idx].live) el.querySelector(".join-btn").addEventListener("click", () => joinRoom(followingCache[idx].roomId));
}

// ---- My Room (replaces the old Groups tab on Home) ----
function getMyRooms() {
  return (roomListCache || []).filter((r) => String(r.hostId || "") === String(me.userId));
}
function renderMyRoomPanel() {
  const rooms = getMyRooms();
  myRoomCache = rooms;
  const wrap = $("my-room-list");
  wrap.innerHTML = "";
  $("my-room-empty").classList.toggle("hidden", rooms.length > 0);
  rooms.forEach((room) => {
    const item = document.createElement("div");
    item.className = "social-item my-room-item";
    item.innerHTML = `
      <div class="social-item-icon">${room.logo ? `<img src="${escapeHtml(room.logo)}" alt="">` : "🎙️"}</div>
      <div class="social-item-body">
        <h3>${room.countryFlag ? `<span class="room-flag">${room.countryFlag}</span>` : ""}${escapeHtml(room.roomName)}</h3>
        <span class="sub">#${escapeHtml(room.roomNumber)} · ${room.onlineCount || 0} Online</span>
      </div>
      <button class="btn btn-primary btn-sm join-btn">Open</button>
    `;
    item.querySelector(".join-btn").addEventListener("click", () => joinRoom(room.roomId));
    wrap.appendChild(item);
  });
}

function renderHomeMyRoomCard() {
  const rooms = getMyRooms();
  const card = $("home-my-room-card");
  if (!card) return;
  const room = rooms[0];
  card.classList.toggle("hidden", !room);
  if (!room) return;
  const logo = $("home-my-room-logo");
  logo.src = room.logo || "/images/room-default-theme.jpg";
  $("home-my-room-name").textContent = room.roomName || "My Room";
  $("home-my-room-flag").textContent = room.countryFlag || "";
  $("home-my-room-meta").textContent = `#${room.roomNumber || room.roomId} · ${room.onlineCount || 0} Online`;
  $("home-my-room-online").textContent = room.onlineCount || 0;
  card.onclick = () => joinRoom(room.roomId);
}

$("btn-create-my-room")?.addEventListener("click", () => $("btn-create-room").click());
$("btn-home-search")?.addEventListener("click", () => {
  homeSearchOpen = !homeSearchOpen;
  $("home-search-bar")?.classList.toggle("hidden", !homeSearchOpen);
  if (homeSearchOpen) { $("home-search-input")?.focus(); }
});
$("home-search-input")?.addEventListener("input", (e) => {
  homeSearchTerm = e.target.value || "";
  renderRoomList(getHomeRoomsForMode());
});
$("home-search-clear")?.addEventListener("click", () => {
  homeSearchTerm = "";
  if ($("home-search-input")) $("home-search-input").value = "";
  renderRoomList(getHomeRoomsForMode());
});
document.querySelectorAll("[data-popular-filter]").forEach((btn) => btn.addEventListener("click", () => {
  popularFilter = btn.dataset.popularFilter;
  document.querySelectorAll("[data-popular-filter]").forEach(b => b.classList.toggle("active", b === btn));
  renderRoomList(getHomeRoomsForMode());
}));

document.querySelectorAll("[data-popular-tool]").forEach((btn) => btn.addEventListener("click", () => {
  const mode = btn.dataset.popularTool;
  document.querySelectorAll("[data-popular-tool]").forEach(b => b.classList.toggle("selected", b === btn));
  if (mode === "club") { window.location.href = "/club/"; return; }
  if (mode === "ranking") { window.location.href = "/rankings/rooms.html"; return; }
  if (mode === "cp") { window.location.href = "/rankings/cp.html"; return; }
  let rooms = getHomeRoomsForMode();
  if (mode === "ranking" || mode === "cp") rooms.sort((a, b) => (b.onlineCount || 0) - (a.onlineCount || 0));
  if (mode === "club") rooms.sort((a, b) => String(a.hostName || "").localeCompare(String(b.hostName || "")));
  const label = mode === "ranking" ? "Ranking Rooms" : mode === "club" ? "Club Rooms" : "CP Rooms";
  if ($("home-room-section-title")) $("home-room-section-title").textContent = label;
  renderRoomList(rooms);
}));

// Shows/hides the room logo in the room header — used on join and whenever
// the owner/admin changes it live.
function setRoomLogo(url) {
  const img = $("room-logo-display");
  if (!img) return;
  if (url) { img.src = url; img.classList.remove("hidden"); }
  else { img.src = ""; img.classList.add("hidden"); }
}

$("btn-create-room").addEventListener("click", () => {
  $("create-room-name").value = "";
  $("modal-create-room").classList.remove("hidden");
});
$("btn-cancel-create-room").addEventListener("click", () => $("modal-create-room").classList.add("hidden"));
$("btn-confirm-create-room").addEventListener("click", async () => {
  const roomName = $("create-room-name").value.trim();
  const r = await api("/api/room/create", "POST", { roomName, userId: me.userId, userName: me.name });
  $("modal-create-room").classList.add("hidden");
  if (r.success) { joinRoom(r.room.roomId); return; }
  if (r.existingRoomId) {
    if (confirm(r.message + "\n\nGo to your existing room?")) joinRoom(r.existingRoomId);
  } else toast(r.message || "Couldn't create the room");
});

document.querySelectorAll('.nav-btn[data-nav="home"]').forEach((b) => b.addEventListener("click", () => { showView("view-home"); loadRoomList(); loadActiveSocialTab(); }));
document.querySelectorAll('.nav-btn[data-nav="profile"]').forEach((b) => b.addEventListener("click", openOwnProfile));
document.querySelectorAll('.nav-btn[data-nav="inbox"]').forEach((b) => b.addEventListener("click", openInbox));

// ===========================================================================
// VOICE ROOM
// ===========================================================================
async function joinRoom(roomId, password) {
  const meta = roomListCache.find((r) => r.roomId === roomId);
  if (meta && meta.roomLocked && !password) {
    promptRoomPassword(roomId);
    return;
  }
  // ROOT-CAUSE FIX (2026-08-14, duplicate join-room / rapid room-switch
  // audit): three guards that were entirely missing before.
  // 1) Already fully joined to this exact room — a double-tap on the same
  //    room card (or a redundant call from create-room's "go to existing
  //    room" flow) must not re-emit "join-room"; it's a no-op.
  if (joinedRoomId === roomId && currentRoomId === roomId && !password) {
    showView("view-room");
    return;
  }
  // 2) A join is already in flight (waiting on the server's "room-state"
  //    ack). Remember only the LATEST requested room/password and return —
  //    the queued request is dispatched from the "room-state" handler once
  //    the in-flight join settles, so rapid tapping across several rooms
  //    (A -> B -> A) collapses to a single, serialized, last-write-wins
  //    join instead of firing overlapping "join-room" emits.
  if (joinInProgress) {
    pendingJoinRequest = { roomId, password };
    return;
  }
  joinInProgress = true;
  pendingJoinRequest = null;
  currentRoomId = roomId;
  saveActiveRoom(roomId);
  mySeatNumber = null;
  closeRoomGame();
  teardownYtPlayer();
  seatMap = {};
  currentRelationshipLinks = [];
  speakingUsers.clear();
  $("chat-log").innerHTML = "";
  $("btn-room-mod").classList.add("hidden");
  setRoomLogo(null);
  // Phase 3 / Step 3.3: decide mesh vs SFU BEFORE any seat/mic logic for
  // this room can fire (room-state / seat-update handlers below all read
  // voiceMode). Awaited here (unlike the reconnect path above) since a
  // fresh room join is exactly the moment the spec calls out: "At room
  // join, call GET /api/voice-sfu/mode."
  await refreshVoiceMode();
  socket.emit("join-room", { roomId, userId: me.userId, userName: me.name, userPhoto: me.photo || "", password: password || undefined });
  $("gift-banner").innerHTML = "";
  showView("view-room");
  notifyAndroidVoiceSession(true); // PHASE 3 item #4 fix
}

// Room Lock (#11): shown either when the cached room list already flags a
// room as locked, or reactively when the server rejects a join with
// needPassword (e.g. a stale/uncached room list, or a wrong password retry).
function promptRoomPassword(roomId) {
  $("room-password-input").value = "";
  $("modal-room-password").dataset.roomId = roomId;
  $("modal-room-password").classList.remove("hidden");
  $("room-password-input").focus();
}
$("btn-room-password-submit").addEventListener("click", () => {
  const roomId = $("modal-room-password").dataset.roomId;
  const password = $("room-password-input").value;
  if (!password) { toast("Enter Password"); return; }
  $("modal-room-password").classList.add("hidden");
  joinRoom(roomId, password);
});
$("room-password-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-room-password-submit").click();
});
$("btn-room-password-cancel").addEventListener("click", () => {
  $("modal-room-password").classList.add("hidden");
});

$("btn-leave-room").addEventListener("click", () => {
  if (currentRoomId) socket.emit("leave-room", { roomId: currentRoomId, userId: me.userId });
  teardownVoice();
  if (window.PingPongRobin?.isActive?.()) window.PingPongRobin.stop();
  stopChestCountdown();
  closeRoomGame();
  teardownYtPlayer();
  currentRoomId = null;
  currentRoom = null;
  joinedRoomId = null; joinInProgress = false; pendingJoinRequest = null; // join-lifecycle guard (2026-08-14 fix)
  saveActiveRoom(null);
  showView("view-home");
  loadRoomList();
});

// Resets the YouTube Room Player to a clean slate when leaving a room (or
// just before joining a different one) — otherwise a stale player instance
// or a previous room's playlist could bleed into the next room's view.
function teardownYtPlayer() {
  clearInterval(ytDriftTimer); ytDriftTimer = null;
  if (ytPlayer && typeof ytPlayer.destroy === "function") { try { ytPlayer.destroy(); } catch (_) {} }
  ytPlayer = null;
  ytPendingLoad = null;
  ytCurrentPlaylist = [];
  ytPlayerState = { mode: false, currentIndex: -1, isPlaying: false, position: 0, updatedAt: Date.now() };
  canControlYt = false;
  $("yt-player-wrap").classList.add("hidden");
  syncYtHeaderClass();
  $("btn-toggle-yt").classList.remove("active");
  $("modal-yt-playlist").classList.add("hidden");
}

function hydrateSeatMap(seats) {
  seatMap = {};
  mySeatNumber = null;
  seats.forEach((seat, i) => {
    if (seat) {
      seatMap[i + 1] = { userId: seat.userId, socketId: seat.socketId, userName: seat.userName, userPhoto: seat.userPhoto, role: seat.role, activeFrame: seat.activeFrame || null, vipLevel: seat.vipLevel || 0, customTag: seat.customTag || null, nameEffect: seat.nameEffect || null, modLabel: seat.modLabel || null, micMuted: !!seat.micMuted, activeBadges: seat.activeBadges || [] };
      if (seat.userId === me.userId) mySeatNumber = i + 1;
    }
  });
  // Authoritative room-state hydration can be the first place where the
  // browser learns that this user is seated. The old hands-free Robin flow
  // only started from the incremental `seat-update` event, so a perfectly
  // valid room-state-first join could leave the customer seated with no Vapi
  // call and no server-side symptom. Trigger the same idempotent lifecycle
  // hook after hydration; it is safe because cs101MaybeGreetOnSeat() has a
  // per-seat key and Vapi start() itself is duplicate-safe.
  if (mySeatNumber != null && typeof cs101MaybeGreetOnSeat === "function") {
    setTimeout(() => {
      try { cs101MaybeGreetOnSeat(); } catch (err) {
        console.warn("[Robin] seat hydration auto-start hook failed:", err);
      }
    }, 0);
  }
}
function seatsFromMap() {
  const seats = Array(8).fill(null);
  Object.keys(seatMap).forEach((num) => {
    const entry = seatMap[num];
    seats[num - 1] = {
      userId: entry.userId,
      userName: entry.userName || currentRoom?.onlineUsers?.find(u => u.userId === entry.userId)?.userName || "User",
      userPhoto: entry.userPhoto || "",
      socketId: entry.socketId,
      role: entry.role,
      activeFrame: entry.activeFrame || null,
      vipLevel: entry.vipLevel || 0,
      customTag: entry.customTag || null,
      nameEffect: entry.nameEffect || null,
      modLabel: entry.modLabel || null,
      micMuted: !!entry.micMuted,
      activeBadges: entry.activeBadges || []
    };
  });
  return seats;
}

function cs101IsOfficialRoom() {
  return !!(currentRoom && (currentRoom.roomId === "101" || currentRoom.aiCustomerService === true));
}

let cs101ConfigClient = { enabled:true, agentName:"AI Customer Service", avatarUrl:"/photos/cs101-female.svg", voiceEnabled:true, voiceRate:0.98, voicePitch:1.04 };
let cs101GreetedSeatKey = null;
let cs101AutoListening = false;
let cs101VoiceReady = false;
let cs101LastSpokenText = "";
// Guarantee-Robin-speaks fallback: set true the moment a Vapi call attempt
// fails for the current seat visit. While true, the browser
// SpeechRecognition/SpeechSynthesis bridge is allowed to run even though
// Vapi is "enabled" in config — because "enabled" only means configured,
// not that the live call actually succeeded. Reset to false on every new
// seat-sit so a later, working attempt still prefers Vapi.
let cs101VapiUnavailableThisVisit = false;

function cs101VoiceBridgeAllowed() {
  // Browser speech is a fallback only: it becomes available after Vapi
  // fails for the current seat visit. It must never compete with an active
  // Vapi call.
  return cs101IsOfficialRoom() && mySeatNumber != null &&
    cs101VapiUnavailableThisVisit === true &&
    cs101ConfigClient.voiceEnabled !== false;
}

// Wired as window.PingPongRobin.onVoiceFailure — called by vapi-support.js
// the instant a call attempt fails to connect or drops with an error, for
// ANY reason (bad key, unpublished assistant, network, blocked mic). This
// is what makes "Robin will speak" not depend on a third-party service
// working: the moment Vapi can't be reached, the room falls back to the
// app's own server (text AI reply) + the browser's own speech synthesis,
// neither of which needs Vapi/Daily.co at all.
function cs101FallbackAfterVapiFailure() {
  if (!cs101IsOfficialRoom() || mySeatNumber == null || !socket) return;
  if (cs101VapiUnavailableThisVisit) return; // already switched over for this seat visit
  cs101VapiUnavailableThisVisit = true;
  socket.emit("cs101:greet");
}

// Wired as window.PingPongRobin.onVoiceStart — called the moment Vapi
// genuinely connects. If the fallback bridge had already been switched on
// (e.g. the watchdog below fired a little early on a slow connection, and
// Vapi went on to connect anyway a few seconds later), this hands the seat
// back to Vapi and stops the browser mic listener/speech so only ONE
// voice path is ever active for the seat at a time.
function cs101CancelFallback() {
  cs101VapiUnavailableThisVisit = false;
  cs101StopRecognition();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function renderCs101Seat(info) {
  const el = $("cs101-ai-seat");
  if (!el) return;
  const show = cs101IsOfficialRoom() && cs101ConfigClient.enabled !== false;
  el.classList.toggle("hidden", !show);
  if (!show) return;
  const img = $("cs101-ai-avatar-img");
  if (img) img.src = cs101ConfigClient.avatarUrl || "/photos/cs101-female.svg";
  const name = $("cs101-ai-seat-name");
  if (name) name.textContent = cs101ConfigClient.agentName || "AI Customer Service";
}

function cs101AppendMessage(role, text) {
  const log = $("cs101-log");
  if (!log || !text) return;
  const el = document.createElement("div");
  el.className = `cs101-msg ${role === "user" ? "user" : "ai"}`;
  el.textContent = text;
  log.appendChild(el);
  while (log.children.length > 40) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function cs101ChooseFemaleVoice(lang) {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  const femaleHints = /female|woman|zira|samantha|susan|karen|hazel|aria|jenny|sonia|heera|priya|veena|google.*hindi|google.*bengali|microsoft.*zira|microsoft.*heera/i;
  const prefix = String(lang || "en").split("-")[0].toLowerCase();
  const sameLanguage = voices.filter(v => String(v.lang || "").toLowerCase().startsWith(prefix));
  return sameLanguage.find(v => femaleHints.test(v.name || "")) ||
         sameLanguage.find(v => /female|woman/i.test(v.name || "")) ||
         voices.find(v => femaleHints.test(v.name || "")) ||
         sameLanguage[0] || voices[0] || null;
}
if ("speechSynthesis" in window) {
  const warmVoices = () => { cs101VoiceReady = true; try { window.speechSynthesis.getVoices(); } catch (_) {} };
  warmVoices();
  window.speechSynthesis.onvoiceschanged = warmVoices;
}

function cs101StopRecognition() {
  if (cs101Recognition) {
    try { cs101Recognition.stop(); } catch (_) {}
  }
  cs101Listening = false;
  cs101AutoListening = false;
}

function cs101Speak(text, voiceMeta = {}) {
  if (!cs101VoiceBridgeAllowed() || window.PingPongRobin?.isActive?.()) return Promise.resolve();
  return new Promise((resolve) => {
    if (!text || !cs101ConfigClient.voiceEnabled || !("speechSynthesis" in window)) return resolve();
    const spoken = String(text).trim();
    if (!spoken || spoken === cs101LastSpokenText) return resolve();
    cs101LastSpokenText = spoken;
    cs101StopRecognition();
    try {
      const synth = window.speechSynthesis;
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(spoken.slice(0, 1800));
      const preferred = String(voiceMeta.language || (me && me.language) || "").toLowerCase();
      const lang = preferred.startsWith("bn") ? "bn-IN" : (preferred.startsWith("hi") ? "hi-IN" : (/^[\u0980-\u09FF]/.test(spoken) ? "bn-IN" : (/^[\u0900-\u097F]/.test(spoken) ? "hi-IN" : "en-IN")));
      utter.lang = lang;
      const voice = cs101ChooseFemaleVoice(lang);
      if (voice) utter.voice = voice;
      utter.rate = Number(voiceMeta.rate || cs101ConfigClient.voiceRate || 0.96);
      utter.pitch = Number(voiceMeta.pitch || cs101ConfigClient.voicePitch || 1.08);
      utter.volume = 1;
      const done = () => { if (cs101IsOfficialRoom() && mySeatNumber != null) setTimeout(cs101StartAutoRecognition, 650); resolve(); };
      utter.onend = done;
      utter.onerror = done;
      // A tiny deferred speak is more reliable on Android when voices are still loading.
      setTimeout(() => { try { synth.speak(utter); } catch (_) { resolve(); } }, cs101VoiceReady ? 0 : 120);
    } catch (_) { resolve(); }
  });
}
function cs101SendText(text) {
  const value = String(text || "").trim();
  if (!value || !socket || currentRoomId !== "101") return;
  cs101AppendMessage("user", value);
  cs101History.push({ role: "user", content: value });
  while (cs101History.length > 12) cs101History.shift();
  socket.emit("cs101:message", { roomId: "101", text: value, history: cs101History });
}

function cs101StartAutoRecognition() {
  if (!cs101VoiceBridgeAllowed()) return;
  // Belt-and-suspenders: never open a second mic listener while Vapi
  // itself reports an active call, even if the fallback flag above is
  // somehow stale. Two concurrent getUserMedia consumers is exactly the
  // "spoke once then stopped responding" failure mode.
  if (window.PingPongRobin?.isActive?.()) return;
  if (currentRoomId !== "101" || mySeatNumber == null || cs101AutoListening) return;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;
  const r = new Recognition();
  cs101Recognition = r;
  const browserLang = String(navigator.language || "en-IN").toLowerCase();
  r.lang = browserLang.startsWith("bn") ? "bn-IN" : (browserLang.startsWith("hi") ? "hi-IN" : "en-IN");
  r.continuous = false;
  r.interimResults = false;
  r.maxAlternatives = 1;
  r.onstart = () => { cs101Listening = true; cs101AutoListening = true; };
  r.onresult = (event) => {
    const text = event.results?.[0]?.[0]?.transcript || "";
    if (text) cs101SendText(text);
  };
  r.onerror = () => { cs101Listening = false; cs101AutoListening = false; };
  r.onend = () => { cs101Listening = false; cs101AutoListening = false; };
  try { r.start(); } catch (_) { cs101Listening = false; cs101AutoListening = false; }
}

function cs101MaybeGreetOnSeat() {
  if (!cs101IsOfficialRoom() || mySeatNumber == null || !socket) {
    if (mySeatNumber == null) cs101GreetedSeatKey = null;
    return;
  }
  const key = `${currentRoomId}:${me?.userId || ""}:${mySeatNumber}`;
  if (cs101GreetedSeatKey === key) return;
  console.log("[Robin] Customer Service seat detected", { roomId: currentRoomId, seat: mySeatNumber, userId: me?.userId });

  // Hands-free production behavior: the moment the customer occupies a
  // seat in Room 101, start the real Vapi conversation. Do NOT gate this on
  // the async config preload flag: a slow mobile/tunnel response used to make
  // the seat event happen first, permanently skipping Robin for that visit.
  // autoStartForCustomerServiceSeat() now owns config loading/retries.
  const start = async () => {
    if (currentRoomId !== "101" || mySeatNumber == null) return;
    if (typeof window.PingPongRobin?.autoStartForCustomerServiceSeat !== "function") {
      return;
    }
    try {
      const started = await window.PingPongRobin.autoStartForCustomerServiceSeat();
      if (started || window.PingPongRobin?.isActive?.()) {
        cs101GreetedSeatKey = key;
      } else {
        // Keep the seat un-greeted so a late script/config/permission
        // readiness event can retry without requiring the customer to leave
        // and re-enter the seat.
        cs101GreetedSeatKey = null;
      }
    } catch (err) {
      cs101GreetedSeatKey = null;
      console.warn("[Robin] automatic Vapi start failed; retrying while seated:", err);
    }
  };

  // The Vapi script may load just after app.js. Give it a short, bounded
  // retry window; no UI interaction is required.
  let tries = 0;
  const waitForVapi = () => {
    if (currentRoomId !== "101" || mySeatNumber == null) return;
    if (typeof window.PingPongRobin?.autoStartForCustomerServiceSeat === "function") {
      start();
      return;
    }
    if (++tries < 150) setTimeout(waitForVapi, 100);
    else console.warn("[Robin] Vapi client did not load; automatic voice was not started.");
  };
  waitForVapi();
}
function initCs101Ui() {
  // Room 101 is intentionally hands-free: no Talk/Send controls are shown.
  const panel = $("cs101-panel");
  if (panel) panel.classList.add("hidden");
  if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
  // Wired every time (idempotent) rather than once at load, since
  // vapi-support.js and app.js load order isn't guaranteed and
  // window.PingPongRobin only exists once vapi-support.js has run.
  // BUG FIX (2026-08-14): cs101FallbackAfterVapiFailure/cs101CancelFallback
  // were defined but never actually assigned to window.PingPongRobin's
  // onVoiceFailure/onVoiceStart hooks, so the browser-speech fallback that
  // is supposed to guarantee Robin still talks when the Vapi cloud call
  // fails (bad key, unpublished assistant, blocked mic, network drop) never
  // ran. Every customer whose Vapi call failed got silence instead of the
  // fallback voice. Assigning it here (idempotent — same functions every
  // call) is what actually turns the fallback on.
  if (window.PingPongRobin) {
    window.PingPongRobin.onVoiceFailure = cs101FallbackAfterVapiFailure;
    window.PingPongRobin.onVoiceStart = cs101CancelFallback;
  }

  renderCs101Seat();
  cs101MaybeGreetOnSeat();
}

function renderSeats(seats) {
  const grid = $("seat-grid");
  grid.innerHTML = "";
  renderCs101Seat();
  initCs101Ui();
  const locked = (currentRoom && currentRoom.lockedSeats) || [];
  seats.forEach((seat, i) => {
    const seatNumber = i + 1;
    const isLocked = locked.includes(seatNumber);
    const div = document.createElement("div");
    div.className = "seat" + (seat ? " occupied" : "") + (isLocked ? " locked" : "") +
      (seat && speakingUsers.has(seat.userId) ? " speaking" : "");
    if (seat) div.dataset.userId = seat.userId;
    const circle = document.createElement("div");
    circle.className = "seat-circle";
    if (seat) {
      const photoWrap = document.createElement("div");
      photoWrap.className = "seat-avatar-photo";
      const img = document.createElement("img");
      img.src = seat.userPhoto || placeholderAvatar(seat.userName);
      photoWrap.appendChild(img);
      circle.appendChild(photoWrap);
      if (seat.vipLevel > 0) applyFrameRing(circle, seat.vipLevel);
      applyCustomFrame(circle, seat.activeFrame);
      if (seat.role === "owner" || seat.role === "admin") {
        const badge = document.createElement("span");
        badge.className = "seat-role";
        badge.textContent = seat.role === "owner" ? "👑" : "🛡️";
        div.style.position = "relative";
        div.appendChild(badge);
      }
      if (seat.micMuted) {
        const muteBadge = document.createElement("span");
        muteBadge.className = "seat-mic-muted";
        muteBadge.textContent = "🔇";
        div.style.position = "relative";
        div.appendChild(muteBadge);
      }
      // Premium badges (Blue Diamond V etc., admin-granted only — see
      // badges.js). Small 16px overlay, top-right above the avatar, same
      // absolutely-positioned-on-`div` technique as .seat-role above.
      if (seat.activeBadges && seat.activeBadges.includes("blue_diamond_v")) {
        const blueBadge = document.createElement("img");
        blueBadge.className = "seat-blue-badge";
        blueBadge.src = "/images/badges/blue_diamond_v.png";
        blueBadge.alt = "Blue Diamond V";
        const cfg = badgeCatalogCache.blue_diamond_v;
        if (cfg && cfg.seatSize) { blueBadge.style.width = cfg.seatSize + "px"; blueBadge.style.height = cfg.seatSize + "px"; }
        div.style.position = "relative";
        div.appendChild(blueBadge);
      }
    } else {
      circle.textContent = "＋";
    }
    div.appendChild(circle);
    const nameEl = document.createElement("span");
    nameEl.className = "seat-name" + (seat && seat.nameEffect ? " name-fx-" + seat.nameEffect : "");
    nameEl.textContent = seat ? seat.userName : ("No." + seatNumber);
    if (seat && seat.customTag && seat.customTag.color) {
      nameEl.style.color = seat.customTag.color;
      nameEl.style.textShadow = `0 0 6px ${seat.customTag.color}, 0 0 12px ${seat.customTag.color}66`;
    }
    div.appendChild(nameEl);
    if (seat && seat.customTag && seat.customTag.text) {
      const tagEl = document.createElement("span");
      applyCustomTag(tagEl, seat.customTag, true);
      div.appendChild(tagEl);
    }
    if (seat && seat.modLabel && seat.modLabel.text) {
      const labelEl = document.createElement("span");
      labelEl.className = "tag-badge tag-badge-sm";
      labelEl.style.background = seat.modLabel.color || "#F7CE7E";
      labelEl.style.color = tagTextColor(seat.modLabel.color);
      labelEl.textContent = seat.modLabel.text;
      div.appendChild(labelEl);
    }

    div.addEventListener("click", () => {
      if (!seat) {
        const isOwner = currentRoom && currentRoom.hostId === me.userId;
        const isAdmin = currentRoom && (currentRoom.adminIds || []).includes(me.userId);
        if (isOwner || isAdmin) {
          openEmptySeatManagePopup(seatNumber);
        } else {
          socket.emit("take-seat", { roomId: currentRoomId, seatNumber });
        }
      } else {
        openSeatProfileSheet(seat.userId, seatNumber);
      }
    });
    grid.appendChild(div);
  });
  renderRelationshipLinks((currentRoom && currentRoom.relationshipLinks) || currentRelationshipLinks || []);
}

function renderRelationshipLinks(links) {
  const grid = $("seat-grid");
  if (!grid) return;
  currentRelationshipLinks = Array.isArray(links) ? links : [];
  const old = grid.querySelector(".relationship-link-layer");
  if (old) old.remove();
  if (!currentRelationshipLinks.length) return;
  const layer = document.createElement("div");
  layer.className = "relationship-link-layer";
  grid.appendChild(layer);
  const gridRect = grid.getBoundingClientRect();
  currentRelationshipLinks.forEach((rel) => {
    // DEFENSE IN DEPTH (spec section 4 — "the client should also
    // defensively ignore invalid/non-adjacent relationship links"): the
    // server already only emits adjacent links (friendshipCp.js
    // getSeatRelationshipLinks -> areAdjacentSeats), but the client never
    // trusts that alone. A stale/duplicate/malformed link is dropped here
    // too rather than rendered.
    if (!clientAreAdjacentSeats(rel.seatA, rel.seatB)) return;
    const a = grid.querySelector(`.seat:nth-child(${rel.seatA})`);
    const b = grid.querySelector(`.seat:nth-child(${rel.seatB})`);
    if (!a || !b) return;
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    const ax = ar.left + ar.width / 2 - gridRect.left;
    const ay = ar.top + ar.height / 2 - gridRect.top;
    const bx = br.left + br.width / 2 - gridRect.left;
    const by = br.top + br.height / 2 - gridRect.top;
    const x = (ax + bx) / 2;
    const y = (ay + by) / 2 - Math.min(10, Math.abs(bx - ax) * 0.02);
    const img = document.createElement("img");
    img.className = "relationship-link " + (rel.type === "cp" ? "cp" : "friendship");
    const cfg = rel.type === "cp" ? relationshipVisualConfig.cp : relationshipVisualConfig.friendship;
    img.src = cfg.assetUrl;
    img.alt = rel.type === "cp" ? "CP" : "Friendship";
    // Offset applied directly to position (not via CSS transform) so it
    // can never fight with the float keyframe's own transform. Scale is
    // set as a per-element CSS variable so the shared float keyframe can
    // multiply it in correctly regardless of type — see style.css.
    img.style.left = (x + (cfg.offsetX || 0)) + "px";
    img.style.top = (y + (cfg.offsetY || 0)) + "px";
    img.style.setProperty("--rel-scale", cfg.scale != null ? cfg.scale : 1);
    layer.appendChild(img);
  });
}

// ---------------- CP/Friendship visual config (Admin Panel controlled) ----------------
// Mirrors seatAdjacency.js's grid topology on the client, so a stale/bad
// link from the server (or from an older cached room-state) can never
// render a heart between non-adjacent seats — see the defensive check in
// renderRelationshipLinks above. Kept in sync with the server's
// RELATIONSHIP_SEAT_GRID_COLUMNS default (4); the server is the source of
// truth, this is only a client-side safety net.
const RELATIONSHIP_SEAT_GRID_COLUMNS = 4;
function clientAreAdjacentSeats(seatA, seatB) {
  const a = Number(seatA), b = Number(seatB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a === b) return false;
  const rowA = Math.floor((a - 1) / RELATIONSHIP_SEAT_GRID_COLUMNS), colA = (a - 1) % RELATIONSHIP_SEAT_GRID_COLUMNS;
  const rowB = Math.floor((b - 1) / RELATIONSHIP_SEAT_GRID_COLUMNS), colB = (b - 1) % RELATIONSHIP_SEAT_GRID_COLUMNS;
  const rowDiff = Math.abs(rowA - rowB), colDiff = Math.abs(colA - colB);
  return (rowDiff === 0 && colDiff === 1) || (colDiff === 0 && rowDiff === 1);
}

let relationshipVisualConfigLoaded = false;
let relationshipVisualConfig = {
  version: 0,
  cp: { width: 126, height: 126, scale: 1, opacity: 0.98, animationEnabled: true, animationSpeedSec: 2.1, offsetX: 0, offsetY: 0, assetUrl: "/images/relationships/cp-heart.png" },
  friendship: { width: 104, height: 104, scale: 1, opacity: 0.98, animationEnabled: true, animationSpeedSec: 2.7, offsetX: 0, offsetY: 0, assetUrl: "/images/relationships/friendship-heart.png" }
};

function applyRelationshipVisualConfig(config) {
  if (!config || !config.cp || !config.friendship) return;
  relationshipVisualConfig = config;
  relationshipVisualConfigLoaded = true;
  const root = document.documentElement.style;
  ["cp", "friendship"].forEach((kind) => {
    const c = config[kind];
    root.setProperty(`--${kind}-width`, c.width + "px");
    root.setProperty(`--${kind}-height`, c.height + "px");
    root.setProperty(`--${kind}-opacity`, c.opacity);
    root.setProperty(`--${kind}-anim-duration`, c.animationEnabled ? (c.animationSpeedSec + "s") : "0s");
  });
  // Config (size/opacity/asset/etc.) changed — re-render any currently
  // visible hearts so an admin's change is reflected immediately (TEST 9,
  // TEST 11) without needing a seat change to trigger a re-render.
  if (currentRoom) renderRelationshipLinks(currentRelationshipLinks);
}

async function fetchRelationshipVisualConfig() {
  try {
    const r = await api("/api/relationships/config");
    if (r && r.success && r.config) applyRelationshipVisualConfig(r.config);
  } catch (err) {
    console.error("[relationship-config] fetch failed:", err);
  }
}

window.addEventListener("resize", () => {
  if (currentRoom && currentRoomId) renderRelationshipLinks((currentRoom && currentRoom.relationshipLinks) || currentRelationshipLinks);
});

// ---------------- Chat ----------------
const CHAT_MESSAGE_TTL_MS = 60 * 1000;

// ROOT-CAUSE FIX (duplicate chat message render): the server issues a
// unique `id` per message specifically so the client can dedupe strictly
// by id instead of guessing by content (see performSendMessage() in
// server.js). This tracks which message ids are currently rendered in
// #chat-log so a duplicate "new-message" delivery (socket reconnect
// resend, a forwarded cross-instance op retried, etc.) never produces a
// second UI item for the same message.
const renderedChatMsgIds = new Set();

function renderChatLog(messages) {
  const log = $("chat-log");
  log.innerHTML = "";
  renderedChatMsgIds.clear();
  const now = Date.now();
  const visible = (Array.isArray(messages) ? messages : []).filter((msg) => {
    if (!msg || !msg.createdAt) return true;
    return now - Number(msg.createdAt) < CHAT_MESSAGE_TTL_MS;
  });
  log.classList.toggle("empty", visible.length === 0);
  visible.forEach(appendChatMsg);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

const MAX_VISIBLE_MESSAGES = 30;

// BOTTOM-UP ACTIVITY FEED (chat + gifts share this one flow):
// generalized expiry helper — any entry (chat line or gift notice) fades
// out and is removed after `ttlMs` from `createdAt` (defaults to "now",
// which is what gift notices — which have no server createdAt — use).
// Kept as one shared implementation so chat and gifts age out identically
// and neither can leak a stray setTimeout/DOM node.
function scheduleActivityExpiry(div, createdAt, ttlMs, onExpire) {
  createdAt = Number(createdAt || Date.now());
  const remaining = ttlMs - (Date.now() - createdAt);
  if (remaining <= 0) {
    div.remove();
    if (onExpire) onExpire();
    return;
  }
  div.dataset.expiresAt = String(createdAt + ttlMs);
  window.setTimeout(() => {
    if (!div.isConnected) return;
    div.classList.add("chat-msg-expiring");
    window.setTimeout(() => {
      div.remove();
      if (onExpire) onExpire();
      const log = $("chat-log");
      if (log && !log.children.length) log.classList.add("empty");
    }, 260);
  }, remaining);
}

function scheduleChatExpiry(div, msg) {
  if (!msg || !msg.createdAt) return; // no createdAt (older persisted rows) — never auto-expire, same as before this refactor
  scheduleActivityExpiry(div, msg.createdAt, CHAT_MESSAGE_TTL_MS, () => {
    if (msg && msg.id != null) renderedChatMsgIds.delete(msg.id);
  });
}

// §7-10: normal chat renders as a single notification-style line ("Name:
// message"), not a left/right WhatsApp-style bubble — the room's bottom-up
// activity feed (below) is the only presentation now. The container
// (#chat-log), its bottom-anchored stacking/scroll, its 60s TTL and its
// duplicate-delivery dedupe are untouched from before this change.
function appendChatMsg(msg) {
  if (msg && msg.id != null) {
    if (renderedChatMsgIds.has(msg.id)) return; // duplicate delivery — already rendered
    renderedChatMsgIds.add(msg.id);
  }
  const log = $("chat-log");
  log.classList.remove("empty");
  const div = document.createElement("div");
  const isMine = !msg.system && me && String(msg.userId) === String(me.userId);
  div.className = "chat-msg activity-line" + (msg.system ? " system" : "") + (isMine ? " mine" : "");
  if (msg.system) {
    div.innerHTML = `<span class="chat-system-pill">${escapeHtml(msg.message)}</span>`;
  } else {
    const tag = (msg.customTag && msg.customTag.text) ? msg.customTag : (typeof msg.customTag === "string" ? { text: msg.customTag, color: "#F7CE7E" } : null);
    const tagHtml = tag?.text
      ? `<span class="tag-badge tag-badge-sm chat-floating-tag" style="background:${escapeHtml(tag.color || "#F7CE7E")};color:${tagTextColor(tag.color)}">${escapeHtml(tag.text)}</span>`
      : "";
    const nameColor = tag?.color || null;
    const nameStyle = nameColor ? ` style="color:${escapeHtml(nameColor)};text-shadow:0 0 6px ${escapeHtml(nameColor)},0 0 12px ${escapeHtml(nameColor)}66;"` : "";
    // Room chat is intentionally message-only: no sender name, tag, copy
    // affordance, diamonds, or extra metadata. The bubble itself is the
    // activity item and the chat log is bottom-anchored so new messages
    // appear from the bottom and older messages stack upward.
    div.innerHTML = `
      <div class="activity-pill message-only-pill">
        <span class="chat-text">${escapeHtml(msg.message)}</span>
      </div>`;
  }
  if (msg && msg.id != null) div.dataset.msgId = String(msg.id);
  log.appendChild(div);

  while (log.children.length > MAX_VISIBLE_MESSAGES) {
    const oldest = log.firstChild;
    if (oldest && oldest.dataset && oldest.dataset.msgId != null) renderedChatMsgIds.delete(oldest.dataset.msgId);
    log.removeChild(oldest);
  }
  scheduleChatExpiry(div, msg);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

// §12-13: gift activity shares the exact same bottom-up feed/container as
// chat (#chat-log) — same entry animation, same upward stacking, same
// auto-expiry — per spec "gift and chat must share the same flow". This
// never touches the full-screen video-gift-overlay (§14): that overlay is
// a separate, higher-stacked layer (z-index 9999 vs. this feed's 1, see
// style.css) that already fully covers it while a special/video gift is
// playing, so a normal gift notice here can never appear drawn over it.
const GIFT_NOTICE_TTL_MS = 30000;
function appendGiftMsg(data) {
  const log = $("chat-log");
  if (!log || !data || !data.gift) return;
  log.classList.remove("empty");
  const div = document.createElement("div");
  div.className = "chat-msg activity-line gift-notice";
  const qty = Number(data.quantity || 1);
  const iconHtml = data.gift.image ? `<img class="gift-notice-icon" src="${escapeHtml(data.gift.image)}" alt="">` : `<span class="gift-notice-icon">🎁</span>`;
  // Gift notices use the same bottom-up activity path as room chat, but
  // deliberately omit sender/receiver names and diamond amounts. The gift
  // itself (icon + name/quantity) is the only inbox activity shown.
  div.innerHTML = `
    <div class="activity-pill gift-pill message-only-pill">
      ${iconHtml}
      <span class="chat-text">${escapeHtml(data.gift.name || "Gift")}${qty > 1 ? ` ×${qty}` : ""}</span>
    </div>`;
  log.appendChild(div);
  while (log.children.length > MAX_VISIBLE_MESSAGES) {
    const oldest = log.firstChild;
    if (oldest && oldest.dataset && oldest.dataset.msgId != null) renderedChatMsgIds.delete(oldest.dataset.msgId);
    log.removeChild(oldest);
  }
  scheduleActivityExpiry(div, Date.now(), GIFT_NOTICE_TTL_MS);
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

$("btn-send-chat").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
function sendChat() {
  const input = $("chat-input");
  const message = input.value.trim();
  if (!message) return;
  socket.emit("send-message", { roomId: currentRoomId, message });
  input.value = "";
}

function vipLevelFromDiamondsClient(diamonds) {
  if (diamonds >= 5000) return 5;
  if (diamonds >= 2000) return 4;
  if (diamonds >= 800) return 3;
  if (diamonds >= 300) return 2;
  if (diamonds >= 50) return 1;
  return 0;
}

function pushGiftBanner(_text) {
  // Intentionally disabled: gift sends are represented by the animation only.
  const banner = $("gift-banner");
  if (banner) banner.innerHTML = "";
}


// Floating gift animation across the stage — its own absolute layer,
// never touches seat-grid layout/dimensions. Flies from the sender's seat
// to the receiver's seat when both are seated, otherwise falls back to a
// simple center float so it never breaks for un-seated senders/receivers.
function seatCircleRect(userId) {
  const el = document.querySelector(`#seat-grid [data-user-id="${userId}"] .seat-circle`);
  if (!el) return null;
  return el.getBoundingClientRect();
}
// Combo tracking: keys off sender+receiver+gift so repeat-tapping the same
// gift at the same target inside the combo window shows an escalating
// "x2 / x3 / ..." badge instead of just stacking silent icons. Purely a
// presentation layer — doesn't touch the actual send/credit logic at all.
const GIFT_COMBO_WINDOW_MS = 2200;
const giftComboState = new Map();
function trackGiftCombo(gift, fromUserId, toUserId) {
  const key = `${fromUserId}_${toUserId}_${gift.id || gift.name}`;
  const now = Date.now();
  const prev = giftComboState.get(key);
  const count = prev && (now - prev.at) < GIFT_COMBO_WINDOW_MS ? prev.count + 1 : 1;
  giftComboState.set(key, { at: now, count });
  return count;
}
function spawnGiftComboBadge(count, end, layer) {
  if (count < 2) return;
  const badge = document.createElement("div");
  badge.className = "gift-combo-badge";
  badge.textContent = "x" + count;
  badge.style.left = end.x + "%";
  badge.style.top = end.y + "%";
  layer.appendChild(badge);
  setTimeout(() => badge.remove(), 750);
}
function spawnGiftFly(gift, fromUserId, toUserId) {
  const layer = $("gift-fly-layer");
  if (!layer) return;
  const tier = gift.tier || "normal";
  const layerRect = layer.getBoundingClientRect();
  const fromRect = seatCircleRect(fromUserId);
  const toRect = seatCircleRect(toUserId);

  const pct = (rect, fallbackX, fallbackY) => {
    if (!rect || !layerRect.width || !layerRect.height) return { x: fallbackX, y: fallbackY };
    const cx = rect.left + rect.width / 2 - layerRect.left;
    const cy = rect.top + rect.height / 2 - layerRect.top;
    return { x: (cx / layerRect.width) * 100, y: (cy / layerRect.height) * 100 };
  };
  const start = pct(fromRect, 50, 92);
  const end = pct(toRect, 50, 10);

  const trailCount = tier === "legend" ? 4 : tier === "vip" ? 3 : 1;
  const duration = tier === "legend" ? 3.0 : tier === "vip" ? 2.4 : 1.8;
  const iconHtml = gift.image ? `<img src="${gift.image}" alt="">` : "🎁";

  for (let i = 0; i < trailCount; i++) {
    const el = document.createElement("div");
    el.className = "gift-fly-item tier-" + tier + (i > 0 ? " gift-fly-trail" : "");
    el.innerHTML = iconHtml;
    el.style.setProperty("--start-x", start.x + "%");
    el.style.setProperty("--start-y", start.y + "%");
    el.style.setProperty("--end-x", end.x + "%");
    el.style.setProperty("--end-y", end.y + "%");
    el.style.animationDuration = duration + "s";
    el.style.animationDelay = (i * 0.08) + "s";
    if (i > 0) el.style.opacity = String(0.5 - i * 0.1);
    layer.appendChild(el);
    setTimeout(() => el.remove(), (duration + 0.5) * 1000);
  }

  // Combo badge fires slightly after the icon lands so it reads as "impact"
  // rather than competing with the flight animation for attention.
  const comboCount = trackGiftCombo(gift, fromUserId, toUserId);
  setTimeout(() => spawnGiftComboBadge(comboCount, end, layer), duration * 1000 * 0.8);

  // Full Screen Effect gifts (Treasure Chest, Neon Rocket, Golden Car,
  // Phoenix, and anything else the admin marks as Full Screen) also get the
  // room-wide overlay. Small Effect gifts stop at the fly animation above.
  if (gift.effectType === "full_screen") spawnFullScreenGiftEffect(gift);
}

// Full-screen celebration for Full Screen Effect gifts — its own fixed
// overlay, completely separate from the room layout so it never resizes
// anything. Includes a large animation, particles, a flash, a shockwave
// ring, and a light camera shake, per the Gift Manager spec.
//
// Queued (2026-08-18 upgrade): back-to-back full-screen gifts used to share
// one timer, so a second legend/VIP gift landing mid-celebration would just
// cut the first one's animation off early. Now each full-screen gift is
// queued and gets its complete, uninterrupted run before the next one starts.
const legendGiftQueue = [];
let legendGiftPlaying = false;
function spawnFullScreenGiftEffect(gift) {
  legendGiftQueue.push(gift);
  processLegendGiftQueue();
}
function processLegendGiftQueue() {
  if (legendGiftPlaying) return;
  const gift = legendGiftQueue.shift();
  if (!gift) return;
  legendGiftPlaying = true;

  const overlay = $("legend-gift-overlay");
  if (!overlay) { legendGiftPlaying = false; processLegendGiftQueue(); return; }
  const tier = gift.tier || "legend";
  overlay.classList.toggle("overlay-tier-vip", tier === "vip");
  $("legend-gift-emoji").innerHTML = gift.image ? `<img src="${gift.image}" alt="">` : "🎁";
  $("legend-gift-text").textContent = `${gift.name} 🔥`;

  // Flash — one-shot pulse, removed after its animation finishes.
  const flash = document.createElement("div");
  flash.className = "legend-flash";
  overlay.appendChild(flash);
  setTimeout(() => flash.remove(), 550);

  // Shockwave ring — a single expanding ring on impact, layered under the
  // particle burst for extra visual weight on the top gift tiers.
  const shockwave = document.createElement("div");
  shockwave.className = "legend-shockwave";
  overlay.appendChild(shockwave);
  setTimeout(() => shockwave.remove(), 750);

  // Particles — a small burst radiating outward from center (color themed
  // via .overlay-tier-vip in CSS).
  const particleCount = 18;
  for (let i = 0; i < particleCount; i++) {
    const p = document.createElement("div");
    p.className = "legend-particle";
    const angle = (Math.PI * 2 * i) / particleCount + Math.random() * 0.3;
    const dist = 120 + Math.random() * 140;
    p.style.setProperty("--px", Math.cos(angle) * dist + "px");
    p.style.setProperty("--py", Math.sin(angle) * dist + "px");
    p.style.animationDelay = (Math.random() * 0.15) + "s";
    overlay.appendChild(p);
    setTimeout(() => p.remove(), 1700);
  }

  overlay.classList.remove("hidden");
  overlay.classList.remove("gift-shake");
  void overlay.offsetWidth; // restart the shake animation even on back-to-back gifts
  overlay.classList.add("show", "gift-shake");
  setTimeout(() => {
    overlay.classList.remove("show");
    setTimeout(() => {
      overlay.classList.add("hidden");
      legendGiftPlaying = false;
      processLegendGiftQueue(); // start the next queued gift, if any
    }, 300);
  }, 2400);
}

// Brief glow pulse on the receiver's seat the instant a gift lands.
function flashSeatReceive(userId) {
  const el = document.querySelector(`#seat-grid [data-user-id="${userId}"] .seat-circle`);
  if (!el) return;
  el.classList.add("gift-hit");
  setTimeout(() => el.classList.remove("gift-hit"), 900);
}

// Plays the gift's own admin-uploaded MP3 sound if there is one; falls back
// to the original synthesized per-tier chime for gifts an admin hasn't
// attached a sound file to yet, so nothing ever plays silently.
let audioCtx = null;
function ensureAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}
function playGiftSound(gift) {
  if (gift && gift.sound) {
    try {
      const audio = new Audio(gift.sound);
      audio.volume = 0.85;
      audio.play().catch(() => playSynthGiftChime(gift && gift.tier));
      return;
    } catch (e) { /* fall through to synth chime */ }
  }
  playSynthGiftChime(gift && gift.tier);
}
function playSynthGiftChime(tier) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const freqsByTier = { normal: [660], vip: [660, 880], legend: [660, 880, 1100, 1320] };
  const freqs = freqsByTier[tier] || freqsByTier.normal;
  freqs.forEach((f, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    const t0 = now + i * 0.09;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.42);
  });
}

async function loadGiftBanner(roomId) {
  const r = await api("/api/gifts/history?roomId=" + roomId);
  $("gift-banner").innerHTML = "";
  if (r.success) r.gifts.slice(0, 3).reverse().forEach(g => pushGiftBanner(`${g.fromName} sent 🎁 ${g.gift.name}`));
}

// ---------------- Gifts ----------------
let activeGiftTier = "normal";
let selectedGiftId = null;
let selectedVideoGiftId = null;
// Gift Manager gifts carry an admin-uploaded PNG (g.image) instead of the
// old hardcoded emoji. Falls back to a generic gift icon if an admin hasn't
// uploaded an image yet, so the catalog never shows a blank tile.
function giftIconHtml(g) {
  return g.image
    ? `<img src="${g.image}" class="emoji" style="width:32px;height:32px;object-fit:contain;">`
    : `<span class="emoji">🎁</span>`;
}
function updateGiftSendButton() {
  const btn = $("btn-send-gift");
  if (!btn) return;
  const hasSelection = activeGiftTier === "custom" ? !!selectedVideoGiftId : !!selectedGiftId;
  btn.disabled = !hasSelection;
  btn.classList.toggle("ready", hasSelection);
}
function selectGiftItem(item, g, isVideo) {
  document.querySelectorAll("#gift-catalog .gift-item").forEach(el => el.classList.remove("selected"));
  item.classList.add("selected");
  if (isVideo) {
    selectedVideoGiftId = g.id;
    selectedGiftId = null;
  } else {
    selectedGiftId = g.id;
    selectedVideoGiftId = null;
  }
  showGiftPreview(g, isVideo);
  updateGiftSendButton();
}
function renderGiftGrid() {
  const grid = $("gift-catalog");
  grid.innerHTML = "";
  if (activeGiftTier === "custom") { renderVideoGiftGrid(grid); updateGiftSendButton(); return; }
  GIFT_CATALOG_CACHE.gifts.filter(g => (g.tier || "normal") === activeGiftTier).forEach((g) => {
    const item = document.createElement("div");
    item.className = "gift-item tier-" + (g.tier || "normal") + (selectedGiftId === g.id ? " selected" : "");
    item.innerHTML = `${giftIconHtml(g)}<span class="gift-name">${escapeHtml(g.name)}</span><span class="price">${g.price} <img src="/images/icons/icon-coin.png" class="currency-icon" alt="coin"></span>`;
    item.addEventListener("mouseenter", () => showGiftPreview(g));
    item.addEventListener("touchstart", () => showGiftPreview(g), { passive: true });
    item.addEventListener("click", () => selectGiftItem(item, g, false));
    grid.appendChild(item);
  });
  updateGiftSendButton();
}
// Custom tab — admin-uploaded Video Gifts. Thumbnail instead of emoji,
// price in Coins (changed from Diamonds on request), sent through sendVideoGift().
function renderVideoGiftGrid(grid) {
  if (!VIDEO_GIFT_CATALOG_CACHE.gifts.length) {
    grid.innerHTML = '<p class="hint" style="grid-column:1/-1;">No Video Gifts yet.</p>';
    return;
  }
  VIDEO_GIFT_CATALOG_CACHE.gifts.forEach((g) => {
    const item = document.createElement("div");
    item.className = "gift-item tier-legend";
    item.innerHTML = `${g.thumbnail ? `<img src="${g.thumbnail}" class="emoji" style="width:32px;height:32px;object-fit:cover;border-radius:6px;">` : `<span class="emoji">🎬</span>`}<span class="gift-name">${escapeHtml(g.name)}</span><span class="price">${g.price.toLocaleString()} <img src="/images/icons/icon-coin.png" class="currency-icon" alt="coin"></span>`;
    item.addEventListener("mouseenter", () => showGiftPreview(g, true));
    item.addEventListener("touchstart", () => showGiftPreview(g, true), { passive: true });
    item.addEventListener("click", () => selectGiftItem(item, g, true));
    grid.appendChild(item);
  });
}
function showGiftPreview(g, isVideo) {
  const box = $("gift-preview");
  const iconEl = $("gift-preview-emoji");
  if (isVideo) {
    iconEl.innerHTML = g.thumbnail ? `<img src="${g.thumbnail}" style="width:30px;height:30px;object-fit:cover;border-radius:6px;">` : "🎬";
  } else {
    iconEl.innerHTML = g.image ? `<img src="${g.image}" style="width:30px;height:30px;object-fit:contain;">` : "🎁";
  }
  $("gift-preview-name").textContent = g.name;
  $("gift-preview-price").innerHTML = isVideo ? (g.price.toLocaleString() + ' <img src="/images/icons/icon-coin.png" class="currency-icon" alt="coin">') : (g.price + ' <img src="/images/icons/icon-coin.png" class="currency-icon" alt="coin"> · ' + escapeHtml((g.tier || "normal").toUpperCase()));
  box.classList.remove("hidden");
}
$("gift-tabs").addEventListener("click", async (e) => {
  const btn = e.target.closest(".gift-tab");
  if (!btn) return;
  activeGiftTier = btn.dataset.tier;
  selectedGiftId = null;
  selectedVideoGiftId = null;
  $("gift-tabs").querySelectorAll(".gift-tab").forEach(b => b.classList.toggle("active", b === btn));
  $("gift-preview").classList.add("hidden");
  if (activeGiftTier === "custom" && !VIDEO_GIFT_CATALOG_CACHE.gifts.length) {
    const r = await api("/api/video-gifts/catalog");
    if (r.success) VIDEO_GIFT_CATALOG_CACHE.gifts = r.gifts;
  }
  renderGiftGrid();
});
// Multi-recipient gift targeting + repeat-send quantity (1 / 7 / 77 / 777).
// selectedGiftTargets holds the userIds currently checked in the modal's
// target list; giftSendQty is the multiplier applied on send (each selected
// recipient receives the gift giftSendQty times).
let selectedGiftTargets = new Set();
let giftSendQty = 1;

function renderGiftTargetList() {
  const list = $("gift-target-list");
  list.innerHTML = "";
  const users = (currentRoom?.onlineUsers || []).filter(u => u.userId !== me.userId);
  if (!users.length) {
    list.innerHTML = '<div class="gift-target-empty">No one else in the room</div>';
    $("gift-target-select-all").checked = false;
    $("gift-target-select-all").disabled = true;
    return;
  }
  $("gift-target-select-all").disabled = false;
  users.forEach((u) => {
    const row = document.createElement("label");
    row.className = "gift-target-row";
    const checked = selectedGiftTargets.has(u.userId) ? "checked" : "";
    row.innerHTML = `<input type="checkbox" data-userid="${u.userId}" ${checked}><span>${escapeHtml(u.userName)}</span>`;
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selectedGiftTargets.add(u.userId);
      else selectedGiftTargets.delete(u.userId);
      syncGiftSelectAllCheckbox(users);
    });
    list.appendChild(row);
  });
  syncGiftSelectAllCheckbox(users);
}
function syncGiftSelectAllCheckbox(users) {
  const all = users.length > 0 && users.every(u => selectedGiftTargets.has(u.userId));
  $("gift-target-select-all").checked = all;
  updateGiftTargetToggleBadge();
}
// Small corner button (👥) that opens/closes the compact target list —
// the list itself and its selection logic are unchanged, this only
// controls whether the panel is visible.
function updateGiftTargetToggleBadge() {
  const count = selectedGiftTargets.size;
  const countEl = $("gift-target-count");
  countEl.textContent = count;
  countEl.classList.toggle("hidden", count === 0);
}
$("btn-gift-target-toggle").addEventListener("click", () => {
  const panel = $("gift-target-panel");
  const opening = panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !opening);
  $("btn-gift-target-toggle").classList.toggle("active", opening);
});
$("gift-target-select-all").addEventListener("change", (e) => {
  const users = (currentRoom?.onlineUsers || []).filter(u => u.userId !== me.userId);
  if (e.target.checked) users.forEach(u => selectedGiftTargets.add(u.userId));
  else selectedGiftTargets.clear();
  renderGiftTargetList();
});
$("gift-qty-row").addEventListener("click", (e) => {
  const btn = e.target.closest(".gift-qty-btn");
  if (!btn) return;
  giftSendQty = parseInt(btn.dataset.qty, 10) || 1;
  $("gift-qty-row").querySelectorAll(".gift-qty-btn").forEach(b => b.classList.toggle("active", b === btn));
  updateGiftSendButton();
});

// Gift Level Progress card (top of Gift Panel) — UI only. Mirrors the
// server's levelFromCoins() formula (Math.floor(coins/200)+1) so the
// badge/progress bar/remaining-text always agree with the real me.level
// the server sends on every wallet-update, without adding any new
// currency or server field. The 💎 icon here is a label only — the
// underlying spend is still Coins, exactly as before.
function giftLevelTier(level) { return Math.min(10, Math.max(1, Math.ceil((level || 1) / 10))); }
// Shared by the Profile chip, the user-sheet chip, and the Gift Panel badge
// so "Lv.X" always renders with the exact same tier colour everywhere.
function applyLevelBadge(el, level) {
  const lvl = level || 1;
  el.className = "chip-badge level-badge lvl-tier-" + giftLevelTier(lvl);
  el.textContent = "Lv." + lvl;
}
function renderGiftLevelCard() {
  const badge = $("gift-level-badge");
  if (!badge) return;
  const coins = me.coins || 0;
  const level = me.level || Math.max(1, Math.floor(coins / 200) + 1);
  const currentFloor = (level - 1) * 200;
  const nextTarget = level * 200;
  const remaining = Math.max(0, nextTarget - coins);
  const progressPct = Math.min(100, Math.max(0, Math.round(((coins - currentFloor) / 200) * 100)));
  badge.className = "level-badge gift-level-badge lvl-tier-" + giftLevelTier(level);
  $("gift-level-badge-text").textContent = "Lv." + level;
  $("gift-level-progress-fill").style.width = progressPct + "%";
  $("gift-level-remaining").innerHTML = `Need ${remaining.toLocaleString()} <img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> more to reach Lv.${level + 1}`;
}

async function openGiftModal(preselectUserId) {
  closeAllPanels("modal-gift");
  if (!GIFT_CATALOG_CACHE.gifts.length) {
    const r = await api("/api/gifts/catalog");
    if (r.success) GIFT_CATALOG_CACHE.gifts = r.gifts;
  }
  // Fix (2026-08-04): every time the modal opened, the target list reset
  // to empty and the user had to tap "Select All" again before sending —
  // even though they almost always want to gift everyone currently in the
  // room. Default to everyone (mirrors what tapping Select All would do)
  // instead of an empty set; a specific seat/user tap (preselectUserId)
  // still overrides this and picks just that one person, unchanged.
  if (preselectUserId) {
    selectedGiftTargets = new Set([preselectUserId]);
  } else {
    const roomUsers = (currentRoom?.onlineUsers || []).filter(u => u.userId !== me.userId);
    selectedGiftTargets = new Set(roomUsers.map(u => u.userId));
  }
  giftSendQty = 1;
  selectedGiftId = null;
  selectedVideoGiftId = null;
  $("gift-qty-row").querySelectorAll(".gift-qty-btn").forEach(b => b.classList.toggle("active", b.dataset.qty === "1"));
  $("gift-target-panel").classList.add("hidden");
  $("btn-gift-target-toggle").classList.remove("active");
  renderGiftTargetList();
  $("gift-modal-coins").textContent = me.coins || 0;
  renderGiftLevelCard();
  $("gift-preview").classList.add("hidden");
  renderGiftGrid();
  const modal = $("modal-gift");
  modal.classList.remove("hidden");
  modal.querySelector(".gift-modal-card").classList.remove("gift-modal-open");
  requestAnimationFrame(() => modal.querySelector(".gift-modal-card").classList.add("gift-modal-open"));
}
$("btn-open-gift").addEventListener("click", () => openGiftModal());
$("btn-close-gift").addEventListener("click", () => $("modal-gift").classList.add("hidden"));
// Premium Gift Box footer Recharge button — reuses the exact same
// openWallet() the sidebar Wallet menu and the FOODWHEEL_BUY_COINS path
// already call; no new wallet/coin-center flow is created.
$("btn-gift-recharge").addEventListener("click", () => {
  $("modal-gift").classList.add("hidden");
  openWallet();
});
$("btn-send-gift").addEventListener("click", () => {
  if (activeGiftTier === "custom") {
    if (selectedVideoGiftId) sendVideoGift(selectedVideoGiftId);
  } else if (selectedGiftId) {
    sendGift(selectedGiftId);
  }
});
function sendGift(giftId) {
  const targetUserIds = Array.from(selectedGiftTargets);
  if (!targetUserIds.length) { toast("Choose someone"); return; }
  // Client-side pre-check only (snappy UX) — the server re-validates the
  // real balance regardless; this never deducts coins itself. Opens the
  // existing Wallet/Recharge flow, same as the footer Recharge button.
  if (!me.coins) { toast("Not enough coins, check your Wallet"); $("modal-gift").classList.add("hidden"); openWallet(); return; }
  // requestId identifies THIS tap — if this exact emit is ever redelivered
  // (reconnect replay, flaky-connection retry) the server drops the repeat
  // instead of charging coins twice. A second, separate tap gets its own id
  // and is processed normally.
  const requestId = `gift-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  socket.emit("send-gift", { roomId: currentRoomId, targetUserIds, giftId, quantity: giftSendQty, requestId });
  $("modal-gift").classList.add("hidden");
}
// Video Gift send — spends Coins (changed from Diamonds on request), requires
// at least 100,000. Server has the final say; this is just a snappy
// client-side pre-check.
function sendVideoGift(videoGiftId) {
  const targetUserIds = Array.from(selectedGiftTargets);
  if (!targetUserIds.length) { toast("Choose someone"); return; }
  const gift = VIDEO_GIFT_CATALOG_CACHE.gifts.find(g => g.id === videoGiftId);
  if (gift && (me.coins || 0) < gift.price * giftSendQty * targetUserIds.length) { toast("Not enough coins"); return; }
  const requestId = `videogift-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  socket.emit("send-video-gift", { roomId: currentRoomId, targetUserIds, videoGiftId, quantity: giftSendQty, requestId });
  $("modal-gift").classList.add("hidden");
}

// Plays the full-screen Video Gift queue one clip at a time. Each clip:
// shows the overlay, plays the video (with its own audio), then hides
// itself and moves to the next queued gift the moment it ends — so a late
// joiner who never received the original event simply never sees it, and
// a burst of gifts never plays two clips on top of each other.
function playNextVideoGift() {
  if (videoGiftPlaying || !videoGiftQueue.length) return;
  videoGiftPlaying = true;
  const data = videoGiftQueue.shift();
  const overlay = $("video-gift-overlay");
  const video = $("video-gift-player");
  let finished = false;
  const finishClip = () => {
    if (finished) return;
    finished = true;
    overlay.classList.add("hidden");
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.onended = null;
    videoGiftPlaying = false;
    playNextVideoGift();
  };
  video.onended = finishClip;
  // Safety net: if playback stalls or "ended" never fires for some reason,
  // never let the overlay get stuck — clear it after the gift's own duration.
  setTimeout(finishClip, ((data.gift.duration || 8) * 1000) + 800);
  overlay.classList.remove("hidden");
  video.src = data.gift.videoUrl;
  video.currentTime = 0;
  video.muted = false;
  video.play().catch(() => {
    // Autoplay-with-sound blocked (rare once the user has already
    // interacted with the page this session) — fall back to muted so the
    // clip still plays rather than silently failing.
    video.muted = true;
    video.play().catch(() => finishClip());
  });
  toast(`🎬 ${data.fromName} sent ${data.gift.name}`);
}

// Plays the full-screen Vehicle Entry queue one clip at a time — same
// one-at-a-time pattern as playNextVideoGift above, kept in its own queue
// so it never competes with a Video Gift for the screen. The entry video
// plays with its own audio; an optional Background Music and/or Entry
// Sound Effect (admin-uploaded, both optional) layer on top if present.
function playNextVehicleEntry() {
  if (vehicleEntryPlaying || !vehicleEntryQueue.length) return;
  vehicleEntryPlaying = true;
  const data = vehicleEntryQueue.shift();
  const overlay = $("vehicle-entry-overlay");
  const video = $("vehicle-entry-player");
  const music = $("vehicle-entry-music");
  const sound = $("vehicle-entry-sound");
  let finished = false;
  const finishClip = () => {
    if (finished) return;
    finished = true;
    overlay.classList.add("hidden");
    video.pause(); video.removeAttribute("src"); video.load(); video.onended = null;
    music.pause(); music.removeAttribute("src");
    sound.pause(); sound.removeAttribute("src");
    vehicleEntryPlaying = false;
    playNextVehicleEntry();
  };
  video.onended = finishClip;
  // Safety net: never let the overlay get stuck if playback stalls.
  setTimeout(finishClip, ((data.vehicle.durationSeconds || 5) * 1000) + 800);
  overlay.classList.remove("hidden");
  video.src = data.vehicle.videoUrl;
  video.currentTime = 0;
  video.muted = false;
  video.play().catch(() => { video.muted = true; video.play().catch(() => finishClip()); });
  if (data.vehicle.musicUrl) { music.src = data.vehicle.musicUrl; music.currentTime = 0; music.play().catch(() => {}); }
  if (data.vehicle.soundUrl) { sound.src = data.vehicle.soundUrl; sound.currentTime = 0; sound.play().catch(() => {}); }
  toast(`🚗 ${data.userName} entered with ${data.vehicle.name}`);
}

// ---------------- Music ----------------
$("btn-open-music").addEventListener("click", () => { closeAllPanels("modal-music"); $("modal-music").classList.remove("hidden"); });
$("btn-close-music").addEventListener("click", () => $("modal-music").classList.add("hidden"));
$("music-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("music", file);
  const r = await apiUpload("/api/music/upload", fd);
  if (r.success) {
    socket.emit("music-update", { roomId: currentRoomId, url: r.url, name: r.name, playing: true });
  } else toast(r.message || "Upload failed");
});
$("btn-music-playpause").addEventListener("click", () => {
  const audio = $("room-audio");
  const turningOff = !audio.paused;
  if (currentRoom?.music) {
    if (turningOff) {
      // Off = fully remove the track from the room, not just pause it.
      socket.emit("music-update", { roomId: currentRoomId, url: "", name: "", playing: false });
    } else {
      socket.emit("music-update", { roomId: currentRoomId, url: currentRoom.music.url, name: currentRoom.music.name, playing: true });
    }
  }
});
function setMusicUI(music) {
  currentRoom = currentRoom || {};
  currentRoom.music = music;
  const audio = $("room-audio");
  $("music-now-playing").textContent = music.name ? ("🎵 " + music.name) : "No song playing";
  if (!music.url) {
    // Fully remove — stop and unload, don't just pause.
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } else {
    if (audio.src !== location.origin + music.url) audio.src = music.url;
    if (music.playing) audio.play().catch(() => {}); else audio.pause();
  }
  $("btn-open-music").classList.toggle("active", !!music.playing);
}

// ===========================================================================
// YOUTUBE ROOM PLAYER
// Purely additive: its own DOM (#yt-player-wrap is a full-width 16:9 block
// between the room header and #seat-grid, see index.html — normal document
// flow, so it naturally pushes the seat grid down while visible and never
// covers it), its own socket events, its own state. Never touches seat
// rendering/voice/gifts/admin code. Server is the single source of truth
// for playlist + playback state; this module only (a) renders what the
// server last broadcast, and (b) for the owner/admin, drives the actual
// YT.Player and reports control actions.
// ===========================================================================

// (2026-07-27, video layout) — #yt-player-wrap now sizes itself purely via
// CSS (width:100%, aspect-ratio:16/9), so no header-class bookkeeping is
// needed any more. Kept as a no-op-safe helper (some call sites still call
// it) in case anything elsewhere depends on the function existing.
function syncYtHeaderClass() {}

// (2026-07-27, video layout) — the player's own box is now a true 16:9
// box (width:100%, aspect-ratio:16/9 in CSS), matching the vast majority of
// YouTube uploads, and object-fit:contain on the iframe (see style.css)
// guarantees the video is never cropped or stretched. This only needs to
// fill the iframe to the container's own size — no oversizing/cropping.
function ensureYtCoverFit() {
  const frame = $("yt-player-frame");
  const iframe = frame && frame.querySelector("iframe");
  if (!frame || !iframe) return;
  iframe.style.width = "100%";
  iframe.style.height = "100%";
}
window.addEventListener("resize", () => { if (ytPlayer) ensureYtCoverFit(); });

// AUDIT FIX (2026-07-27, video layout) — "hide all playback controls...
// only show controls after user taps the video; controls disappear again
// automatically after a few seconds." Tap-to-reveal is layered independently
// of the existing item-based hidden/visible logic elsewhere in this file
// (which controls whether controls exist for the current content at all) —
// this only controls whether they're currently ON SCREEN.
let ytControlsHideTimer = null;
function showYtOverlayControls() {
  $("yt-player-wrap").classList.add("yt-controls-visible");
  if (ytControlsHideTimer) clearTimeout(ytControlsHideTimer);
  ytControlsHideTimer = setTimeout(() => {
    // Don't hide mid-interaction with the ⋮ menu.
    if (!$("yt-more-menu").classList.contains("hidden")) return;
    $("yt-player-wrap").classList.remove("yt-controls-visible");
  }, 3000);
}
$("yt-player-frame").addEventListener("click", showYtOverlayControls);
// Any tap within the revealed control bar itself should reset the auto-hide
// clock too, instead of it disappearing mid-tap on a slow double-action.
$("yt-overlay-controls").addEventListener("click", showYtOverlayControls);
// Dedicated small permanent close button (top-right) — same behavior as the
// existing "✕ Close" item in the ⋮ menu (owner ends it for everyone;
// viewers just dismiss it locally), just reachable without tapping first.
$("btn-yt-mini-close").addEventListener("click", () => $("btn-yt-close").click());

// The IFrame API calls this global exactly once, whenever the <script
// src="https://www.youtube.com/iframe_api"> tag finishes loading — which
// can happen before OR after this file has run, so we just flip a flag and
// flush anything that was waiting on it.
window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
  if (ytPendingLoad) {
    const p = ytPendingLoad; ytPendingLoad = null;
    ensureYtPlayer(p);
  }
};

function ensureYtPlayer({ videoId, position, isPlaying }) {
  if (!ytApiReady || typeof YT === "undefined" || !YT.Player) {
    ytPendingLoad = { videoId, position, isPlaying };
    return;
  }
  if (!ytPlayer) {
    $("yt-player-loading").classList.remove("hidden");
    ytPlayer = new YT.Player("yt-player-mount", {
      width: "100%", height: "100%",
      videoId,
      // AUDIT FIX (2026-07-27, video layout) — controls was previously 1
      // for the owner/admin, showing YouTube's native play/pause/progress
      // bar/branding. Per spec every viewer (controller included) gets the
      // same minimal, tap-to-reveal custom overlay instead — native chrome
      // is always off now.
      playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1, iv_load_policy: 3, fs: 0, disablekb: 1, start: Math.floor(position || 0) },
      events: {
        onReady: () => {
          $("yt-player-loading").classList.add("hidden");
          if (isPlaying) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
          ensureYtCoverFit();
        },
        onStateChange: onYtPlayerStateChange
      }
    });
  } else {
    loadYtVideo(videoId, position, isPlaying);
  }
}

function loadYtVideo(videoId, position, isPlaying) {
  if (!ytPlayer || typeof ytPlayer.loadVideoById !== "function") return;
  ytSuppressEvents = true;
  if (isPlaying) ytPlayer.loadVideoById(videoId, position || 0);
  else ytPlayer.cueVideoById(videoId, position || 0);
  setTimeout(() => { ytSuppressEvents = false; }, 400);
}

// Only the owner/admin's own client reports state changes back to the
// server (via yt-ended for the one case that needs auto-advance). Everyone
// else's player is purely a receiver, driven entirely by yt-player-update —
// this keeps a single "true" playback timeline instead of every client's
// player fighting to be the source of truth.
function onYtPlayerStateChange(e) {
  if (ytSuppressEvents) return;
  if (e.data === YT.PlayerState.ENDED && canControlYt) {
    socket.emit("yt-ended", { roomId: currentRoomId });
  }
}

// Applies a server-broadcast player state to the UI + (for the controller)
// the actual YT.Player. Also used on initial room-state hydration.
function applyYtPlayerState(state) {
  const prevIndex = ytPlayerState ? ytPlayerState.currentIndex : -1;
  ytPlayerState = state || ytPlayerState;
  const item = ytCurrentPlaylist[ytPlayerState.currentIndex] || null;
  renderYtPlaylist(); // refresh "now playing" highlight

  // Clear a viewer-local "hide for me" only when a genuinely new video
  // starts — NOT on every broadcast, since the owner's drift-correction
  // ping (manageYtDriftTimer, every 4s while playing) also re-broadcasts
  // yt-player-update and would otherwise instantly un-hide it again.
  if (ytPlayerState.currentIndex !== prevIndex) ytLocallyDismissed = false;
  if (ytLocallyDismissed) return;

  $("btn-yt-playpause").textContent = ytPlayerState.isPlaying ? "⏸️" : "▶️";
  $("yt-player-controls").classList.toggle("hidden", !item);
  $("btn-yt-prev").classList.toggle("hidden", !canControlYt);
  $("btn-yt-playpause").classList.toggle("hidden", !canControlYt);
  $("btn-yt-next").classList.toggle("hidden", !canControlYt);

  if (!item) {
    $("yt-player-title").textContent = "No video playing";
    $("yt-player-sub").textContent = "";
    $("yt-player-thumb").removeAttribute("src");
    $("yt-player-poster").classList.add("hidden");
    $("yt-player-poster").removeAttribute("src");
    $("yt-player-empty").classList.remove("hidden");
    return;
  }
  $("yt-player-empty").classList.add("hidden");
  $("yt-player-title").textContent = item.title || "YouTube Video";
  $("yt-player-sub").textContent = "Added by " + (item.addedByUsername || "—");
  $("yt-player-thumb").src = item.thumbnail || "";
  // Big poster thumbnail behind the mount — shown until the real player
  // actually starts playing, then simply sits behind it (harmless either way).
  if (item.thumbnail) {
    $("yt-player-poster").src = item.thumbnail;
    $("yt-player-poster").classList.toggle("hidden", ytPlayerState.isPlaying);
  }

  // Only actually spin up / drive the real IFrame player while Video Mode
  // is on — no point loading YouTube in the background when it's hidden.
  if (!ytPlayerState.mode) return;
  if (!ytPlayer && !ytPendingLoad) {
    ensureYtPlayer({ videoId: item.videoId, position: ytPlayerState.position, isPlaying: ytPlayerState.isPlaying });
  } else if (ytPlayer) {
    const loadedId = (typeof ytPlayer.getVideoData === "function" && ytPlayer.getVideoData().video_id) || null;
    if (loadedId !== item.videoId) {
      loadYtVideo(item.videoId, ytPlayerState.position, ytPlayerState.isPlaying);
    } else {
      // Same video — just correct drift/play-state without a jarring reload.
      const cur = typeof ytPlayer.getCurrentTime === "function" ? ytPlayer.getCurrentTime() : 0;
      if (Math.abs(cur - (ytPlayerState.position || 0)) > 2.5) ytPlayer.seekTo(ytPlayerState.position || 0, true);
      if (ytPlayerState.isPlaying) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
    }
    ensureYtCoverFit();
  }
  manageYtDriftTimer();
}

// Owner/admin's client nudges the server with the real playback position
// every few seconds while playing, so late joiners land close to the
// actual timestamp instead of drifting. Non-controllers never do this.
function manageYtDriftTimer() {
  clearInterval(ytDriftTimer); ytDriftTimer = null;
  if (!canControlYt || !ytPlayerState.isPlaying || !ytPlayer) return;
  ytDriftTimer = setInterval(() => {
    if (!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
    socket.emit("yt-seek", { roomId: currentRoomId, position: ytPlayer.getCurrentTime() });
  }, 4000);
}

function setYtModeUI(on, skipDom) {
  if (on) ytLocallyDismissed = false; // mode turning on for real always overrides a stale local hide
  $("yt-player-wrap").classList.toggle("hidden", !on || ytLocallyDismissed);
  syncYtHeaderClass();
  $("btn-toggle-yt").classList.toggle("active", on);
  if (on) {
    // Controls always start hidden — the user has to tap the video first.
    $("yt-player-wrap").classList.remove("yt-controls-visible");
    if (ytControlsHideTimer) { clearTimeout(ytControlsHideTimer); ytControlsHideTimer = null; }
  }
  if (!on) {
    clearInterval(ytDriftTimer); ytDriftTimer = null;
    if (ytPlayer && typeof ytPlayer.pauseVideo === "function") { try { ytPlayer.pauseVideo(); } catch (_) {} }
  } else if (!skipDom) {
    applyYtPlayerState(ytPlayerState);
  }
}

function renderYtPlaylist() {
  const wrap = $("yt-playlist-list");
  $("yt-add-row").classList.toggle("hidden", !canControlYt);
  if (!ytCurrentPlaylist.length) {
    wrap.innerHTML = '<div class="gift-target-empty">Playlist is empty</div>';
    return;
  }
  wrap.innerHTML = "";
  ytCurrentPlaylist.forEach((item, idx) => {
    const isPlaying = idx === ytPlayerState.currentIndex;
    const row = document.createElement("div");
    row.className = "yt-playlist-row" + (isPlaying ? " playing" : "");
    row.innerHTML = `
      <img class="yt-playlist-thumb" src="${escapeHtml(item.thumbnail || "")}" alt="">
      <div class="yt-playlist-meta">
        <div class="yt-pl-title">${escapeHtml(item.title || "YouTube Video")}</div>
        <div class="yt-pl-sub">Added by ${escapeHtml(item.addedByUsername || "—")}</div>
      </div>
      <div class="yt-playlist-actions">
        ${canControlYt ? `<button class="yt-pl-play-btn${isPlaying ? " playing" : ""}" data-id="${item.id}">${isPlaying ? "⏸️" : "▶️"}</button>` : ""}
        ${canControlYt ? `<button class="yt-pl-del-btn" data-id="${item.id}">🗑️</button>` : ""}
      </div>`;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll(".yt-pl-play-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const idx = ytCurrentPlaylist.findIndex((v) => v.id === id);
      if (idx === ytPlayerState.currentIndex && ytPlayerState.isPlaying) {
        socket.emit("yt-pause", { roomId: currentRoomId });
      } else {
        socket.emit("yt-play", { roomId: currentRoomId, videoItemId: id });
      }
    });
  });
  wrap.querySelectorAll(".yt-pl-del-btn").forEach((btn) => {
    btn.addEventListener("click", () => socket.emit("yt-remove-video", { roomId: currentRoomId, videoItemId: btn.dataset.id }));
  });
}

$("btn-toggle-yt").addEventListener("click", () => {
  if (!canControlYt) return;
  socket.emit("yt-toggle-mode", { roomId: currentRoomId, on: !ytPlayerState.mode });
});

$("btn-open-yt-playlist").addEventListener("click", () => {
  closeAllPanels("modal-yt-playlist");
  renderYtPlaylist();
  $("modal-yt-playlist").classList.remove("hidden");
  // Re-engaging with the playlist is a clear signal the viewer wants the
  // player back, so undo a previous local-only Close.
  if (ytLocallyDismissed && ytPlayerState.mode) {
    ytLocallyDismissed = false;
    $("yt-player-wrap").classList.remove("hidden");
    syncYtHeaderClass();
    applyYtPlayerState(ytPlayerState);
  }
});
$("btn-close-yt-playlist").addEventListener("click", () => $("modal-yt-playlist").classList.add("hidden"));

$("btn-yt-add").addEventListener("click", () => {
  const input = $("yt-link-input");
  const url = (input.value || "").trim();
  if (!url) return;
  socket.emit("yt-add-video", { roomId: currentRoomId, url });
  input.value = "";
});

$("btn-yt-playpause").addEventListener("click", () => {
  if (!canControlYt) return;
  if (ytPlayerState.isPlaying) socket.emit("yt-pause", { roomId: currentRoomId });
  else socket.emit("yt-play", { roomId: currentRoomId });
});
$("btn-yt-next").addEventListener("click", () => { if (canControlYt) socket.emit("yt-next", { roomId: currentRoomId }); });
$("btn-yt-prev").addEventListener("click", () => { if (canControlYt) socket.emit("yt-prev", { roomId: currentRoomId }); });

// ---------------------------------------------------------------------------
// YouTube Player — compact ⋮ menu (Playlist, Share, Refresh, Voice, Close).
// All purely additive on top of the existing state machine above: none of
// these emit new server events except Close (which reuses yt-toggle-mode,
// exactly like the existing 📺 toolbar button already does), so no new
// server-side logic is needed and nothing else changes. Available to every
// viewer, not just the owner/admin — Prev/Play/Next remain controller-only.
// ---------------------------------------------------------------------------
let ytLocallyDismissed = false; // viewer-only "hide for me" when they can't control the room
let ytMuted = false;

function closeYtMoreMenu() { $("yt-more-menu").classList.add("hidden"); }

$("btn-yt-close").addEventListener("click", () => {
  closeYtMoreMenu();
  if (canControlYt) {
    socket.emit("yt-toggle-mode", { roomId: currentRoomId, on: false });
  } else {
    // Non-controllers can't end video mode for everyone — just hide it
    // locally; it comes back automatically next time the server broadcasts
    // an update (new video, mode re-enabled, etc.) so it never desyncs.
    ytLocallyDismissed = true;
    $("yt-player-wrap").classList.add("hidden");
    syncYtHeaderClass();
    if (ytPlayer && typeof ytPlayer.pauseVideo === "function") { try { ytPlayer.pauseVideo(); } catch (_) {} }
  }
});

$("btn-yt-refresh").addEventListener("click", () => {
  closeYtMoreMenu();
  const item = ytCurrentPlaylist[ytPlayerState.currentIndex];
  if (!item) { toast("No video playing"); return; }
  if (ytPlayer && typeof ytPlayer.seekTo === "function") {
    ytSuppressEvents = true;
    ytPlayer.seekTo(ytPlayerState.position || 0, true);
    if (ytPlayerState.isPlaying) ytPlayer.playVideo();
    setTimeout(() => { ytSuppressEvents = false; }, 400);
  } else {
    applyYtPlayerState(ytPlayerState);
  }
  toast("Refreshed");
});

$("btn-yt-voice").addEventListener("click", () => {
  // Local-only mute of the video's own audio — does not touch room mic /
  // WebRTC voice chat at all, and does not affect other viewers.
  ytMuted = !ytMuted;
  if (ytPlayer) {
    if (ytMuted && typeof ytPlayer.mute === "function") ytPlayer.mute();
    else if (!ytMuted && typeof ytPlayer.unMute === "function") ytPlayer.unMute();
  }
  $("btn-yt-voice").textContent = ytMuted ? "🔇 Sound Off" : "🔊 Sound On";
});

$("btn-open-yt-playlist-2").addEventListener("click", () => { closeYtMoreMenu(); $("btn-open-yt-playlist").click(); });

function currentYtShareUrl() {
  const item = ytCurrentPlaylist[ytPlayerState.currentIndex];
  return item ? `https://youtu.be/${item.videoId}` : location.href;
}
async function shareYtVideo() {
  closeYtMoreMenu();
  const url = currentYtShareUrl();
  const item = ytCurrentPlaylist[ytPlayerState.currentIndex];
  const title = item ? item.title : "PingPong Room";
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (_) { /* cancelled — fall through silently */ }
  } else if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(url); toast("Link copied"); return; } catch (_) {}
  }
}
$("btn-yt-share").addEventListener("click", shareYtVideo);
$("btn-yt-copy-link").addEventListener("click", async () => {
  closeYtMoreMenu();
  try { await navigator.clipboard.writeText(currentYtShareUrl()); toast("Link copied"); }
  catch (_) { toast(currentYtShareUrl()); }
});
$("btn-yt-open-external").addEventListener("click", () => {
  closeYtMoreMenu();
  window.open(currentYtShareUrl(), "_blank");
});
$("btn-yt-more").addEventListener("click", (e) => {
  e.stopPropagation();
  $("yt-more-menu").classList.toggle("hidden");
});
document.addEventListener("click", (e) => {
  if (!$("yt-more-menu").classList.contains("hidden") && !$("yt-more-wrap").contains(e.target)) {
    closeYtMoreMenu();
  }
});

// ===========================================================================
// WEBRTC VOICE — stream, real-time speaking detection, auto-reconnect
// ===========================================================================
// Explicit rather than relying on implicit `audio: true` defaults, which
// vary by browser/OS — this guarantees echo cancellation, noise
// suppression, and auto gain control are actually requested everywhere the
// mic is opened (room voice and 1-1 calls alike).
const VOICE_AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 };
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // Fallback TURN relay — STUN alone can't traverse symmetric / carrier-grade
    // NAT (common on mobile data), which is what makes voice sound "far"/choppy
    // or fail to connect for some users. A TURN relay gives those connections
    // an actual path instead of silently failing. For production scale, swap
    // this public relay for a dedicated TURN service (see README).
    { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
  ]
};

// ICE CONFIG UNIFICATION (voice stability pass, 2026-08-04): room voice used
// to always use the hardcoded list above, while 1-1 calls fetched
// operator-configured servers from /api/calls/ice-servers (STUN_URL /
// TURN_URL env vars) — two different ICE configs for the same kind of media.
// This primes room voice with that same endpoint/cache (getIceServers(),
// defined below — function declarations are hoisted so this is safe to call
// from up here) and merges it with the existing hardcoded fallback, so an
// operator's TURN_URL now covers both paths, and reliability never regresses
// if those env vars aren't set. No new endpoint, no API change — same call
// callSignaling.js already exposes.
let roomIceServersResolved = null;
async function primeRoomIceServers() {
  if (roomIceServersResolved) return roomIceServersResolved;
  try {
    const fetched = await getIceServers();
    const seen = new Set();
    roomIceServersResolved = [...fetched, ...ICE_SERVERS.iceServers].filter((s) => {
      const key = JSON.stringify(s.urls);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (e) {
    roomIceServersResolved = ICE_SERVERS.iceServers;
  }
  return roomIceServersResolved;
}

// Additive audio-quality tweak (voice smoothness pass, 2026-08-04): turns on
// Opus in-band FEC (forward error correction) on every offer/answer we send,
// for both room voice and 1-1 calls. With FEC on, a handful of lost packets
// (normal on mobile data / weak Wi-Fi) get reconstructed from redundancy
// already riding in the next packet instead of being heard as a click/gap —
// this is what "choppy" voice usually is. Pure SDP text edit right before
// setLocalDescription; touches nothing about signaling, ICE, or the
// reconnect/restart logic elsewhere in this file. No-op if Opus isn't
// present in the SDP (never throws either way).
// Extended in the voice stability pass to also enable Opus DTX (discontinuous
// transmission — stops sending packets during silence instead of padding
// audio, which lowers bandwidth/CPU without touching perceived quality during
// speech) and to set a floor/ceiling bitrate rather than leaving it fully
// unbounded. maxaveragebitrate defaults to 32000 (32kbps) — a normal-to-good
// voice-quality Opus bitrate, at or above what browsers typically negotiate
// on their own — so this is a floor, not a cut. Actual dynamic scaling
// (raising/lowering with measured network conditions) happens separately via
// RTCRtpSender.setParameters() in applyAdaptiveBitrate(), which doesn't
// require renegotiation. Same function name/signature as before — every
// existing call site (room voice + 1-1 calls, offer + answer) keeps working
// unchanged; only the SDP it produces is richer.
function applyOpusFEC(desc, maxAverageBitrate) {
  try {
    if (!desc || !desc.sdp) return desc;
    const opusMatch = desc.sdp.match(/a=rtpmap:(\d+) opus\/48000/);
    if (!opusMatch) return desc;
    const payload = opusMatch[1];
    const bitrate = maxAverageBitrate || 32000;
    const fmtpRe = new RegExp(`a=fmtp:${payload} ([^\r\n]*)`);
    if (fmtpRe.test(desc.sdp)) {
      desc.sdp = desc.sdp.replace(fmtpRe, (full, params) => {
        let p = params;
        if (!/useinbandfec=/.test(p)) p += ";useinbandfec=1";
        if (!/usedtx=/.test(p)) p += ";usedtx=1";
        if (!/maxaveragebitrate=/.test(p)) p += `;maxaveragebitrate=${bitrate}`;
        return `a=fmtp:${payload} ${p}`;
      });
    } else {
      desc.sdp = desc.sdp.replace(opusMatch[0], `${opusMatch[0]}\r\na=fmtp:${payload} useinbandfec=1;usedtx=1;maxaveragebitrate=${bitrate}`);
    }
  } catch (e) { /* never let an audio-quality tweak break call setup */ }
  return desc;
}

// Dynamic bitrate (item 8 of the spec): raises/lowers the already-negotiated
// audio sender's bitrate live via setParameters() — no renegotiation, no SDP
// round-trip, nothing visible to the signaling flow. Bounded so it can only
// ever move within a normal voice range (16-32kbps), never below what
// sounds acceptable and never used to silently degrade quality on a good
// connection.
function applyAdaptiveBitrate(pc, kbps) {
  try {
    const sender = pc.getSenders && pc.getSenders().find((s) => s.track && s.track.kind === "audio");
    if (!sender) return;
    const clamped = Math.max(16, Math.min(32, kbps));
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = clamped * 1000;
    const p = sender.setParameters(params);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) { /* setParameters unsupported/mid-negotiation — leave bitrate as-is */ }
}

// Phase 1 / Tier A: resolve a room-voice peer's socketId back to their
// userId so voice-stats reports can be tied to a person server-side (see
// voice-health.js). seatMap is already kept current for the UI; this just
// reads it, no new state.
function userIdForSocketId(sid) {
  const entry = Object.values(seatMap).find((s) => s && s.socketId === sid);
  return entry ? entry.userId : null;
}

// Connection diagnostics (item 6): periodic getStats() poll, console-only —
// never surfaced in UI. Feeds packet loss into applyAdaptiveBitrate so poor
// links get a lower ceiling and good links get headroom back automatically.
// Phase 1 / Tier A also feeds a lightweight summary to the server's Voice
// Health Monitor (see voice-health.js) every ~5s for room-voice peers only
// (private calls use their own "call" label and aren't reported here —
// per-call quality wasn't in scope for this phase).
function startConnectionDiagnostics(pc, label) {
  let lastPacketsLost = null, lastTimestamp = null, lastStatsEmit = 0;
  const timer = setInterval(async () => {
    if (!pc || pc.connectionState === "closed") { clearInterval(timer); return; }
    try {
      const stats = await pc.getStats();
      let rtt = null, jitter = null, packetsLost = null, packetsReceived = null, relay = false;
      let localCandidateId = null, usedCandidateType = null;
      const candidateTypesById = {};
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated || r.selected)) {
          rtt = r.currentRoundTripTime;
          localCandidateId = r.localCandidateId;
        }
        if (r.type === "remote-candidate" && r.candidateType === "relay") relay = true;
        if (r.type === "local-candidate" && r.candidateType === "relay") relay = true;
        if (r.type === "local-candidate") candidateTypesById[r.id] = r.candidateType;
        if (r.type === "inbound-rtp" && r.kind === "audio") {
          jitter = r.jitter;
          packetsLost = r.packetsLost;
          packetsReceived = r.packetsReceived;
        }
      });
      // TURN diagnostics (console only, no UI): identify which candidate
      // type the active connection actually settled on so "TURN configured"
      // vs "TURN actually used" can be told apart in the logs.
      if (localCandidateId && candidateTypesById[localCandidateId]) {
        usedCandidateType = candidateTypesById[localCandidateId];
        if (usedCandidateType !== pc._lastLoggedCandidateType) {
          pc._lastLoggedCandidateType = usedCandidateType;
          const label = usedCandidateType === "relay" ? "Relay Candidate Used"
            : usedCandidateType === "srflx" ? "srflx Candidate Used"
            : usedCandidateType === "host" ? "Host Candidate Used"
            : `${usedCandidateType} Candidate Used`;
          console.log(`[ice-config] ${label}`);
        }
      }
      let lossRatio = 0;
      if (packetsLost != null && lastPacketsLost != null && lastTimestamp != null) {
        const deltaLost = Math.max(0, packetsLost - lastPacketsLost);
        const deltaRecv = Math.max(0, (packetsReceived || 0) - lastTimestamp);
        lossRatio = deltaRecv > 0 ? deltaLost / (deltaLost + deltaRecv) : 0;
        const targetKbps = lossRatio > 0.08 ? 16 : lossRatio > 0.03 ? 24 : 32;
        applyAdaptiveBitrate(pc, targetKbps);
      }
      lastPacketsLost = packetsLost;
      lastTimestamp = packetsReceived;
      console.debug(`[voice-diag] ${label} ice=${pc.iceConnectionState} conn=${pc.connectionState} rtt=${rtt} jitter=${jitter} lost=${packetsLost} relay=${relay}`);

      // Phase 1 / Tier A: report to voice-health.js, room-peer connections
      // only, throttled to ~5s (matches the server's per-user rate limit).
      const now = Date.now();
      if (label.startsWith("room-peer:") && socket && socket.connected && now - lastStatsEmit >= 5000) {
        const remoteSocketId = label.slice("room-peer:".length);
        const peerUserId = userIdForSocketId(remoteSocketId);
        if (peerUserId && packetsLost != null) {
          socket.emit("voice-stats", {
            peerUserId,
            packetLossPercent: lossRatio * 100,
            jitterMs: jitter != null ? jitter * 1000 : 0,
            rttMs: rtt != null ? rtt * 1000 : 0
          });
          lastStatsEmit = now;
        }
      }
    } catch (e) { /* stats unavailable this tick — skip */ }
  }, 4000);
  return timer;
}

async function initMicIfNeeded() {
  if (localStream || !mySeatNumber) return;
  // Phase 3 / Step 3.3: everything below this line is the ORIGINAL mesh
  // implementation, byte-for-byte unchanged. In SFU mode it is skipped
  // entirely in favor of initSfuMicIfNeeded() (see the WEBRTC VOICE SFU
  // section further down) so there is exactly one code path active for
  // any given VOICE_MODE, never both at once (that would double-publish
  // audio / cause echo).
  if (voiceMode === "sfu") { await initSfuMicIfNeeded(); return; }
  // IMPORTANT: getUserMedia is only allowed in a "secure context" — https://,
  // or http://localhost specifically. Opening the app on a phone via
  // http://192.168.x.x:3000 (a plain LAN IP, as the README's basic testing
  // instructions describe) is NOT secure, so the browser blocks microphone
  // access outright before any of our code even runs — often with no
  // visible error, or navigator.mediaDevices being undefined entirely. This
  // silently produces exactly "voice doesn't work, nobody can hear anyone"
  // on every real phone, regardless of any signaling fix. Use ngrok /
  // Cloudflare Tunnel (both already mentioned in the README) or deploy
  // behind real HTTPS to test across devices.
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("[voice] blocked: not a secure context (need https:// or http://localhost). Current origin:", location.origin);
    toast("HTTPS is required for voice — the mic won't work on phones over http://IP:3000, use ngrok/Cloudflare Tunnel instead");
    return;
  }
  primeRoomIceServers(); // fire-and-forget; peer creation falls back to the hardcoded list until this resolves
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS });
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    startVoiceActivityDetection();
  } catch (e) {
    console.error("[voice] getUserMedia failed:", e.name, e.message);
    toast("Microphone permission required");
  }
}

// Safety net for the seat/mic race: a peer connection can end up created
// (e.g. because we just received an incoming offer) before our own
// getUserMedia() resolves, so it goes out with zero local audio tracks —
// the other side gets silence from us even though the connection looks
// "connected". Whenever localStream becomes available/changes, walk every
// existing peer connection and, if it has no outgoing audio track yet, add
// one and renegotiate.
async function ensureLocalTracksSent() {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;

  // IMPORTANT: leaving a seat intentionally stops the old local track, but
  // the Mesh peer connection remains alive so the user can keep listening as
  // an audience member. When that same user takes a seat again, the old
  // RTCRtpSender still exists and its track is "ended". The old implementation
  // only checked whether a sender existed, so it never replaced that dead
  // track — the UI showed the mic as active while nobody could hear the user.
  // Reuse the existing sender when possible, replace an ended track, then
  // renegotiate the pair. This keeps healthy audience connections intact and
  // avoids tearing down every peer on a seat change.
  await Promise.all(Object.entries(peerConnections).map(async ([sid, pc]) => {
    try {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === "audio");
      if (!sender) {
        pc.addTrack(audioTrack, localStream);
        await connectToPeer(sid);
        return;
      }
      if (sender.track !== audioTrack || sender.track.readyState === "ended") {
        await sender.replaceTrack(audioTrack);
        await connectToPeer(sid, true);
      }
    } catch (e) {
      console.warn("[voice] local audio track re-attach failed:", sid, e && e.message);
      // Last-resort rebuild for this one peer only. Do not touch healthy peers.
      closePeer(sid);
      if (mySeatNumber !== null) connectToPeer(sid, true);
    }
  }));
}

$("btn-mic-toggle").addEventListener("click", async () => {
  // PHASE 3, STEP 3.6 — audience members must never publish. LiveKit
  // itself already refuses the publish server-side (their token has
  // canPublish:false — see provider.js), so this can never actually be
  // bypassed by removing this check; it only avoids a pointless mic
  // permission prompt followed by a silent server-side rejection.
  // Mesh mode is intentionally left exactly as it was — this guard only
  // applies when voiceMode === "sfu".
  if (mySeatNumber === null) {
    toast("Take a seat to talk");
    return;
  }
  if (!localStream) {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error("[voice] blocked: not a secure context. Current origin:", location.origin);
      toast("HTTPS is required for voice — the mic won't work on phones over http://IP:3000, use ngrok/Cloudflare Tunnel instead");
      return;
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS });
      startVoiceActivityDetection();
      // Phase 3 / Step 3.3: this handler covers the edge case where the mic
      // was never requested via initMicIfNeeded() (e.g. mic permission was
      // denied earlier, then the user retries by tapping the mic button
      // directly). ensureLocalTracksSent() is mesh-only (it walks
      // peerConnections, which stays empty in SFU mode); the SFU
      // equivalent is connecting to the already-joined LiveKit room.
      if (voiceMode === "sfu") { await connectSfuRoom(); } else { ensureLocalTracksSent(); }
    } catch (e) { console.error("[voice] getUserMedia failed:", e.name, e.message); toast("Microphone permission required"); return; }
  }
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
  $("btn-mic-toggle").classList.toggle("active", micEnabled);
  // Mic switched off — immediately drop the live-signal animation instead
  // of waiting for tickVoiceActivity's silence timeout to catch up.
  if (!micEnabled) $("btn-mic-toggle").classList.remove("mic-live");
});

// --- Real-time mic-level analysis: turns actual speaking (not just being
//     seated) into the "speaking" ring, and broadcasts it to the room. ---
let voiceCtx = null, voiceAnalyser = null, voiceDataArray = null, voiceRafId = null;
let lastSpeakingState = false, loudSince = 0, quietSince = 0;

function startVoiceActivityDetection() {
  if (voiceAnalyser || !localStream) return;
  try {
    voiceCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = voiceCtx.createMediaStreamSource(localStream);
    voiceAnalyser = voiceCtx.createAnalyser();
    voiceAnalyser.fftSize = 512;
    source.connect(voiceAnalyser);
    voiceDataArray = new Uint8Array(voiceAnalyser.frequencyBinCount);
    tickVoiceActivity();
  } catch (e) { /* Web Audio unsupported — seat ring just won't be mic-driven */ }
}
function tickVoiceActivity() {
  if (!voiceAnalyser) return;
  voiceAnalyser.getByteFrequencyData(voiceDataArray);
  let sum = 0;
  for (let i = 0; i < voiceDataArray.length; i++) sum += voiceDataArray[i];
  const avg = sum / voiceDataArray.length;
  const now = Date.now();
  const isLoud = micEnabled && avg > 12;
  if (isLoud) { quietSince = 0; if (!loudSince) loudSince = now; }
  else { loudSince = 0; if (!quietSince) quietSince = now; }
  const shouldSpeak = isLoud && loudSince && (now - loudSince > 80);
  const shouldStop = !isLoud && quietSince && (now - quietSince > 350);
  if (shouldSpeak && !lastSpeakingState) {
    lastSpeakingState = true;
    if (mySeatNumber && currentRoomId) socket.emit("voice-activity", { roomId: currentRoomId, speaking: true });
    speakingUsers.add(me.userId);
    if (currentRoom) renderSeats(seatsFromMap());
    // Drive the mic-toggle button's live signal-ring animation from the
    // same real mic-level detection as the seat ring, so the toolbar mic
    // icon only "lights up" while the person is actually talking.
    $("btn-mic-toggle")?.classList.add("mic-live");
  } else if (shouldStop && lastSpeakingState) {
    lastSpeakingState = false;
    if (mySeatNumber && currentRoomId) socket.emit("voice-activity", { roomId: currentRoomId, speaking: false });
    speakingUsers.delete(me.userId);
    if (currentRoom) renderSeats(seatsFromMap());
    $("btn-mic-toggle")?.classList.remove("mic-live");
  }
  voiceRafId = requestAnimationFrame(tickVoiceActivity);
}
function stopVoiceActivityDetection() {
  if (voiceRafId) cancelAnimationFrame(voiceRafId);
  voiceRafId = null; voiceAnalyser = null; lastSpeakingState = false;
  loudSince = 0; quietSince = 0;
  $("btn-mic-toggle")?.classList.remove("mic-live");
  if (voiceCtx) { voiceCtx.close().catch(() => {}); voiceCtx = null; }
}

function getOrCreatePeer(remoteSocketId) {
  if (peerConnections[remoteSocketId]) return peerConnections[remoteSocketId];
  const pc = new RTCPeerConnection({ iceServers: roomIceServersResolved || ICE_SERVERS.iceServers, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
  // BUG FIX (glare / "can't hear each other"): both sides could end up
  // calling connectToPeer() on each other at close to the same moment (e.g.
  // two people take seats around the same time, or the seat-take fix above
  // now has the new seat *and* the existing seats both connecting to one
  // another). Without a tie-breaker, both sides send an "offer" into the
  // same RTCPeerConnection back-to-back — setRemoteDescription(offer) then
  // throws on whichever side is mid-negotiation, that promise rejection was
  // unhandled, and the connection was left half-negotiated: it can look
  // "connected" at the ICE layer while no audio ever actually flows.
  // `polite` gives every pair a consistent, deterministic winner (compare
  // socket ids) so exactly one side backs off (rolls back its own offer)
  // instead of both throwing.
  pc.polite = socket.id > remoteSocketId;
  pc.makingOffer = false;
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  const sentCandidates = new Set(); // dedup: candidate exchange only needs each unique candidate once
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const key = e.candidate.candidate;
    if (sentCandidates.has(key)) return;
    sentCandidates.add(key);
    socket.emit("voice-candidate", { target: remoteSocketId, targetUserId: userIdForSocketId(remoteSocketId), candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    let audioEl = remoteAudioEls[remoteSocketId];
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.controls = false;
      audioEl.preload = "auto";
      audioEl.volume = 1;
      audioEl.setAttribute("playsinline", "");
      audioEl.setAttribute("autoplay", "");
      document.body.appendChild(audioEl);
      remoteAudioEls[remoteSocketId] = audioEl;
    }
    audioEl.srcObject = e.streams[0];
    const playRemote = () => audioEl.play().catch(() => {});
    playRemote();
    document.addEventListener("pointerdown", playRemote, { once: true, passive: true });
  };
  // Auto-recover from a dropped/failed ICE path without leaving the seat
  // or the room — this is what makes seat switches / brief network blips
  // not require a manual rejoin. First try a real ICE restart (renegotiate
  // the same connection — fast, no audio-element/track churn); only tear
  // the whole peer connection down and rebuild it if that doesn't recover.
  let iceRestartTried = false;
  pc.oniceconnectionstatechange = () => {
    console.log("[voice]", remoteSocketId, "ice state:", pc.iceConnectionState);
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      iceRestartTried = false;
      return;
    }
    if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
      if (!iceRestartTried && pc.iceConnectionState === "failed") {
        iceRestartTried = true;
        connectToPeer(remoteSocketId, true);
        return;
      }
      setTimeout(() => {
        if (peerConnections[remoteSocketId] === pc &&
            (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected")) {
          // Phase 1 / Tier A: server confirmed this peer is mid-reconnect
          // (socket dropped, inside its grace window) — hold the peer
          // connection open instead of rebuilding it; voice-peer-resumed
          // above will re-offer the moment they're actually back.
          const peerUserId = userIdForSocketId(remoteSocketId);
          if (peerUserId && reconnectingPeerUserIds.has(peerUserId)) return;
          closePeer(remoteSocketId);
          if (mySeatNumber !== null) connectToPeer(remoteSocketId);
        }
      }, 900);
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      iceRestartTried = false;
      return;
    }
    if (pc.connectionState === "failed") {
      setTimeout(() => {
        if (peerConnections[remoteSocketId] === pc && pc.connectionState === "failed") {
          closePeer(remoteSocketId);
          if (mySeatNumber !== null) connectToPeer(remoteSocketId, true);
        }
      }, 700);
    }
  };
  pc._diagTimer = startConnectionDiagnostics(pc, `room-peer:${remoteSocketId}`);
  peerConnections[remoteSocketId] = pc;
  return pc;
}

async function connectToPeer(remoteSocketId, iceRestart) {
  if (!remoteSocketId || remoteSocketId === socket.id) return;
  const pc = getOrCreatePeer(remoteSocketId);
  // Deterministic offerer for a brand-new pair: only the lexicographically
  // lower socket id starts the initial negotiation. This sharply reduces
  // three-way join glare while preserving perfect-negotiation handling for
  // reconnects and ICE restarts.
  if (!iceRestart && socket.id > remoteSocketId && pc.signalingState === "stable" && !pc.makingOffer) return;
  // Don't stack a second offer on top of one we're already sending, and
  // don't offer mid-negotiation unless this is a forced ICE restart.
  if (pc.makingOffer || (pc.signalingState !== "stable" && !iceRestart)) return;
  try {
    pc.makingOffer = true;
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(applyOpusFEC(offer));
    socket.emit("voice-offer", { target: remoteSocketId, targetUserId: userIdForSocketId(remoteSocketId), offer: pc.localDescription });
  } finally {
    pc.makingOffer = false;
  }
}

function closePeer(remoteSocketId) {
  const pc = peerConnections[remoteSocketId];
  if (pc) { if (pc._diagTimer) clearInterval(pc._diagTimer); pc.onicecandidate = null; pc.ontrack = null; pc.oniceconnectionstatechange = null; pc.close(); delete peerConnections[remoteSocketId]; }
  const audioEl = remoteAudioEls[remoteSocketId];
  if (audioEl) { audioEl.remove(); delete remoteAudioEls[remoteSocketId]; }
}

// PHASE 3 item #4 fix (2026-08-11) — bridges into the Android wrapper's
// VoiceForegroundService (see MainActivity.kt/VoiceForegroundService.kt)
// so the OS keeps this app's process at foreground priority for exactly
// as long as the user is actually in a voice room (seated or listening),
// not for the app's whole open/backgrounded lifetime. `window.AndroidVoiceBridge`
// only exists inside the Android WebView wrapper (added via
// addJavascriptInterface) — on a plain desktop/mobile browser it's
// undefined, so this is a silent no-op there, same "additive, zero effect
// outside its own platform" pattern as public/voice-sfu.js's own CDN-load
// guard. Wrapped in try/catch as an extra safety net: a JS bridge call
// throwing here must never be able to break room join/leave itself.
function notifyAndroidVoiceSession(active) {
  try {
    if (!window.AndroidVoiceBridge) return;
    if (active) { if (typeof window.AndroidVoiceBridge.onVoiceSessionStart === "function") window.AndroidVoiceBridge.onVoiceSessionStart(); }
    else { if (typeof window.AndroidVoiceBridge.onVoiceSessionEnd === "function") window.AndroidVoiceBridge.onVoiceSessionEnd(); }
  } catch (e) { console.error("[voice] AndroidVoiceBridge call failed:", e && e.message); }
}

function teardownVoice() {
  // Phase 3 / Step 3.3: mesh cleanup below is unchanged and harmless to run
  // even in SFU mode (peerConnections is simply always empty there, so
  // this loop is a no-op). SFU-specific cleanup (LiveKit disconnect +
  // /api/voice-sfu/leave) is fired alongside it, not instead of it.
  if (voiceMode === "sfu") teardownSfuVoice();
  Object.keys(peerConnections).forEach(closePeer);
  stopVoiceActivityDetection();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  micEnabled = false;
  mySeatNumber = null;
  speakingUsers.clear();
  notifyAndroidVoiceSession(false); // PHASE 3 item #4 fix
}

// ===========================================================================
// WEBRTC VOICE — SFU (Phase 3 / Step 3.3, additive)
// ===========================================================================
// Everything in this section only ever runs when voiceMode === "sfu" (set
// by refreshVoiceMode(), which itself only ever returns "sfu" when the
// SERVER reports VOICE_MODE=sfu — see /api/voice-sfu/mode in
// voice_sfu/index.js). None of the functions above this section call into
// here except through that guard, and nothing here calls into the mesh
// functions above (connectToPeer, getOrCreatePeer, closePeer) — the two
// transports never mix for a single voice session.

// Mirrors initMicIfNeeded()'s mesh branch as closely as possible: same
// secure-context check, same VOICE_AUDIO_CONSTRAINTS, same
// startVoiceActivityDetection() call so the speaking ring / socket
// "voice-activity" broadcast work identically regardless of transport.
// The only difference is what happens with the resulting localStream once
// we have it: connectSfuRoom() publishes it to LiveKit instead of adding
// it as a track on a set of RTCPeerConnections.
async function initSfuMicIfNeeded() {
  sfuVoiceLeaving = false;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("[voice-sfu] blocked: not a secure context (need https:// or http://localhost). Current origin:", location.origin);
    toast("HTTPS is required for voice — the mic won't work on phones over http://IP:3000, use ngrok/Cloudflare Tunnel instead");
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS });
    localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    startVoiceActivityDetection();
  } catch (e) {
    console.error("[voice-sfu] getUserMedia failed:", e.name, e.message);
    toast("Microphone permission required");
    return;
  }
  await connectSfuRoom();
}

// Mints a LiveKit token via POST /api/voice-sfu/join (seat-checked
// server-side, see roomManager.isUserSeatedInRoom in voice_sfu/index.js)
// and hands it to public/voice-sfu.js to actually connect. Idempotent —
// safe to call again while already connected (sfuConnected guards it) or
// from more than one call site (initSfuMicIfNeeded() and the mic-toggle
// retry path both reach this).
let sfuRecoveryTimer = null;
let sfuRecoveryAttempt = 0;
let sfuRecoveryRunning = false;
let sfuVoiceLeaving = false;

function cancelSfuRecovery() {
  if (sfuRecoveryTimer) { clearTimeout(sfuRecoveryTimer); sfuRecoveryTimer = null; }
  sfuRecoveryAttempt = 0;
  sfuRecoveryRunning = false;
}

function scheduleSfuRecovery(reason = "unknown") {
  if (sfuVoiceLeaving || voiceMode !== "sfu" || !currentRoomId || !me) return;
  if (sfuRecoveryTimer || sfuRecoveryRunning) return;
  const delay = Math.min(30000, Math.max(500, 500 * Math.pow(2, Math.min(sfuRecoveryAttempt, 6))));
  sfuRecoveryAttempt++;
  sfuRecoveryTimer = setTimeout(async () => {
    sfuRecoveryTimer = null;
    if (sfuVoiceLeaving || !currentRoomId || !me || window.PingPongVoiceSFU.isConnected()) return;
    sfuRecoveryRunning = true;
    try {
      // Rebuild the local microphone only when this user is seated. Audience
      // listeners reconnect without requesting microphone permission.
      if (mySeatNumber !== null && mySeatNumber !== undefined) {
        if (!localStream) {
          await initSfuMicIfNeeded();
        } else {
          await connectSfuRoom();
        }
      } else {
        await connectSfuAsAudience();
      }
      if (window.PingPongVoiceSFU.isConnected()) cancelSfuRecovery();
    } catch (e) {
      console.warn("[voice-sfu] recovery attempt failed:", reason, e && e.message);
    } finally {
      sfuRecoveryRunning = false;
      if (!window.PingPongVoiceSFU.isConnected() && !sfuVoiceLeaving) scheduleSfuRecovery("retry");
    }
  }, delay);
}

async function recoverSfuAfterDisconnect(reason) {
  if (reason === "reconnecting" || reason === "reconnected") return;
  sfuConnected = false;
  scheduleSfuRecovery(reason || "disconnected");
}

async function connectSfuRoom() {
  if (!currentRoomId || !me || !localStream) return;
  // PHASE 3, STEP 3.6 — audience -> seat upgrade path. If we're already
  // connected to the LiveKit room (as a subscribe-only audience listener,
  // see connectSfuAsAudience below), publish the mic onto that SAME
  // connection instead of disconnecting and reconnecting — the design
  // this step's spec calls for ("no unnecessary reconnect if the SDK
  // allows it"). Server-side publish permission for our identity is
  // granted independently by voice_sfu/sync.js's onSeatChanged, fired by
  // the very same take-seat/mod-move-seat event that led here — this
  // block never grants itself permission, it only attempts the publish.
  if (window.PingPongVoiceSFU.isConnected()) {
    const micTrack = localStream.getAudioTracks()[0];
    try {
      await window.PingPongVoiceSFU.publishMicTrack(micTrack);
    } catch (e) {
      // Known race, documented in PHASE3_STEP36_REPORT.md: sync.js's
      // onSeatChanged is fire-and-forget on the server, so the LiveKit-
      // side permission grant may not have landed yet when we tried to
      // publish. One short retry covers the normal case; if it still
      // fails, the mic-toggle button lets the person retry manually
      // (spec requirement: never crash the room over this).
      console.error("[voice-sfu] publish (upgrade) failed; retrying with bounded backoff:", e && e.message);
      let published = false;
      for (const delay of [400, 800, 1600, 3000]) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        try { await window.PingPongVoiceSFU.publishMicTrack(micTrack); published = true; break; }
        catch (e2) { console.warn("[voice-sfu] publish retry failed:", e2 && e2.message); }
      }
      if (!published) scheduleSfuRecovery("seat-publish-permission");
    }
    sfuConnected = true;
    return;
  }
  if (sfuConnected) return; // defensive: sfuConnected true but no live Room reference (e.g. mid-teardown) — avoid a duplicate join attempt
  try {
    const res = await fetch("/api/voice-sfu/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: currentRoomId, userId: me.userId, userName: me.name })
    });
    const data = await res.json();
    if (!data || !data.success) {
      console.error("[voice-sfu] /api/voice-sfu/join failed:", data && data.message);
      return; // spec requirement #9: never crash the room — just stay without SFU audio this session
    }
    if (data.mode !== "sfu") return; // server flipped back to mesh between our mode-check and this join — nothing to connect to here, mesh path was never touched anyway
    const micTrack = localStream.getAudioTracks()[0];
    await window.PingPongVoiceSFU.connect({
      url: data.livekitUrl,
      token: data.token,
      micTrack,
      onSpeakingChanged: (userId, speaking) => {
        if (!userId || (me && userId === me.userId)) return; // our own speaking already reaches everyone via the existing socket "voice-activity" broadcast
        if (speaking) speakingUsers.add(userId); else speakingUsers.delete(userId);
        if (currentRoom) renderSeats(seatsFromMap());
      },
      onDisconnected: (state) => {
        if (state === "reconnecting" || state === "reconnected") return;
        recoverSfuAfterDisconnect(state || "disconnected");
      }
    });
    sfuConnected = true;
  } catch (e) {
    // spec requirement #9: LiveKit connection failure must fall back
    // gracefully and never crash the room. Known, documented limitation
    // (see PHASE3_STEP33_REPORT.md): this does not re-route to mesh
    // mid-session — the user keeps their mic/VAD/UI working normally, but
    // won't exchange SFU audio with others until a fresh room join
    // succeeds in connecting.
    console.error("[voice-sfu] connect failed:", e && e.message);
    sfuConnected = false;
  }
}

// PHASE 3, STEP 3.6 addition — audience (non-seated) SFU listening.
// Joins the mapped LiveKit room as a subscribe-only participant: no
// getUserMedia call, no mic permission prompt, canPublish:false baked
// into the token server-side (see provider.js). Idempotent — guarded by
// window.PingPongVoiceSFU.isConnected(), so it's safe to call on every
// room-state sync (join, reconnect, refresh) without ever double-
// connecting a seated user who's already publishing.
async function connectSfuAsAudience() {
  sfuVoiceLeaving = false;
  if (!currentRoomId || !me || voiceMode !== "sfu") return;
  if (window.PingPongVoiceSFU.isConnected()) return;
  try {
    const res = await fetch("/api/voice-sfu/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: currentRoomId, userId: me.userId, userName: me.name })
    });
    const data = await res.json();
    if (!data || !data.success || data.mode !== "sfu") return; // never crash the room — silently stay without SFU audio this session, same fallback posture as connectSfuRoom
    await window.PingPongVoiceSFU.connect({
      url: data.livekitUrl,
      token: data.token,
      // no micTrack — audience never publishes
      onSpeakingChanged: (userId, speaking) => {
        if (!userId || (me && userId === me.userId)) return;
        if (speaking) speakingUsers.add(userId); else speakingUsers.delete(userId);
        if (currentRoom) renderSeats(seatsFromMap());
      },
      onDisconnected: (state) => {
        if (state === "reconnecting" || state === "reconnected") return;
        recoverSfuAfterDisconnect(state || "disconnected");
      }
    });
    sfuConnected = true;
  } catch (e) {
    console.error("[voice-sfu] audience connect failed:", e && e.message);
    sfuConnected = false;
  }
}

// PHASE 3, STEP 3.6 addition — the seat -> audience counterpart. Stops
// publishing (unpublishes the LiveKit track AND releases the actual mic
// hardware — the stronger of the two guarantees, so the browser's mic-
// in-use indicator turns off, not just a server-side permission flag)
// while KEEPING the LiveKit Room connected so the user keeps hearing
// seated speakers as an audience member. This is the client-side half of
// the exact same transition voice_sfu/sync.js's onSeatChanged already
// performs server-side (revoking the LiveKit publish grant).
async function downgradeSfuToAudience() {
  if (voiceMode !== "sfu") return;
  if (window.PingPongVoiceSFU.isConnected()) {
    try { await window.PingPongVoiceSFU.unpublishMicTrack(); }
    catch (e) { console.error("[voice-sfu] unpublish on downgrade failed:", e && e.message); }
  }
  stopVoiceActivityDetection();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  micEnabled = false;
  $("btn-mic-toggle").classList.remove("active");
}

async function teardownSfuVoice() {
  sfuVoiceLeaving = true;
  cancelSfuRecovery();
  if (sfuConnected) {
    try { await window.PingPongVoiceSFU.disconnect(); } catch (e) { /* already gone — safe to ignore */ }
    sfuConnected = false;
  }
  if (currentRoomId && me) {
    // Best-effort bookkeeping only (see voice_sfu/roomManager.js) — fire
    // and forget, same as the rest of this app's non-critical POSTs.
    fetch("/api/voice-sfu/leave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: currentRoomId, userId: me.userId })
    }).catch(() => {});
  }
}

// ===========================================================================
// PROFILE
// ===========================================================================
async function openOwnProfile() {
  const r = await api("/api/user/" + me.mobile);
  if (r.success) { me = r.user; saveSession(); }
  $("profile-avatar").src = me.photo || placeholderAvatar(me.name);
  $("profile-name-display").textContent = me.name;
  $("profile-name-input").value = me.name;
  $("profile-bio-input").value = me.bio || "";
  applyIdDisplay($("profile-userid"), me);
  $("profile-visitors").textContent = me.visitors || 0;
  $("profile-followers").textContent = me.followers;
  $("profile-following").textContent = me.following;
  applyLevelBadge($("profile-level-chip"), me.level);
  $("menu-wallet-coins").textContent = me.coins;
  $("menu-wallet-diamonds").textContent = me.diamonds;
  applyVipBadge($("profile-vip-badge"), me.vipLevel);
  applyCustomTag($("profile-tag-badge"), me.customTag);
  applyFrameRing($("profile-avatar-frame"), me.vipLevel);
  applyCustomFrame($("profile-avatar-frame"), me.activeFrame);
  refreshMySvipTag();
  $("profile-edit-panel").classList.add("hidden");
  checkAgencyMenu();
  checkCoinCenterMenu();
  showView("view-profile");
}

$("btn-copy-id").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(me.userId);
    const btn = $("btn-copy-id");
    btn.classList.add("copied");
    toast("ID copied");
    setTimeout(() => btn.classList.remove("copied"), 1500);
  } catch (e) { toast("Could not copy"); }
});

$("menu-edit-profile").addEventListener("click", async () => {
  const opening = $("profile-edit-panel").classList.contains("hidden");
  $("profile-edit-panel").classList.toggle("hidden");
  if (opening) {
    await loadCountriesCache();
    setGenderPills($("edit-gender-row"), me.gender);
    buildCountryOptions($("edit-country"), me.country);
    buildLanguageOptions($("edit-language"), me.country, me.language);
    $("edit-country").onchange = () => buildLanguageOptions($("edit-language"), $("edit-country").value, null);
  }
});

$("btn-save-profile").addEventListener("click", async () => {
  const name = $("profile-name-input").value.trim();
  const bio = $("profile-bio-input").value.trim();
  const gender = $("edit-gender-row").dataset.selected;
  const country = $("edit-country").value;
  const language = $("edit-language").value;
  // Profile Edit (guideline): Photo / Username / Gender / Country / Language
  // can all be changed later. If all three of Gender/Country/Language are
  // filled in, route the (validated, unique-username-checked) save through
  // the same endpoint First Time Setup uses. Name/Bio always save via the
  // original endpoint too, so editing your name still works even before
  // you've picked a gender/country/language (e.g. very old accounts).
  if (gender && country && language) {
    const r1 = await api("/api/user/complete-profile", "POST", { username: name, gender, country, language });
    if (!r1.success) { toast(r1.message || "Something went wrong"); return; }
    me = r1.user; saveSession(); applyLanguage(me.language);
  }
  const r = await api("/api/user/update-profile", "POST", { name, bio });
  if (r.success) {
    me = r.user; saveSession(); fillHomeProfile();
    toast("Profile updated");
  } else toast(r.message || "Something went wrong");
});

$("profile-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("photo", file);
  const r = await apiUpload("/api/user/upload-photo", fd);
  if (r.success) {
    me.photo = r.url; saveSession();
    $("profile-avatar").src = r.url;
    fillHomeProfile();
  } else toast(r.message || "Upload failed");
});

document.querySelectorAll("[data-follow-list]").forEach((btn) => {
  btn.addEventListener("click", () => openFollowList(btn.getAttribute("data-follow-list")));
});

async function openFollowList(mode) {
  followListMode = mode;
  $("follow-list-title").textContent = mode === "followers" ? "Followers" : "Following";
  const r = await api(`/api/user/${me.mobile}/${mode}`);
  const list = r.success ? (r[mode] || []) : [];
  const wrap = $("follow-list-items");
  wrap.innerHTML = "";
  $("follow-list-empty").classList.toggle("hidden", list.length > 0);
  list.forEach((u) => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <img class="avatar avatar-sm" src="${u.photo || placeholderAvatar(u.name)}">
      <div class="user-row-body"><span class="name">${escapeHtml(u.name)}</span><span class="sub">ID: ${escapeHtml(u.userId)}</span></div>
    `;
    row.addEventListener("click", () => openOtherProfile(u.userId));
    wrap.appendChild(row);
  });
  showView("view-follow-list");
}
$("btn-back-follow-list").addEventListener("click", openOwnProfile);

let otherProfileUser = null;
async function openOtherProfile(userId) {
  const r = await api("/api/user/by-id/" + userId);
  if (!r.success) { toast(r.message || "User not found"); return; }
  otherProfileUser = r.user;
  $("other-avatar").src = otherProfileUser.photo || placeholderAvatar(otherProfileUser.name);
  $("other-name").textContent = otherProfileUser.name;
  applyIdDisplay($("other-userid"), otherProfileUser);
  $("other-followers").textContent = otherProfileUser.followers;
  $("other-following").textContent = otherProfileUser.following;
  $("other-level").textContent = otherProfileUser.level || 1;
  applyVipBadge($("other-vip-badge"), otherProfileUser.vipLevel);
  applyCustomTag($("other-tag-badge"), otherProfileUser.customTag);
  applyFrameRing($("other-avatar-frame"), otherProfileUser.vipLevel);
  applyCustomFrame($("other-avatar-frame"), otherProfileUser.activeFrame);
  applyBlueBadge($("other-blue-badge"), otherProfileUser.activeBadges);
  refreshSvipTagFor(otherProfileUser.userId, $("other-svip-tag"));
  const amFollowing = (me.followingList || []).includes(otherProfileUser.userId);
  $("btn-follow-toggle").textContent = amFollowing ? "Unfollow" : "Follow";
  chApplyCallButtonVisibility(otherProfileUser.userId);
  await loadOtherRelationshipStatus(otherProfileUser.userId);
  showView("view-other-profile");
}
$("btn-back-other-profile").addEventListener("click", () => showView("view-home"));

$("btn-follow-toggle").addEventListener("click", async () => {
  if (!otherProfileUser) return;
  const amFollowing = (me.followingList || []).includes(otherProfileUser.userId);
  const endpoint = amFollowing ? "/api/user/unfollow" : "/api/user/follow";
  const r = await api(endpoint, "POST", { mobile: me.mobile, targetUserId: otherProfileUser.userId });
  if (r.success) {
    me = r.user; saveSession();
    $("btn-follow-toggle").textContent = (me.followingList || []).includes(otherProfileUser.userId) ? "Unfollow" : "Follow";
  } else toast(r.message || "Something went wrong");
});

$("btn-message-user").addEventListener("click", () => {
  if (!otherProfileUser) return;
  openThread(otherProfileUser.userId, otherProfileUser.name);
});

// ===========================================================================
// USER PROFILE BOTTOM SHEET — tapping a seat (or an Online Members row)
// slides this up instead of leaving the room. All data below is read from
// live room state (currentRoom) + the real /api/user/by-id lookup, no demo
// data. Permissions mirror exactly what the server already enforces for
// each action (isOwnerOrAdmin for moderation, hostId-only for admin grant).
// ===========================================================================
function seatNumberForUser(userId) {
  const seats = currentRoom?.seats || [];
  for (let i = 0; i < seats.length; i++) {
    if (seats[i] && seats[i].userId === userId) return i + 1;
  }
  return null;
}

let sheetTargetUserId = null;
let sheetRelationshipStatus = null;
let currentRelationshipLinks = [];
function closeProfileSheet() {
  $("sheet-user-profile").classList.remove("sheet-open");
  setTimeout(() => $("sheet-user-profile").classList.add("hidden"), 220);
}
function openProfileSheetEl() {
  const sheet = $("sheet-user-profile");
  sheet.classList.remove("hidden");
  requestAnimationFrame(() => sheet.classList.add("sheet-open"));
}

async function openSeatProfileSheet(userId, seatNumber) {
  if (!currentRoom) return;
  sheetTargetUserId = userId;
  const isMe = userId === me.userId;

  if (isMe) {
    $("sheet-avatar").src = me.photo || placeholderAvatar(me.name);
    $("sheet-name").textContent = me.name;
    applyIdDisplay($("sheet-userid"), me);
    applyLevelBadge($("sheet-level-chip"), me.level || 1);
    applyVipBadge($("sheet-vip-badge"), me.vipLevel);
    $("sheet-vip-badge").classList.remove("hidden");
    applyCustomTag($("sheet-tag-badge"), me.customTag);
    refreshSvipTagFor(me.userId, $("sheet-svip-tag"));
    applyFrameRing($("sheet-avatar-frame"), me.vipLevel);
    applyCustomFrame($("sheet-avatar-frame"), me.activeFrame);
    $("sheet-followers-row").classList.add("hidden");
    if (me.bio) { $("sheet-bio").textContent = me.bio; $("sheet-bio").classList.remove("hidden"); }
    else $("sheet-bio").classList.add("hidden");

    $("sheet-quick-actions").querySelectorAll("button").forEach(b => b.classList.add("hidden"));
    $("sheet-btn-profile").classList.remove("hidden");
    $("sheet-admin-section").classList.add("hidden");
    $("sheet-bottom-actions").classList.add("hidden");
    $("sheet-own-actions").classList.toggle("hidden", mySeatNumber === null);
  } else {
    const r = await api("/api/user/by-id/" + userId + "?viewerId=" + me.userId);
    if (!r.success) { toast(r.message || "User not found"); return; }
    const u = r.user;
    $("sheet-avatar").src = u.photo || placeholderAvatar(u.name);
    $("sheet-name").textContent = u.name;
    applyIdDisplay($("sheet-userid"), u);
    applyLevelBadge($("sheet-level-chip"), u.level || 1);
    applyVipBadge($("sheet-vip-badge"), u.vipLevel);
    $("sheet-vip-badge").classList.remove("hidden");
    applyCustomTag($("sheet-tag-badge"), u.customTag);
    refreshSvipTagFor(u.userId, $("sheet-svip-tag"));
    applyFrameRing($("sheet-avatar-frame"), u.vipLevel);
    applyCustomFrame($("sheet-avatar-frame"), u.activeFrame);
    $("sheet-followers-row").classList.remove("hidden");
    $("sheet-followers").textContent = u.followers || 0;
    if (u.bio) { $("sheet-bio").textContent = u.bio; $("sheet-bio").classList.remove("hidden"); }
    else $("sheet-bio").classList.add("hidden");

    $("sheet-quick-actions").querySelectorAll("button").forEach(b => b.classList.remove("hidden"));
    const amFollowing = (me.followingList || []).includes(u.userId);
    $("sheet-btn-follow").textContent = amFollowing ? "Unfollow" : "Follow";
    $("sheet-bottom-actions").classList.remove("hidden");
    $("sheet-own-actions").classList.add("hidden");

    const isOwner = currentRoom.hostId === me.userId;
    const isAdmin = (currentRoom.adminIds || []).includes(me.userId);
    const canModerate = (isOwner || isAdmin) && userId !== currentRoom.hostId;
    $("sheet-admin-section").classList.toggle("hidden", !canModerate);
    if (canModerate) buildSheetAdminControls(u, seatNumber, isOwner);
  }
  await loadSheetRelationshipStatus(userId);
  openProfileSheetEl();
}

async function fetchRelationshipStatus(targetUserId) {
  if (!targetUserId || targetUserId === me.userId) return null;
  const r = await api("/api/relationships/status/" + targetUserId);
  return r.success ? r : null;
}

function relationshipPairText(rel) {
  if (!rel) return "";
  const ids = [rel.userA, rel.userB].sort();
  return `CP • ID ${ids[0]}  ×  ID ${ids[1]}`;
}

function renderRelationshipControlButtons(containerId, status, targetUserId) {
  const wrap = $(containerId);
  if (!wrap) return;
  const friendship = wrap.querySelector(containerId === "sheet-relationship-actions" ? "#sheet-btn-friendship" : "#btn-other-friendship");
  const cp = wrap.querySelector(containerId === "sheet-relationship-actions" ? "#sheet-btn-cp" : "#btn-other-cp");
  if (!friendship || !cp) return;
  const rel = status && status.relationship;
  const pending = status && status.pending;
  const set = (btn, label, disabled) => { btn.textContent = label; btn.disabled = !!disabled; };
  if (rel) {
    set(friendship, rel.type === "friendship" ? "🤝 Friendship Active" : "🤝 Friendship", rel.type === "friendship" || !!pending);
    set(cp, rel.type === "cp" ? "💞 CP Active" : "💞 CP", rel.type === "cp" || !!pending);
    return;
  }
  if (pending) {
    const outgoing = pending.fromUserId === me.userId;
    if (pending.type === "friendship") set(friendship, outgoing ? "🤝 Friendship Sent" : "🤝 Friendship Pending", true);
    else set(friendship, "🤝 Friendship", true);
    if (pending.type === "cp") set(cp, outgoing ? "💞 CP Sent" : "💞 CP Pending", true);
    else set(cp, "💞 CP", true);
    return;
  }
  set(friendship, `🤝 Friendship • ${(status.friendshipCost || 100000).toLocaleString()} Coins`, false);
  set(cp, `💞 CP • ${(status.cpCost || 500000).toLocaleString()} Coins`, false);
}

function renderRelationshipProfileStatus(elId, status, targetUserId) {
  const el = $(elId);
  if (!el) return;
  const rel = status && status.relationship;
  if (rel && rel.type === "cp") {
    el.innerHTML = `<span class="relationship-cp-pair">${escapeHtml(relationshipPairText(rel))}</span>`;
    el.classList.remove("hidden");
    return;
  }
  // Friendship is intentionally not displayed as a profile relationship.
  el.innerHTML = "";
  el.classList.add("hidden");
}

async function loadSheetRelationshipStatus(targetUserId) {
  if (!targetUserId || targetUserId === me.userId) {
    $("sheet-relationship-actions").classList.add("hidden");
    $("sheet-relationship-status").classList.add("hidden");
    sheetRelationshipStatus = null;
    return;
  }
  const status = await fetchRelationshipStatus(targetUserId);
  sheetRelationshipStatus = status;
  if (!status) { $("sheet-relationship-actions").classList.add("hidden"); return; }
  $("sheet-relationship-actions").classList.remove("hidden");
  renderRelationshipControlButtons("sheet-relationship-actions", status, targetUserId);
  renderRelationshipProfileStatus("sheet-relationship-status", status, targetUserId);
}

async function loadOtherRelationshipStatus(targetUserId) {
  const status = await fetchRelationshipStatus(targetUserId);
  if (!status) { $("other-relationship-actions").classList.add("hidden"); $("other-relationship-status").classList.add("hidden"); return; }
  $("other-relationship-actions").classList.remove("hidden");
  renderRelationshipControlButtons("other-relationship-actions", status, targetUserId);
  renderRelationshipProfileStatus("other-relationship-status", status, targetUserId);
}

async function sendRelationshipRequest(targetUserId, type, context) {
  const status = await fetchRelationshipStatus(targetUserId);
  if (!status) return;
  if (status.relationship || status.pending) {
    toast("A relationship or request is already active");
    return;
  }
  const cost = type === "cp" ? status.cpCost : status.friendshipCost;
  const label = type === "cp" ? "CP" : "Friendship";
  if ((me.coins || 0) < cost) { toast(`Not enough Coins — ${cost.toLocaleString()} Coins required`); return; }
  if (!confirm(`Send ${label} request for ${cost.toLocaleString()} Coins?`)) return;
  const r = await api("/api/relationships/request", "POST", { targetUserId, type });
  if (!r.success) { toast(r.message || "Could not send request"); return; }
  if (r.request) {
    me.coins = Math.max(0, me.coins - cost);
    saveSession();
    fillHomeProfile();
  }
  if (context === "sheet") await loadSheetRelationshipStatus(targetUserId);
  else await loadOtherRelationshipStatus(targetUserId);
}

function buildSheetAdminControls(target, seatNumber, isOwner) {
  const grid = $("sheet-admin-grid");
  grid.innerHTML = "";
  const addBtn = (label, onClick, active) => {
    const b = document.createElement("button");
    b.className = "btn btn-ghost" + (active ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    grid.appendChild(b);
  };

  if (seatNumber) {
    const isLocked = (currentRoom.lockedSeats || []).includes(seatNumber);
    addBtn(isLocked ? "🔓 Seat Unlock" : "🔒 Seat Lock", () => {
      socket.emit("lock-seat", { roomId: currentRoomId, seatNumber, locked: !isLocked });
      closeProfileSheet();
    }, isLocked);

    const seat = (currentRoom.seats || [])[seatNumber - 1];
    const micMuted = !!(seat && seat.micMuted);
    addBtn(micMuted ? "🔊 Mic Unmute" : "🔇 Mic Mute", () => {
      socket.emit("mod-mute-users", { roomId: currentRoomId, targetUserIds: [target.userId], minutes: micMuted ? 0 : 15 });
      toast(micMuted ? "Mic unmuted" : "Mic muted for 15 minutes");
    }, micMuted);

    addBtn("⬇️ Remove From Seat", () => {
      socket.emit("mod-move-to-audience", { roomId: currentRoomId, targetUserIds: [target.userId] });
      closeProfileSheet();
    });

    // Feature: Owner/Admin "Move Mic" — pick an empty seat and move this
    // user straight there in one tap, instead of Remove From Seat + a
    // separate Invite To Seat (and waiting for them to accept).
    addBtn("🔄 Move Mic", () => {
      closeProfileSheet();
      openMoveMicPopup(target.userId, target.name);
    });
  } else {
    addBtn("💺 Invite to Seat", () => {
      socket.emit("mod-invite-to-seat", { roomId: currentRoomId, targetUserIds: [target.userId] });
      toast("Seat invite sent");
    });
  }

  const chatBanned = (currentRoom.chatBannedIds || []).includes(target.userId);
  addBtn(chatBanned ? "💬 Chat Unban" : "🚫 Ban Chat", () => {
    socket.emit("mod-chat-ban", { roomId: currentRoomId, targetUserId: target.userId, banned: !chatBanned });
    toast(chatBanned ? "Unbanned from chat" : "Banned from chat");
  }, chatBanned);

  addBtn("❌ Kick User", () => {
    if (!confirm(target.name + " from the room?")) return;
    socket.emit("kick-user", { roomId: currentRoomId, targetUserId: target.userId });
    closeProfileSheet();
  });

  if (isOwner) {
    const isAdmin = (currentRoom.adminIds || []).includes(target.userId);
    addBtn(isAdmin ? "🛡️ Remove Admin" : "🛡️ Make Room Admin", () => {
      socket.emit("set-admin", { roomId: currentRoomId, targetUserId: target.userId, isAdmin: !isAdmin });
      toast(isAdmin ? "Admin removed" : "Made Admin");
      closeProfileSheet();
    }, isAdmin);
  }
}

// Move Mic — one-tap seat picker used by the "🔄 Move Mic" admin action
// above. Lists every currently empty, unlocked seat; tapping one moves the
// target user there immediately via "mod-move-seat" (atomic on the server —
// see server.js — so the user is never briefly stuck in audience).
function openMoveMicPopup(targetUserId, targetName) {
  if (!currentRoom) return;
  const existing = $("sheet-move-mic");
  if (existing) existing.remove();

  const lockedSeats = currentRoom.lockedSeats || [];
  const openSeats = (currentRoom.seats || [])
    .map((s, i) => (!s && !lockedSeats.includes(i + 1) ? i + 1 : null))
    .filter((n) => n !== null);

  const overlay = document.createElement("div");
  overlay.id = "sheet-move-mic";
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-card">
      <div class="sheet-handle"></div>
      <p class="field-label">${escapeHtml(targetName)} to which seat?</p>
      <div class="sheet-admin-grid" id="move-mic-grid"></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.classList.remove("sheet-open"); setTimeout(() => overlay.remove(), 220); };

  const grid = overlay.querySelector("#move-mic-grid");
  if (!openSeats.length) {
    const p = document.createElement("p");
    p.className = "field-label";
    p.textContent = "No empty seat available";
    grid.appendChild(p);
  }
  openSeats.forEach((n) => {
    const b = document.createElement("button");
    b.className = "btn btn-ghost";
    b.textContent = "No." + n;
    b.addEventListener("click", () => {
      socket.emit("mod-move-seat", { roomId: currentRoomId, targetUserId: targetUserId, seatNumber: n });
      toast(targetName + " to No." + n + " seat");
      close();
    });
    grid.appendChild(b);
  });

  overlay.querySelector(".sheet-backdrop").addEventListener("click", close);
  requestAnimationFrame(() => overlay.classList.add("sheet-open"));
}

// ---------------------------------------------------------------------
// Empty-seat management popup (Touch-based Room Management System).
// Host/admin tapping an empty seat gets Lock/Unlock/Invite (+ Sit Here)
// instead of silently taking the seat. Built as a lightweight, throwaway
// sheet reusing the existing .sheet-overlay/.sheet-card styling so it
// matches the seat/ID-tap popups visually without new CSS.
// ---------------------------------------------------------------------
function openEmptySeatManagePopup(seatNumber) {
  if (!currentRoom) return;
  const existing = $("sheet-empty-seat");
  if (existing) existing.remove();

  const isLocked = (currentRoom.lockedSeats || []).includes(seatNumber);
  const overlay = document.createElement("div");
  overlay.id = "sheet-empty-seat";
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet-card">
      <div class="sheet-handle"></div>
      <p class="field-label">Seat #${seatNumber}</p>
      <div class="sheet-admin-grid" id="empty-seat-grid"></div>
    </div>`;
  document.body.appendChild(overlay);

  const grid = overlay.querySelector("#empty-seat-grid");
  const addBtn = (label, onClick) => {
    const b = document.createElement("button");
    b.className = "btn btn-ghost";
    b.textContent = label;
    b.addEventListener("click", () => { closeEmptySeatPopup(); onClick(); });
    grid.appendChild(b);
  };
  if (mySeatNumber === null) {
    addBtn("💺 Sit Here", () => socket.emit("take-seat", { roomId: currentRoomId, seatNumber }));
  }
  addBtn(isLocked ? "🔓 Seat Unlock" : "🔒 Seat Lock", () => {
    socket.emit("lock-seat", { roomId: currentRoomId, seatNumber, locked: !isLocked });
  });
  addBtn("📩 Invite User", () => openOnlineMembersForSeatInvite(seatNumber));

  overlay.querySelector(".sheet-backdrop").addEventListener("click", closeEmptySeatPopup);
  requestAnimationFrame(() => overlay.classList.add("sheet-open"));
}
function closeEmptySeatPopup() {
  const overlay = $("sheet-empty-seat");
  if (!overlay) return;
  overlay.classList.remove("sheet-open");
  setTimeout(() => overlay.remove(), 220);
}
function openOnlineMembersForSeatInvite(seatNumber) {
  // Reuse the existing Online Members list — picking someone there sends
  // the same "invite to seat" action already used from the ID Tap popup.
  $("room-online-count").click();
  toast("Choose who to invite to seat #" + seatNumber + "");
}

$("sheet-backdrop").addEventListener("click", closeProfileSheet);
$("sheet-btn-friendship").addEventListener("click", () => sendRelationshipRequest(sheetTargetUserId, "friendship", "sheet"));
$("sheet-btn-cp").addEventListener("click", () => sendRelationshipRequest(sheetTargetUserId, "cp", "sheet"));
$("btn-other-friendship").addEventListener("click", () => otherProfileUser && sendRelationshipRequest(otherProfileUser.userId, "friendship", "profile"));
$("btn-other-cp").addEventListener("click", () => otherProfileUser && sendRelationshipRequest(otherProfileUser.userId, "cp", "profile"));
$("sheet-btn-profile").addEventListener("click", () => {
  closeProfileSheet();
  if (sheetTargetUserId === me.userId) openOwnProfile();
  else openOtherProfile(sheetTargetUserId);
});
$("sheet-btn-chat").addEventListener("click", async () => {
  const r = await api("/api/user/by-id/" + sheetTargetUserId);
  closeProfileSheet();
  if (r.success) openThread(sheetTargetUserId, r.user.name);
});
$("sheet-btn-mention").addEventListener("click", async () => {
  const r = await api("/api/user/by-id/" + sheetTargetUserId);
  closeProfileSheet();
  if (r.success) {
    const input = $("chat-input");
    input.value = (input.value ? input.value + " " : "") + "@" + r.user.name + " ";
    input.focus();
  }
});
$("sheet-btn-follow").addEventListener("click", async () => {
  const amFollowing = (me.followingList || []).includes(sheetTargetUserId);
  const endpoint = amFollowing ? "/api/user/unfollow" : "/api/user/follow";
  const r = await api(endpoint, "POST", { mobile: me.mobile, targetUserId: sheetTargetUserId });
  if (r.success) {
    me = r.user; saveSession();
    $("sheet-btn-follow").textContent = (me.followingList || []).includes(sheetTargetUserId) ? "Unfollow" : "Follow";
  } else toast(r.message || "Something went wrong");
});
$("sheet-btn-gift").addEventListener("click", () => {
  const targetId = sheetTargetUserId;
  closeProfileSheet();
  openGiftModal(targetId);
});
$("sheet-btn-leave-seat").addEventListener("click", () => {
  if (mySeatNumber === null) { closeProfileSheet(); return; }
  socket.emit("leave-seat", { roomId: currentRoomId });
  closeProfileSheet();
});

// ===========================================================================
// PRIVATE MESSAGES
// ===========================================================================
async function openInbox() {
  const r = await api("/api/messages/inbox/" + me.userId);
  const conversations = r.success ? r.conversations : [];
  const wrap = $("inbox-list");
  wrap.innerHTML = "";
  $("inbox-empty").classList.toggle("hidden", conversations.length > 0);
  conversations.forEach((c) => {
    const row = document.createElement("div");
    row.className = "user-row";
    const badge = c.isAi ? ` <span title="Verified · Always Online" style="color:#3ba9ff;">✔️ Online</span>` : "";
    row.innerHTML = `
      <img class="avatar avatar-sm" src="${c.otherPhoto || placeholderAvatar(c.otherName)}">
      <div class="user-row-body"><span class="name">${escapeHtml(c.otherName)}${badge}</span><span class="sub">${escapeHtml(c.lastMessage)}</span></div>
    `;
    row.addEventListener("click", () => openThread(c.otherUserId, c.otherName, c.otherPhoto));
    wrap.appendChild(row);
  });
  showView("view-inbox");
}

// PHASE 4 FIX (2026-08-16, private chat audit — §9/§10): mirrors
// renderedChatMsgIds' role for room chat. Reset per-thread in openThread()
// (a new thread = a fresh render from scratch, no stale ids to carry over
// from a previously-open conversation) so switching from User A's thread to
// User B's can never cross-contaminate dedup state between them.
const renderedThreadMsgIds = new Set();

async function openThread(userId, userName, userPhoto) {
  threadPeerId = userId;
  threadPeerName = userName;
  threadPeerPhoto = userPhoto || "";
  renderedThreadMsgIds.clear();
  $("thread-title").textContent = userName;
  const [msgRes, callRes] = await Promise.all([
    api(`/api/messages/thread/${me.userId}/${userId}`),
    api(`/api/calls/history/${me.userId}/${userId}`)
  ]);
  const log = $("thread-log");
  log.innerHTML = "";
  const timeline = [];
  if (msgRes.success) msgRes.messages.forEach((m) => timeline.push({ ts: new Date(m.time).getTime(), kind: "message", data: m }));
  if (callRes.success) callRes.history.forEach((c) => timeline.push({ ts: c.endedAt || c.startedAt, kind: "call", data: c }));
  timeline.sort((a, b) => a.ts - b.ts);
  // Render while hidden, then reveal and perform the first scroll after the
  // browser has laid out the thread. Scrolling a display:none container
  // before layout is the reason the first message could appear below the
  // fold until a second message was sent.
  timeline.forEach((item) => item.kind === "message" ? appendThreadMsg(item.data) : appendThreadCallLog(item.data));
  showView("view-thread");
  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
  });
}
$("btn-back-thread").addEventListener("click", openInbox);
$("btn-thread-send").addEventListener("click", sendThreadMsg);
$("thread-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendThreadMsg(); });
async function sendThreadMsg() {
  const input = $("thread-input");
  const message = input.value.trim();
  if (!message || !threadPeerId) return;
  const r = await api("/api/messages/send", "POST", { fromUserId: me.userId, toUserId: threadPeerId, message });
  if (r.success) { appendThreadMsg(r.message); input.value = ""; }
}
// PRIORITY 6 fix (2026-08-12): same unbounded-DOM issue as room chat — cap
// the live thread view, never touch privateMessages.json / the server's
// persisted history. Reopening the thread re-fetches full history via
// openThread()'s /api/messages/thread call, so nothing is lost.
const MAX_VISIBLE_PRIVATE_MESSAGES = 30;

function appendThreadMsg(msg) {
  // PHASE 4 FIX (§9): dedupe by server-issued id, same pattern as room
  // chat's appendChatMsg — a duplicate delivery (multi-device fan-out,
  // reconnect resend) must never render a second bubble for the same
  // message. Older persisted messages predating this fix may still lack an
  // id (id == null) — those always render, exactly as before this fix.
  if (msg && msg.id != null) {
    if (renderedThreadMsgIds.has(msg.id)) return;
    renderedThreadMsgIds.add(msg.id);
  }
  const log = $("thread-log");
  const div = document.createElement("div");
  const out = msg.from === me.userId;
  div.className = "thread-msg " + (out ? "out" : "in");
  if (msg.type === "agency_invite") {
    div.appendChild(agencyInviteCard(msg));
  } else if (msg.type === "relationship_request") {
    div.appendChild(relationshipRequestCard(msg));
  } else {
    div.textContent = msg.message;
  }
  if (msg && msg.id != null) div.dataset.msgId = String(msg.id);
  log.appendChild(div);
  const wasAtBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 40;
  while (log.children.length > MAX_VISIBLE_PRIVATE_MESSAGES) {
    const oldest = log.firstChild;
    if (oldest && oldest.dataset && oldest.dataset.msgId != null) renderedThreadMsgIds.delete(oldest.dataset.msgId);
    log.removeChild(oldest);
  }
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}
// Renders one call-history entry (missed/rejected/cancelled/completed) as a
// centered status line inside the open thread — same idea as WhatsApp/
// Messenger's inline "Missed call" row. Called both when opening a thread
// (past history) and live, the instant a call with the open peer ends.
function appendThreadCallLog(entry) {
  const log = $("thread-log");
  const div = document.createElement("div");
  const icon = entry.type === "video" ? "🎥" : "📞";
  const missedLike = entry.status === "missed" || entry.status === "rejected" || entry.status === "cancelled";
  div.className = "thread-call-log" + (missedLike ? " missed" : "");
  let label;
  if (entry.status === "missed") label = "Missed " + entry.type + " call";
  else if (entry.status === "rejected") label = (entry.from === me.userId ? "Declined by " + threadPeerName : "You declined") + " · " + entry.type + " call";
  else if (entry.status === "cancelled") label = "Cancelled " + entry.type + " call";
  else label = entry.type[0].toUpperCase() + entry.type.slice(1) + " call · " + formatCallDuration(entry.durationSec);
  div.textContent = icon + " " + label;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function formatCallDuration(sec) {
  sec = sec || 0;
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}
function relationshipRequestCard(msg) {
  const d = msg.data || {};
  const type = d.relationshipType === "cp" ? "cp" : "friendship";
  const label = type === "cp" ? "CP Request" : "Friendship Request";
  const icon = type === "cp" ? "/images/relationships/cp-heart.png" : "/images/relationships/friendship-heart.png";
  const card = document.createElement("div");
  card.className = "relationship-request-card";
  const canRespond = msg.to === me.userId && d.status === "pending";
  card.innerHTML = `
    <div class="relationship-request-head">
      <img class="relationship-request-icon" src="${icon}" alt="">
      <div><div class="relationship-request-title">${label}</div><div class="relationship-request-sub">${(d.cost || 0).toLocaleString()} Coins</div></div>
    </div>
    <div class="relationship-request-status"></div>`;
  const statusBox = card.querySelector(".relationship-request-status");
  if (canRespond) {
    const actions = document.createElement("div");
    actions.className = "relationship-request-actions";
    actions.innerHTML = `<button class="btn btn-primary btn-sm rel-accept">Yes</button><button class="btn btn-ghost btn-sm rel-reject">No</button>`;
    statusBox.appendChild(actions);
    actions.querySelector(".rel-accept").addEventListener("click", () => respondRelationshipRequest(d.requestId, "accept", card));
    actions.querySelector(".rel-reject").addEventListener("click", () => respondRelationshipRequest(d.requestId, "reject", card));
  } else {
    const labelText = d.status === "accepted" ? "✅ Accepted" : d.status === "rejected" ? "❌ Declined" : d.status === "expired" ? "⌛ Expired" : "⏳ Pending";
    statusBox.textContent = labelText;
  }
  return card;
}

async function respondRelationshipRequest(requestId, action, cardEl) {
  const r = await api("/api/relationships/respond", "POST", { requestId, action });
  if (!r.success) { toast(r.message || "Request could not be processed"); return; }
  const statusBox = cardEl.querySelector(".relationship-request-status");
  if (statusBox) statusBox.innerHTML = action === "accept" ? '<div class="invite-card-status">✅ Accepted</div>' : '<div class="invite-card-status">❌ Declined</div>';
  if (action === "accept") toast(r.relationship && r.relationship.type === "cp" ? "💞 CP accepted" : "🤝 Friendship accepted");
  else toast("Request declined");
}

function agencyInviteCard(msg) {
  const d = msg.data || {};
  const card = document.createElement("div");
  card.className = "invite-card";
  const canRespond = msg.to === me.userId && d.status === "pending";
  card.innerHTML = `
    <div class="invite-card-head">
      ${d.agencyLogo ? `<img src="${escapeHtml(d.agencyLogo)}" class="invite-card-logo" alt="">` : `<div class="invite-card-logo placeholder">🏢</div>`}
      <div>
        <div class="invite-card-name">${escapeHtml(d.agencyName || "Agency")}</div>
        <div class="invite-card-id">Agency ID: ${escapeHtml(d.agencyId || "")}</div>
      </div>
    </div>
    <div class="invite-body-status"></div>
  `;
  const statusBox = card.querySelector(".invite-body-status");
  if (canRespond) {
    const actions = document.createElement("div");
    actions.className = "invite-card-actions";
    actions.innerHTML = `<button class="btn btn-primary btn-sm invite-accept">Accept</button><button class="btn btn-ghost btn-sm invite-decline">Decline</button>`;
    statusBox.appendChild(actions);
    actions.querySelector(".invite-accept").addEventListener("click", () => respondAgencyInvite(d.inviteId, "accept", card));
    actions.querySelector(".invite-decline").addEventListener("click", () => respondAgencyInvite(d.inviteId, "decline", card));
  } else {
    const label = d.status === "accepted" ? "✅ Accepted" : d.status === "declined" ? "❌ Declined" : "Pending";
    statusBox.innerHTML = `<div class="invite-card-status">${label}</div>`;
  }
  return card;
}
async function respondAgencyInvite(inviteId, action, cardEl) {
  const r = await api("/api/agency/invite/respond", "POST", { inviteId, userId: me.userId, action });
  if (!r.success) { toast(r.message || "Didn't work"); return; }
  if (action === "decline") {
    cardEl.closest(".thread-msg")?.remove();
    toast("Invitation declined");
  } else {
    me.isHost = true;
    saveSession();
    checkHostCenterMenu();
    const statusBox = cardEl.querySelector(".invite-body-status");
    if (statusBox) statusBox.innerHTML = `<div class="invite-card-status">✅ Accepted</div>`;
    toast("🎉 You are now an Agency Host! Check the Host Center menu.");
  }
}

// ===========================================================================
// PRIVATE AUDIO/VIDEO CALLING (WebRTC, signaling over the existing socket)
// Purely additive: its own state, its own DOM (#call-overlay), its own
// socket events (all namespaced "call:..."). Never touches room/voice
// (that's a separate WebRTC-less audio system tied to seats), gifts,
// wallet, or messaging code — the only thing it shares with messaging is
// dropping a call-log line into #thread-log when a call with the open
// peer ends, the same way WhatsApp/Messenger show missed-call rows inline.
// ===========================================================================
let iceServersCache = null;
let iceServersCacheAt = 0;
// PHASE 1 (Tier A): dynamic TURN credentials expire server-side (default
// 6h, TURN_CREDENTIAL_TTL_SECONDS). Re-fetching well inside that window
// keeps a long-lived tab (someone who leaves the app open for hours)
// from holding a stale/expired credential into a new call. Harmless
// no-op for static-credential deployments (TURN_SECRET unset) too.
const ICE_SERVERS_CACHE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
let currentCall = null;      // { callId, peerId, peerName, peerPhoto, type, role, status }
let callLocalStream = null;
let callPc = null;
let callTimerHandle = null;
let callSeconds = 0;
let pendingIceCandidates = [];
let pendingOfferSdp = null;
let usingFrontCamera = true;
let micMuted = false;
let cameraOff = false;
let speakerOn = true; // best-effort UI state — see toggleSpeaker() note

async function getIceServers() {
  if (iceServersCache && (Date.now() - iceServersCacheAt) < ICE_SERVERS_CACHE_MAX_AGE_MS) return iceServersCache;
  try {
    // PHASE 1 (Tier A): userId is optional/advisory — server never trusts
    // it for access control, only uses it to label a dynamic TURN
    // credential for easier auditing. Safe no-op if `me` isn't set yet.
    const uidParam = (typeof me !== "undefined" && me && me.userId) ? `?userId=${encodeURIComponent(me.userId)}` : "";
    const r = await api(`/api/calls/ice-servers${uidParam}`);
    iceServersCache = (r.success && r.iceServers && r.iceServers.length) ? r.iceServers : [{ urls: "stun:stun.l.google.com:19302" }];
    iceServersCacheAt = Date.now();
  } catch (e) {
    iceServersCache = [{ urls: "stun:stun.l.google.com:19302" }];
    iceServersCacheAt = Date.now();
  }
  // Diagnostics only (console, no UI): mirrors the server's own
  // "TURN Loaded"/"TURN Missing" log so it's visible from the client side
  // too, without a second network call — inferred from whether any entry
  // in the same response already carries TURN credentials.
  const hasTurn = iceServersCache.some((s) => s && s.username && s.credential);
  console.debug(hasTurn ? "[ice-config] TURN Loaded (client)" : "[ice-config] TURN Missing — STUN-only (client)");
  return iceServersCache;
}

function showCallOverlay() { $("call-overlay").classList.remove("hidden"); }
function hideCallOverlay() {
  $("call-overlay").classList.add("hidden");
  $("call-video-remote-wrap").classList.add("hidden");
  $("call-incoming-actions").classList.add("hidden");
  $("call-outgoing-actions").classList.add("hidden");
  $("call-active-controls").classList.add("hidden");
  $("call-video-remote").srcObject = null;
  $("call-video-local").srcObject = null;
}
function setCallStatusText(t) { $("call-status-text").textContent = t; }

function startCallTimer() {
  callSeconds = 0;
  setCallStatusText("00:00");
  stopCallTimer();
  callTimerHandle = setInterval(() => { callSeconds++; setCallStatusText(formatCallDuration(callSeconds)); }, 1000);
}
function stopCallTimer() { if (callTimerHandle) clearInterval(callTimerHandle); callTimerHandle = null; }

function teardownCall() {
  console.debug("[call-diag] Call Disconnected");
  stopCallTimer();
  if (callPc) {
    if (callPc._diagTimer) clearInterval(callPc._diagTimer);
    // Explicitly stop every sender's track before close(), and clear the
    // event handlers we attached — close() alone stops tracks too, but
    // being explicit here avoids relying on that for the onended-based
    // track-recovery handlers, so they can never fire during a normal,
    // intentional teardown and try to "recover" a call that's already over.
    try {
      callPc.getSenders().forEach((s) => { if (s.track) { s.track.onended = null; s.track.stop(); console.debug(`[call-diag] Track Removed (${s.track.kind})`); } });
    } catch (e) {}
    callPc.onicecandidate = null;
    callPc.ontrack = null;
    callPc.oniceconnectionstatechange = null;
    callPc.onconnectionstatechange = null;
    try { callPc.close(); } catch (e) {}
    callPc = null;
  }
  if (callLocalStream) { callLocalStream.getTracks().forEach((t) => { t.onended = null; t.stop(); }); callLocalStream = null; }
  pendingIceCandidates = [];
  pendingOfferSdp = null;
  micMuted = false; cameraOff = false;
  $("btn-call-mute").classList.remove("active");
  $("btn-call-camera-toggle").classList.remove("active");
  currentCall = null;
  hideCallOverlay();
}

function createPeerConnection(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  const sentCandidates = new Set(); // dedup, same as room voice — each unique candidate only needs sending once
  pc.onicecandidate = (e) => {
    if (!e.candidate || !currentCall) return;
    const key = e.candidate.candidate;
    if (sentCandidates.has(key)) return;
    sentCandidates.add(key);
    socket.emit("call:ice-candidate", { callId: currentCall.callId, candidate: e.candidate });
  };
  pc._diagTimer = startConnectionDiagnostics(pc, "call");
  pc.ontrack = (e) => {
    console.debug(`[call-diag] Remote Stream Ready track=${e.track.kind}`);
    const remoteVideo = $("call-video-remote");
    if (remoteVideo.srcObject !== e.streams[0]) remoteVideo.srcObject = e.streams[0];
    if (currentCall && currentCall.type === "video") $("call-video-remote-wrap").classList.remove("hidden");
    // Fix (connects but black screen): the `autoplay` attribute alone isn't
    // reliable on every mobile browser once srcObject is assigned to an
    // element that was just unhidden (display:none -> visible) — the video
    // element can sit on its first frame (black) until something calls
    // play() explicitly. This is a no-op when autoplay already worked.
    const playPromise = remoteVideo.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.then(() => {
        console.debug(`[call-diag] ${e.track.kind === "video" ? "Video" : "Audio"} Rendering (remote)`);
      }).catch(() => {});
    } else {
      console.debug(`[call-diag] ${e.track.kind === "video" ? "Video" : "Audio"} Rendering (remote)`);
    }
  };
  // ROOT-CAUSE FIX (voice stability pass): this used to hang up on the very
  // first ICE hiccup (Wi-Fi<->mobile switch, a couple seconds of dead
  // signal), with no attempt to recover — unlike the room-voice mesh
  // elsewhere in app.js, which already does a real ICE restart before ever
  // giving up. Mirrors that same recover-first pattern here: try one ICE
  // restart (only the original caller re-offers — an answerer only ever
  // reacts to call:offer, same as normal call setup), and only end the call
  // if that restart doesn't recover within a few seconds.
  let iceRestartTried = false;
  let iceFailTimer = null;
  pc.oniceconnectionstatechange = () => {
    console.debug(`[call-diag] ICE State: ${pc.iceConnectionState}`);
    if (!currentCall) return;
    const state = pc.iceConnectionState;
    if (state === "connected" || state === "completed") {
      iceRestartTried = false;
      if (iceFailTimer) { clearTimeout(iceFailTimer); iceFailTimer = null; }
      return;
    }
    if (state === "failed" || state === "disconnected") {
      if (currentCall.role === "caller" && !iceRestartTried && state === "failed") {
        iceRestartTried = true;
        setCallStatusText("Reconnecting...");
        pc.createOffer({ iceRestart: true })
          .then((offer) => pc.setLocalDescription(applyOpusFEC(offer)))
          .then(() => { if (currentCall) socket.emit("call:offer", { callId: currentCall.callId, sdp: pc.localDescription }); })
          .catch(() => {});
      }
      if (iceFailTimer) clearTimeout(iceFailTimer);
      iceFailTimer = setTimeout(() => {
        if (currentCall && (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected")) endCurrentCall();
      }, 8000);
    }
  };
  pc.onconnectionstatechange = () => {
    console.debug(`[call-diag] Connection State: ${pc.connectionState}`);
    if (!currentCall) return;
    if (pc.connectionState === "connecting") setCallStatusText("Reconnecting...");
  };
  return pc;
}

// STABILITY FIX: neither startCall() nor the accept handler previously
// guarded against a stale/leftover callPc before creating a new one (e.g. a
// double-tap on Accept, or a fast reject-then-call-again sequence landing
// inside the same tick). A leftover open RTCPeerConnection left dangling
// like that is a real duplicate-PeerConnection + memory-leak risk. Every
// call site below now routes through this instead of `new` + assign
// directly, so a prior connection is always closed first.
function createFreshCallPc(iceServers) {
  if (callPc) {
    console.debug("[call-diag] closing stale PeerConnection before creating a new one");
    if (callPc._diagTimer) clearInterval(callPc._diagTimer);
    try { callPc.close(); } catch (e) {}
    callPc = null;
  }
  return createPeerConnection(iceServers);
}

// STABILITY FIX: getUserMedia previously had zero retry logic — any
// transient failure (device briefly busy with another app, OS permission
// dialog race, a device enumeration hiccup right after a fresh permission
// grant) tore the call down immediately with a generic toast. Real-world
// failures here are frequently transient, so this now retries once after a
// short delay for the recoverable error classes (NotReadableError /
// TrackStartError = device busy, AbortError = OS-level hiccup) before
// giving up. Permission-denied and no-device errors are never retried since
// a retry can't fix those. Console-only diagnostics added per the
// diagnostics requirement; no UI/architecture change.
async function acquireLocalMedia(type, facingMode, _isRetry) {
  const constraints = type === "video"
    ? { audio: VOICE_AUDIO_CONSTRAINTS, video: { facingMode: facingMode || "user" } }
    : { audio: VOICE_AUDIO_CONSTRAINTS, video: false };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    console.debug(`[call-diag] Media Permission granted (${type})`);
  } catch (e) {
    console.debug(`[call-diag] Media Permission failed (${type}): ${e && e.name}`);
    const retryable = e && (e.name === "NotReadableError" || e.name === "TrackStartError" || e.name === "AbortError");
    if (retryable && !_isRetry) {
      await new Promise((res) => setTimeout(res, 600));
      return acquireLocalMedia(type, facingMode, true);
    }
    throw e;
  }
  callLocalStream = stream;
  console.debug(`[call-diag] Local Stream Ready (${type}) tracks=${stream.getTracks().map((t) => t.kind).join(",")}`);
  // Track-end recovery: if the OS/browser kills a track out from under us
  // (device unplugged, permission revoked mid-call, app backgrounded on a
  // platform that suspends media), try once to reacquire the same kind of
  // track and hot-swap it into the active peer connection rather than
  // leaving the call silently dead-audio or frozen-video.
  stream.getTracks().forEach((track) => {
    track.onended = () => {
      console.debug(`[call-diag] Track Removed unexpectedly (${track.kind})`);
      if (!currentCall || !callPc || !callLocalStream) return;
      const kind = track.kind;
      const recoveryConstraints = kind === "video"
        ? { video: { facingMode: usingFrontCamera ? "user" : "environment" } }
        : { audio: VOICE_AUDIO_CONSTRAINTS };
      navigator.mediaDevices.getUserMedia(recoveryConstraints).then((recStream) => {
        const newTrack = kind === "video" ? recStream.getVideoTracks()[0] : recStream.getAudioTracks()[0];
        if (!newTrack || !callLocalStream) return;
        const sender = callPc.getSenders().find((s) => s.track && s.track.kind === kind);
        if (sender) sender.replaceTrack(newTrack).catch(() => {});
        callLocalStream.addTrack(newTrack);
        newTrack.onended = track.onended;
        if (kind === "video") { const lv = $("call-video-local"); if (lv) lv.srcObject = callLocalStream; }
        console.debug(`[call-diag] Track Added via recovery (${kind})`);
      }).catch(() => { console.debug(`[call-diag] Track recovery failed (${kind})`); });
    };
  });
  if (type === "video") {
    $("call-video-remote-wrap").classList.remove("hidden");
    const localVideo = $("call-video-local");
    localVideo.srcObject = stream;
    localVideo.classList.remove("hidden");
    const p = localVideo.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    console.debug("[call-diag] Video Rendering (local)");
  }
  return stream;
}

async function startCall(type) {
  if (!threadPeerId) return;
  if (currentCall) { toast("You're already on a call"); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("Calling isn't supported on this browser"); return; }
  currentCall = { callId: null, peerId: threadPeerId, peerName: threadPeerName, peerPhoto: threadPeerPhoto, type, role: "caller", status: "dialing" };
  $("call-peer-photo").src = threadPeerPhoto || placeholderAvatar(threadPeerName);
  $("call-peer-name").textContent = threadPeerName;
  setCallStatusText("Calling...");
  $("call-outgoing-actions").classList.remove("hidden");
  showCallOverlay();
  try {
    const iceServers = await getIceServers();
    await acquireLocalMedia(type, "user");
    callPc = createFreshCallPc(iceServers);
    callLocalStream.getTracks().forEach((t) => { callPc.addTrack(t, callLocalStream); console.debug(`[call-diag] Track Added (${t.kind})`); });
  } catch (e) {
    toast("Couldn't access microphone/camera");
    teardownCall();
    return;
  }
  socket.emit("call:invite", { toUserId: threadPeerId, callType: type });
}
$("btn-thread-audio-call").addEventListener("click", () => startCall("audio"));
$("btn-thread-video-call").addEventListener("click", () => startCall("video"));

function showIncomingCall(callId, callType, from) {
  if (currentCall) { socket.emit("call:reject", { callId }); return; } // already busy locally
  currentCall = { callId, peerId: from.userId, peerName: from.userName, peerPhoto: from.userPhoto, type: callType, role: "callee", status: "ringing" };
  $("call-peer-photo").src = from.userPhoto || placeholderAvatar(from.userName);
  $("call-peer-name").textContent = from.userName;
  setCallStatusText((callType === "video" ? "Video" : "Audio") + " call...");
  $("call-incoming-actions").classList.remove("hidden");
  showCallOverlay();
}
$("btn-call-reject").addEventListener("click", () => {
  if (!currentCall) return;
  socket.emit("call:reject", { callId: currentCall.callId });
  teardownCall();
});
$("btn-call-cancel").addEventListener("click", () => {
  if (!currentCall) return;
  socket.emit("call:cancel", { callId: currentCall.callId });
  teardownCall();
});
$("btn-call-accept").addEventListener("click", async () => {
  if (!currentCall) return;
  const callId = currentCall.callId, type = currentCall.type;
  socket.emit("call:accept", { callId });
  setCallStatusText("Connecting...");
  $("call-incoming-actions").classList.add("hidden");
  $("call-active-controls").classList.remove("hidden");
  $("btn-call-camera-toggle").classList.toggle("hidden", type !== "video");
  $("btn-call-camera-switch").classList.toggle("hidden", type !== "video");
  try {
    const iceServers = await getIceServers();
    await acquireLocalMedia(type, "user");
    callPc = createFreshCallPc(iceServers);
    callLocalStream.getTracks().forEach((t) => { callPc.addTrack(t, callLocalStream); console.debug(`[call-diag] Track Added (${t.kind})`); });
    if (pendingOfferSdp) { await applyIncomingOffer(pendingOfferSdp); pendingOfferSdp = null; }
  } catch (e) {
    toast("Couldn't access microphone/camera");
    socket.emit("call:end", { callId });
    teardownCall();
  }
});
$("btn-call-hangup").addEventListener("click", () => endCurrentCall());
function endCurrentCall() {
  if (!currentCall) return;
  socket.emit("call:end", { callId: currentCall.callId });
  teardownCall();
}

async function applyIncomingOffer(sdp) {
  await callPc.setRemoteDescription(new RTCSessionDescription(sdp));
  for (const c of pendingIceCandidates) { try { await callPc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {} }
  pendingIceCandidates = [];
  const answer = applyOpusFEC(await callPc.createAnswer());
  await callPc.setLocalDescription(answer);
  socket.emit("call:answer", { callId: currentCall.callId, sdp: answer });
}

// ----- Mute / camera / camera-switch / speaker -----
$("btn-call-mute").addEventListener("click", () => {
  if (!callLocalStream) return;
  micMuted = !micMuted;
  callLocalStream.getAudioTracks().forEach((t) => t.enabled = !micMuted);
  console.debug(`[call-diag] Microphone ${micMuted ? "Disabled" : "Enabled"}`);
  $("btn-call-mute").classList.toggle("active", micMuted);
  if (currentCall) socket.emit("call:media-state", { callId: currentCall.callId, micMuted, cameraOff });
});
$("btn-call-camera-toggle").addEventListener("click", () => {
  if (!callLocalStream) return;
  cameraOff = !cameraOff;
  callLocalStream.getVideoTracks().forEach((t) => t.enabled = !cameraOff);
  console.debug(`[call-diag] Camera ${cameraOff ? "Disabled" : "Enabled"}`);
  $("btn-call-camera-toggle").classList.toggle("active", cameraOff);
  if (currentCall) socket.emit("call:media-state", { callId: currentCall.callId, micMuted, cameraOff });
});
$("btn-call-camera-switch").addEventListener("click", async () => {
  if (!callLocalStream || !currentCall || currentCall.type !== "video") return;
  usingFrontCamera = !usingFrontCamera;
  // Auto-recovery: replaceTrack occasionally fails transiently (camera
  // handle momentarily held by the OS during the facingMode switch) — retry
  // once before giving up and reverting the toggle state.
  const trySwitch = async (isRetry) => {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: usingFrontCamera ? "user" : "environment" }, audio: false });
    const newTrack = newStream.getVideoTracks()[0];
    const sender = callPc && callPc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (sender) await sender.replaceTrack(newTrack);
    const oldTrack = callLocalStream.getVideoTracks()[0];
    if (oldTrack) { callLocalStream.removeTrack(oldTrack); oldTrack.stop(); }
    newTrack.onended = oldTrack ? oldTrack.onended : null;
    callLocalStream.addTrack(newTrack);
    $("call-video-local").srcObject = callLocalStream;
    console.debug(`[call-diag] Track Added via camera switch (video, retry=${!!isRetry})`);
  };
  try {
    await trySwitch(false);
  } catch (e) {
    try { await trySwitch(true); }
    catch (e2) { toast("Couldn't switch camera"); usingFrontCamera = !usingFrontCamera; console.debug("[call-diag] camera switch auto-recovery failed"); }
  }
});
// Speaker/earpiece routing: browsers only expose HTMLMediaElement.setSinkId
// on a handful of platforms (mainly Chrome desktop) — there is no standard
// web API to force a phone's earpiece vs. loudspeaker the way a native
// Android/iOS app can. This toggle applies setSinkId where supported and
// otherwise just reflects the intended state in the UI; true earpiece
// routing on iOS/Android WebView needs a small native bridge (out of scope
// for a web-only client) — flagging this explicitly rather than silently
// no-op-ing.
$("btn-call-speaker").addEventListener("click", async () => {
  speakerOn = !speakerOn;
  $("btn-call-speaker").classList.toggle("active", speakerOn);
  const remoteVideo = $("call-video-remote");
  if (typeof remoteVideo.setSinkId === "function") {
    try { await remoteVideo.setSinkId(speakerOn ? "default" : "communications"); } catch (e) {}
  }
});

function registerCallSocketEvents() {
  socket.on("call:ringing", ({ callId }) => {
    if (currentCall) currentCall.callId = callId;
    setCallStatusText("Ringing...");
  });
  socket.on("call:incoming", ({ callId, callType, from }) => showIncomingCall(callId, callType, from));
  socket.on("call:incoming-cancel", ({ callId }) => {
    if (currentCall && currentCall.callId === callId && currentCall.status === "ringing" && currentCall.role === "callee") teardownCall();
  });

  socket.on("call:accepted", async ({ callId }) => {
    if (!currentCall) return;
    currentCall.callId = callId;
    currentCall.status = "connecting";
    setCallStatusText("Connecting...");
    $("call-outgoing-actions").classList.add("hidden");
    $("call-active-controls").classList.remove("hidden");
    $("btn-call-camera-toggle").classList.toggle("hidden", currentCall.type !== "video");
    $("btn-call-camera-switch").classList.toggle("hidden", currentCall.type !== "video");
    try {
      const offer = applyOpusFEC(await callPc.createOffer());
      await callPc.setLocalDescription(offer);
      socket.emit("call:offer", { callId, sdp: offer });
    } catch (e) { toast("Call failed to connect"); endCurrentCall(); }
  });

  socket.on("call:offer", async ({ callId, sdp }) => {
    if (!currentCall) return;
    if (currentCall.callId === null) currentCall.callId = callId;
    if (!callPc) { pendingOfferSdp = sdp; return; } // caller's offer beat our own media/pc setup
    await applyIncomingOffer(sdp);
  });

  socket.on("call:answer", async ({ sdp }) => {
    // Duplicate-answer guard, same reasoning as room voice: only meaningful
    // while we're actually waiting on one.
    if (!callPc || callPc.signalingState !== "have-local-offer") return;
    try { await callPc.setRemoteDescription(new RTCSessionDescription(sdp)); } catch (e) { return; }
    for (const c of pendingIceCandidates) { try { await callPc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {} }
    pendingIceCandidates = [];
  });

  socket.on("call:ice-candidate", async ({ candidate }) => {
    // Invalid-candidate guard: a malformed payload (missing/non-string
    // `candidate` field) should never be queued or handed to
    // RTCIceCandidate — both would either throw or silently pollute the
    // pending queue with junk that can never apply.
    if (!candidate || typeof candidate.candidate !== "string") { console.debug("[call-diag] ignored invalid ICE candidate"); return; }
    if (!callPc || !callPc.remoteDescription) { pendingIceCandidates.push(candidate); return; }
    try { await callPc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
  });

  socket.on("call:connected", () => { console.debug("[call-diag] Call Connected"); if (currentCall) { currentCall.status = "connected"; startCallTimer(); } });

  // Server-side disconnect-grace-period fix: the other side's socket
  // dropped (refresh, brief network blip) but the call itself is being
  // held open for a few seconds rather than ended outright.
  socket.on("call:peer-reconnecting", ({ callId }) => {
    if (currentCall && currentCall.callId === callId) setCallStatusText("Connection lost — waiting...");
  });
  socket.on("call:peer-resumed", ({ callId }) => {
    if (currentCall && currentCall.callId === callId && currentCall.status === "connected") setCallStatusText(formatCallDuration(callSeconds));
  });

  socket.on("call:peer-media-state", ({ micMuted: peerMuted }) => {
    if (currentCall) setCallStatusText(peerMuted ? (currentCall.peerName + " is muted") : formatCallDuration(callSeconds));
  });

  socket.on("call:busy", ({ toUserId, self }) => {
    toast(self ? "You're already on a call" : "That user is on another call");
    teardownCall();
  });
  socket.on("call:offline", () => { toast("User is offline"); teardownCall(); });

  socket.on("call:ended", (payload) => {
    if (payload.historyEntry && threadPeerId && currentCall && (currentCall.peerId === threadPeerId)) {
      appendThreadCallLog(payload.historyEntry);
    }
    if (!payload.self) {
      const reasonText = { rejected: "Call declined", cancelled: "Call cancelled", "no-answer": "Missed call", "peer-disconnected": "Call ended" }[payload.reason];
      if (reasonText) toast(reasonText);
    }
    teardownCall();
  });
}

// ===========================================================================
// GENERIC BACK BUTTONS + MENU NAVIGATION
// ===========================================================================
document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.getAttribute("data-back")));
});

$("menu-wallet").addEventListener("click", openWallet);
$("menu-treasure").addEventListener("click", openTreasure);
$("menu-frames").addEventListener("click", openFrames);
$("menu-agency").addEventListener("click", openAgency);
$("menu-coin-center").addEventListener("click", openCoinCenterPanel);
$("menu-host-center").addEventListener("click", openHostCenter);

// ===========================================================================
// WALLET
// ===========================================================================
async function openWallet() {
  const frame = $("wallet-ui-frame");
  if (frame) {
    const base = "/wallet-ui.html?userId=" + encodeURIComponent(me.userId || "");
    if (!frame.src || !frame.src.endsWith(base)) frame.src = base;
  }
  showView("view-wallet");
}

// ===========================================================================
// RECHARGE / PAYMENT -> COIN SYSTEM (2026-08-16)
// ---------------------------------------------------------------
// Manual UPI/PhonePe/Google Pay flow: pick a package -> pick a method (all
// three just point the user at the same Admin-configured UPI ID/QR — there
// is no payment gateway API integrated) -> pay outside the app -> submit
// the UTR -> wait for Admin verification. This screen NEVER shows a
// "payment successful" state on its own; the only state it can reach after
// submitting is "Pending Verification" (see PAYMENT_METHOD_ICONS below for
// what each method actually does).
// ===========================================================================
let rechargeConfig = null;
let rechargeSelected = { pkg: null, method: null, order: null, paymentData: null };

const PAYMENT_METHOD_ICONS = { upi: "🏦", phonepe: "📱", gpay: "🟢" };
const PAYMENT_METHOD_LABELS = { upi: "UPI", phonepe: "PhonePe", gpay: "Google Pay" };

async function openRechargeModal() {
  rechargeSelected = { pkg: null, method: null, order: null, paymentData: null };
  const r = await api("/api/wallet/recharge/config");
  if (!r.success) { toast(r.message || "Could not load recharge options"); return; }
  rechargeConfig = r;
  renderRechargePackages();
  showRechargeStep("package");
  $("recharge-modal").classList.remove("hidden");
}

function closeRechargeModal() {
  $("recharge-modal").classList.add("hidden");
}

function showRechargeStep(step) {
  ["package", "method", "pay", "pending"].forEach((s) => {
    $("recharge-step-" + s).classList.toggle("hidden", s !== step);
  });
  $("recharge-step-title").textContent =
    step === "package" ? "Select Package" :
    step === "method" ? "Select Payment Method" :
    step === "pay" ? "Complete Payment" : "Recharge";
}

function renderRechargePackages() {
  const grid = $("recharge-package-grid");
  grid.innerHTML = "";
  const packages = (rechargeConfig && rechargeConfig.packages) || [];
  $("recharge-package-empty").classList.toggle("hidden", packages.length > 0);
  if (!rechargeConfig.settings || !rechargeConfig.settings.enabled) {
    grid.innerHTML = `<p class="hint">Recharge is currently unavailable. Please try again later.</p>`;
    return;
  }
  packages.forEach((p) => {
    const card = document.createElement("div");
    card.className = "recharge-package-card";
    card.innerHTML = `
      <div class="price">₹${p.priceINR}</div>
      <div class="coins"><img src="/images/icons/icon-coin.png" class="currency-icon" alt="coin"> ${p.totalCoins.toLocaleString()}</div>
      ${p.bonusCoins ? `<div class="bonus">+${p.bonusCoins.toLocaleString()} bonus</div>` : ""}
      ${p.label ? `<div class="bonus" style="color:#5aa0ff;">${escapeHtml(p.label)}</div>` : ""}
    `;
    card.addEventListener("click", () => {
      // PHASE 5 FIX: no client-generated reference anymore — the server
      // order (created on method selection below) is the only reference.
      rechargeSelected.pkg = p;
      rechargeSelected.order = null;
      rechargeSelected.paymentData = null;
      grid.querySelectorAll(".recharge-package-card.selected").forEach((el) => el.classList.remove("selected"));
      card.classList.add("selected");
      renderRechargeMethods();
      $("recharge-selected-summary").textContent = `₹${p.priceINR} → ${p.totalCoins.toLocaleString()} Coins`;
      showRechargeStep("method");
    });
    grid.appendChild(card);
  });
}

function renderRechargeMethods() {
  const wrap = $("recharge-method-list");
  wrap.innerHTML = "";
  const methods = (rechargeConfig && rechargeConfig.settings && rechargeConfig.settings.methods) || {};
  ["upi", "phonepe", "gpay"].filter((m) => methods[m]).forEach((m) => {
    const card = document.createElement("div");
    card.className = "recharge-method-card";
    card.innerHTML = `<span class="method-icon">${PAYMENT_METHOD_ICONS[m]}</span><span>${PAYMENT_METHOD_LABELS[m]}</span>`;
    // PHASE 5 FIX (server-first order): tapping a method now creates the
    // PENDING order on the SERVER first, and only opens the UPI app once
    // that order (and its server-issued id/amount/reference) exists — the
    // deep link/QR the user actually pays against always come from that
    // authoritative order, never from anything built client-side. The
    // click is still the original user gesture (nothing awaited yet when
    // it fires), so the eventual window.location.href navigation inside
    // launchUpiApp() is still allowed to trigger the native app.
    card.addEventListener("click", () => startRechargeOrder(m));
    wrap.appendChild(card);
  });
}

// PHASE 5 FIX: replaces the old click handler that built a client-side
// ref + deep link synchronously. Now: create the order server-side ->
// fetch that order's server-computed payment data (deep link + dynamic QR,
// or null QR if 'qrcode' isn't installed server-side, in which case the
// admin's static QR image is used instead) -> render the pay step -> only
// then attempt to open the UPI app.
async function startRechargeOrder(method) {
  if (!rechargeSelected.pkg) { toast("Select a package first"); return; }
  rechargeSelected.method = method;
  const wrap = $("recharge-method-list");
  if (wrap) wrap.classList.add("loading");
  const orderRes = await api("/api/wallet/recharge/order/create", "POST", {
    packageId: rechargeSelected.pkg.id, method
  });
  if (wrap) wrap.classList.remove("loading");
  if (!orderRes.success) { toast(orderRes.message || "Could not start this recharge — try again"); return; }
  rechargeSelected.order = orderRes.transaction;

  const dataRes = await api(`/api/wallet/recharge/order/${orderRes.transaction.id}/payment-data`);
  // Payment data (deep link / dynamic QR) failing to load is NOT fatal —
  // the pay step still renders using the admin's static UPI ID/QR from
  // rechargeConfig.settings as a fallback; only the "open app"/dynamic-QR
  // convenience is lost, never the ability to pay and submit a UTR.
  rechargeSelected.paymentData = dataRes.success ? dataRes : null;

  showRechargePayStep();
  launchUpiApp();
}

function launchUpiApp() {
  const link = rechargeSelected.paymentData && rechargeSelected.paymentData.upiLink;
  if (!link) return; // no UPI ID configured, or payment-data fetch failed — pay step still shows the manual/static fallback
  // Programmatic navigation to a custom scheme silently no-ops on
  // platforms that don't understand it (iOS Safari, desktop) instead of
  // throwing, so this is safe to call unconditionally.
  window.location.href = link;
}

function showRechargePayStep() {
  const s = rechargeConfig.settings;
  const p = rechargeSelected.pkg;
  const pd = rechargeSelected.paymentData;
  $("recharge-pay-amount").textContent = `₹${p.priceINR}`;
  $("recharge-pay-upi").textContent = s.upiId ? "UPI ID: " + s.upiId : "";
  $("recharge-pay-name").textContent = s.receiverName ? "Receiver: " + s.receiverName : "";
  // PHASE 5 FIX: the only reference shown/quoted to the user is now the
  // server-issued order id (rechargeSelected.order.id) — never a
  // client-generated string.
  $("recharge-pay-ref").textContent = (rechargeSelected.order && rechargeSelected.order.id) || "";
  const qr = $("recharge-pay-qr");
  // PHASE 5 FIX (dynamic per-order QR, §14/§19): prefer the server-generated
  // QR that encodes THIS order's exact amount + reference; fall back to the
  // admin's static uploaded QR (which only encodes the bare UPI ID, no
  // amount) if dynamic generation wasn't available server-side.
  const dynamicQr = pd && pd.qrDataUrl;
  if (dynamicQr) { qr.src = dynamicQr; qr.classList.remove("hidden"); }
  else if (s.qrImageUrl) { qr.src = s.qrImageUrl; qr.classList.remove("hidden"); }
  else { qr.classList.add("hidden"); }
  $("recharge-pay-instructions").textContent = s.instructions || "Pay the exact amount, then enter the Transaction ID / UTR from your payment app below.";
  $("btn-recharge-open-app").classList.toggle("hidden", !(pd && pd.upiLink));
  $("recharge-utr-input").value = "";
  showRechargeStep("pay");
}

$("btn-recharge-open-app")?.addEventListener("click", launchUpiApp);

$("btn-open-recharge")?.addEventListener("click", openRechargeModal);
$("btn-recharge-close")?.addEventListener("click", closeRechargeModal);
$("btn-recharge-back-to-package")?.addEventListener("click", () => showRechargeStep("package"));
$("btn-recharge-back-to-method")?.addEventListener("click", () => showRechargeStep("method"));
$("btn-recharge-done")?.addEventListener("click", () => { closeRechargeModal(); openWallet(); });

$("btn-recharge-submit")?.addEventListener("click", async () => {
  const utr = $("recharge-utr-input").value.trim();
  if (!utr || utr.length < 4) { toast("Enter a valid Transaction ID / UTR"); return; }
  // PHASE 5 FIX: the order already exists server-side (created in
  // startRechargeOrder()) — submitting now only attaches the UTR to that
  // existing PENDING order and moves it to PAYMENT_SUBMITTED. It never
  // creates a new order and never credits coins.
  if (!rechargeSelected.order) { toast("Select a package and payment method first"); return; }
  const btn = $("btn-recharge-submit");
  btn.disabled = true;
  const r = await api(`/api/wallet/recharge/order/${rechargeSelected.order.id}/submit-utr`, "POST", { utr });
  btn.disabled = false;
  if (r.success) {
    showRechargeStep("pending");
  } else {
    toast(r.message || "Could not submit — try again");
  }
});

async function loadRechargeHistory() {
  const r = await api("/api/wallet/recharge/history");
  const wrap = $("recharge-history");
  wrap.innerHTML = "";
  const list = r.success ? r.history : [];
  $("recharge-history-empty").classList.toggle("hidden", list.length > 0);
  list.forEach((t) => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <div class="user-row-body">
        <span class="name">₹${t.priceINR} → <img src="/images/icons/icon-coin.png" class="currency-icon" alt="coin"> ${t.totalCoins.toLocaleString()} <span class="recharge-status-badge recharge-status-${t.status}">${t.status}</span></span>
        <span class="sub">${PAYMENT_METHOD_LABELS[t.method] || t.method} · ${t.utr ? "UTR " + escapeHtml(t.utr) : "Order " + escapeHtml(t.id)} · ${new Date(t.createdAt).toLocaleString()}</span>
      </div>
    `;
    wrap.appendChild(row);
  });
}

$("instant-exchange-amount")?.addEventListener("input", () => {
  const d = Math.max(0, Math.floor(Number($("instant-exchange-amount").value) || 0));
  $("instant-exchange-preview").textContent = Math.floor(d * 0.3).toLocaleString();
});

$("btn-instant-exchange")?.addEventListener("click", async () => {
  const diamonds = Number($("instant-exchange-amount").value);
  if (!diamonds || diamonds <= 0) { toast("Enter a valid Diamond amount"); return; }
  const r = await api("/api/wallet/exchange-instant", "POST", { userId: me.userId, diamonds });
  if (r.success) {
    toast(`💎 ${r.diamondsSpent} → 🪙 ${r.coinsReceived} completed`);
    $("instant-exchange-amount").value = "";
    $("instant-exchange-preview").textContent = "0";
    openWallet();
  } else toast(r.message || "Something went wrong");
});

async function loadCoinSellerList() {
  const r = await api("/api/wallet/coin-sellers");
  const wrap = $("coin-seller-list");
  wrap.innerHTML = "";
  const list = r.success ? r.sellers : [];
  $("coin-seller-empty").classList.toggle("hidden", list.length > 0);
  list.forEach((s) => {
    const row = document.createElement("div");
    row.className = "user-row";
    const statusClass = s.is_online ? "online" : "offline";
    const flag = s.country ? flagEmoji(s.country) : "";
    row.innerHTML = `
      <div class="social-item-icon" style="width:40px;height:40px;">${s.avatar ? `<img src="${escapeHtml(s.avatar)}" alt="">` : `<img src="${placeholderAvatar(s.display_name)}" alt="">`}<span class="status-dot ${statusClass}"></span></div>
      <div class="user-row-body">
        <span class="name">${flag ? flag + " " : ""}${escapeHtml(s.display_name)}</span>
        <span class="sub">ID: ${escapeHtml(s.user_id)} · Past 30 days' order: ${s.order_count_last_30_days}</span>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-ghost btn-sm coin-seller-chat">Chat</button>
        ${s.whatsapp_number ? `<button class="btn btn-primary btn-sm coin-seller-whatsapp">WhatsApp</button>` : ""}
      </div>
    `;
    row.querySelector(".coin-seller-chat").addEventListener("click", () => openThread(s.user_id, s.display_name));
    const waBtn = row.querySelector(".coin-seller-whatsapp");
    if (waBtn) waBtn.addEventListener("click", () => {
      const digits = s.whatsapp_number.replace(/[^0-9]/g, "");
      window.open(`https://wa.me/${digits}`, "_blank");
    });
    wrap.appendChild(row);
  });
}

// ===========================================================================
// TREASURE BOX
// ===========================================================================
async function openTreasure() {
  const r = await api("/api/treasure/status/" + me.userId);
  $("btn-claim-daily").disabled = !(r.success && r.dailyReady);
  $("btn-claim-weekly").disabled = !(r.success && r.weeklyReady);
  $("btn-claim-daily").textContent = (r.success && r.dailyReady) ? "Open" : "Already claimed today's";
  $("btn-claim-weekly").textContent = (r.success && r.weeklyReady) ? "Open" : "Already claimed this week's";
  showView("view-treasure");
}
$("btn-claim-daily").addEventListener("click", async () => {
  const r = await api("/api/treasure/claim-daily", "POST", {});
  if (r.success) { toast(`🎁 You got ${r.reward} coins!`); me.coins = r.coins; saveSession(); fillHomeProfile(); openTreasure(); }
  else toast(r.message || "Something went wrong");
});
$("btn-claim-weekly").addEventListener("click", async () => {
  const r = await api("/api/treasure/claim-weekly", "POST", {});
  if (r.success) { toast(`🏆 You got ${r.reward} coins!`); me.coins = r.coins; saveSession(); fillHomeProfile(); openTreasure(); }
  else toast(r.message || "Something went wrong");
});

// ===========================================================================
// FRAMES
// ===========================================================================
async function openFrames() {
  const r = await api("/api/frames/mine/" + me.userId);
  const activeBox = $("active-frame-box");
  if (r.success && r.activeFrame) {
    me.activeFrame = r.activeFrame; saveSession();
    activeBox.innerHTML = `<p class="field-label">Your Active Frame</p><p>${escapeHtml(r.activeFrame.name || r.activeFrame.frameId)}</p><p class="hint">${r.activeFrame.expiresAt ? "Expires: " + new Date(r.activeFrame.expiresAt).toLocaleDateString() : "Permanent"}</p>`;
  } else {
    if (me.activeFrame) { me.activeFrame = null; saveSession(); }
    activeBox.innerHTML = `<p class="hint">You have no active frame.</p>`;
  }

  // Only frames Admin has actually assigned to THIS account — never the
  // full catalog — same "My Vehicles" inventory pattern as openVehicles().
  const wrap = $("frame-catalog-list");
  wrap.innerHTML = "";
  if (!r.success || !r.inventory || !r.inventory.length) {
    wrap.innerHTML = `<p class="hint">No Frames assigned yet.</p>`;
  } else {
    r.inventory.forEach((f) => {
      const item = document.createElement("div");
      item.className = "gift-item";
      const status = f.permanent ? "Permanent" : (f.expiresAt ? "Expires " + new Date(f.expiresAt).toLocaleDateString() : "");
      item.innerHTML = `
        ${f.imageUrl ? `<img src="${f.imageUrl}" style="width:56px;height:56px;object-fit:cover;border-radius:10px;">` : '<span class="emoji">🖼️</span>'}
        <span class="price">${escapeHtml(f.name)}</span>
        <span class="hint">${status}${f.active ? " · Active" : ""}</span>
        <div style="display:flex;gap:6px;margin-top:6px;">
          ${f.active
            ? `<button class="btn btn-ghost btn-frame-remove" data-id="${f.id}" style="flex:1;">Remove</button>`
            : `<button class="btn btn-primary btn-frame-use" data-id="${f.id}" style="flex:1;">Use</button>`}
        </div>
      `;
      wrap.appendChild(item);
    });
  }

  showView("view-frames");
}

$("frame-catalog-list").addEventListener("click", async (e) => {
  const useBtn = e.target.closest(".btn-frame-use");
  if (useBtn) {
    const r = await api("/api/frames/use", "POST", { frameId: useBtn.dataset.id });
    if (r.success) openFrames(); else toast(r.message || "Failed", true);
    return;
  }
  const removeBtn = e.target.closest(".btn-frame-remove");
  if (removeBtn) {
    const r = await api("/api/frames/deactivate", "POST", {});
    if (r.success) openFrames(); else toast(r.message || "Failed", true);
  }
});

// ===========================================================================
// VEHICLE ENTRY SYSTEM (Add-on) — My Vehicles / Customize
// ===========================================================================
async function openVehicles() {
  const r = await api("/api/vehicles/mine/" + me.userId);
  const wrap = $("vehicle-list");
  const empty = $("vehicle-list-empty");
  wrap.innerHTML = "";
  if (!r.success || !r.inventory.length) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
    r.inventory.forEach((v) => {
      const item = document.createElement("div");
      item.className = "gift-item";
      const status = v.permanent ? "Permanent" : (v.expiresAt ? "Expires " + new Date(v.expiresAt).toLocaleDateString() : "");
      item.innerHTML = `
        ${v.thumbnailUrl ? `<img src="${v.thumbnailUrl}" style="width:56px;height:56px;object-fit:cover;border-radius:10px;">` : "<span class=\"emoji\">🚗</span>"}
        <span class="price">${escapeHtml(v.name)}</span>
        <span class="hint">${status}${v.active ? " · Active" : ""}</span>
        <div style="display:flex;gap:6px;margin-top:6px;">
          ${v.active
            ? `<button class="btn btn-ghost btn-vehicle-remove" data-id="${v.id}" style="flex:1;">Remove</button>`
            : `<button class="btn btn-primary btn-vehicle-use" data-id="${v.id}" style="flex:1;">Use</button>`}
        </div>
      `;
      wrap.appendChild(item);
    });
  }
  showView("view-vehicles");
}

$("vehicle-list").addEventListener("click", async (e) => {
  const useBtn = e.target.closest(".btn-vehicle-use");
  if (useBtn) {
    const r = await api("/api/vehicles/use", "POST", { vehicleId: useBtn.dataset.id });
    if (r.success) openVehicles(); else toast(r.message || "Failed", true);
    return;
  }
  const removeBtn = e.target.closest(".btn-vehicle-remove");
  if (removeBtn) {
    const r = await api("/api/vehicles/deactivate", "POST", {});
    if (r.success) openVehicles(); else toast(r.message || "Failed", true);
  }
});

$("btn-shop-vehicles").addEventListener("click", () => openVehicles());

// ===========================================================================
// AGENCY CENTER
// ===========================================================================
let currentAgencyId = null;
async function openAgency() {
  const r = await api("/api/agency/mine/" + me.userId);
  const body = $("agency-body");
  if (!r.success || !r.agency) {
    currentAgencyId = null;
    body.innerHTML = `<div class="empty-state"><p>You don't have an Agency.</p></div>`;
    showView("view-agency");
    return;
  }
  currentAgencyId = r.agency.agencyId;
  if (!r.agency.isOwner) {
    // Host viewing their own agency membership — full stats live in Host Center.
    body.innerHTML = `
      <div class="auth-card">
        <h3>${escapeHtml(r.agency.name)}</h3>
        <p class="hint">Commission rate: ${(r.agency.commissionRate * 100).toFixed(0)}%</p>
        <p class="hint">You'll see full gift stats in your Host Center.</p>
      </div>`;
    showView("view-agency");
    return;
  }
  await renderAgencyDashboard();
  showView("view-agency");
}
async function renderAgencyDashboard() {
  if (!currentAgencyId) return;
  const r = await api(`/api/agency/dashboard/${currentAgencyId}?ownerUserId=${me.userId}`);
  const body = $("agency-body");
  if (!r.success) { body.innerHTML = `<div class="empty-state"><p>${escapeHtml(r.message || "Could not load")}</p></div>`; return; }
  const a = r.agency, t = r.totals;
  let html = `
    <div class="auth-card">
      <div style="display:flex;align-items:center;gap:10px;">
        <div id="agency-logo-click" style="cursor:pointer;">${a.logo ? `<img src="${escapeHtml(a.logo)}" class="invite-card-logo" alt="">` : `<div class="invite-card-logo placeholder">🏢</div>`}</div>
        <div>
          <h3>${escapeHtml(a.name)}</h3>
          <p class="hint">ID: ${escapeHtml(a.agencyId)} · Commission: ${(a.commissionRate * 100).toFixed(0)}%</p>
        </div>
      </div>
      <input type="file" id="agency-logo-input" class="hidden" accept="image/*">
    </div>
    <div class="stat-grid">
      <div class="stat-box"><span class="stat-label">Total Hosts</span><span class="stat-value">${t.totalHosts}</span></div>
      <div class="stat-box"><span class="stat-label">Active Hosts</span><span class="stat-value">${t.activeHosts}</span></div>
      <div class="stat-box"><span class="stat-label">Daily Gifts</span><span class="stat-value">${t.dailyGifts}</span></div>
      <div class="stat-box"><span class="stat-label">Weekly Gifts</span><span class="stat-value">${t.weeklyGifts}</span></div>
      <div class="stat-box"><span class="stat-label">Monthly Gifts</span><span class="stat-value">${t.monthlyGifts}</span></div>
      <div class="stat-box"><span class="stat-label">Total Diamonds</span><span class="stat-value"><img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> ${t.totalDiamonds}</span></div>
    </div>
    <div class="section-head"><h2>Invite a Host</h2></div>
    <div class="field-row">
      <input id="agency-invite-input" type="text" class="field-solo" placeholder="Enter User ID">
      <button id="btn-agency-invite-send" class="btn btn-ghost">Invite</button>
    </div>
    <div class="section-head"><h2>Hosts</h2></div>
    <div class="user-list">`;
  if (!r.hosts.length) {
    html += `<div class="empty-state"><p>No Hosts yet. Invite one above using their User ID.</p></div>`;
  } else {
    r.hosts.forEach((h) => {
      html += `
        <div class="user-row">
          <div class="social-item-icon" style="width:40px;height:40px;">${h.photo ? `<img src="${escapeHtml(h.photo)}" alt="">` : "👤"}<span class="status-dot ${h.online ? "online" : "offline"}"></span></div>
          <div class="user-row-body">
            <span class="name">${escapeHtml(h.name)}</span>
            <span class="sub">ID: ${escapeHtml(h.userId)} · Today: ${h.dailyGifts} gifts / <img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond">${h.dailyDiamonds} · Total: <img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond">${h.totalDiamonds}</span>
          </div>
        </div>`;
    });
  }
  html += `</div>`;
  body.innerHTML = html;
  $("btn-agency-invite-send").addEventListener("click", sendAgencyInvite);
  $("agency-logo-click").addEventListener("click", () => $("agency-logo-input").click());
  $("agency-logo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("logo", file);
    const up = await apiUpload("/api/room/logo/upload", fd);
    if (!up.success) { toast(up.message || "Upload failed"); return; }
    const r = await api("/api/agency/logo", "POST", { agencyId: currentAgencyId, ownerUserId: me.userId, logoUrl: up.url });
    if (r.success) { toast("Logo updated"); renderAgencyDashboard(); }
    else toast(r.message || "Update failed");
  });
}
async function sendAgencyInvite() {
  const input = $("agency-invite-input");
  const toUserId = input.value.trim();
  if (!toUserId) return;
  const r = await api("/api/agency/invite", "POST", { agencyId: currentAgencyId, fromUserId: me.userId, toUserId });
  if (r.success) { toast("Invitation sent"); input.value = ""; }
  else toast(r.message || "Could not send");
}

// ===========================================================================
// HOST CENTER
// ===========================================================================
let hostCenterPeriod = "all";
async function openHostCenter() {
  await Promise.all([loadHostStats(), loadHostGifts()]);
  showView("view-host-center");
}
async function loadHostStats() {
  const r = await api("/api/host-center/" + me.userId);
  if (!r.success) return;
  applyHostStats(r.stats);
}
function applyHostStats(s) {
  $("hc-daily-gifts").textContent = s.dailyGifts;
  $("hc-weekly-gifts").textContent = s.weeklyGifts;
  $("hc-monthly-gifts").textContent = s.monthlyGifts;
  $("hc-total-gifts").textContent = s.totalGifts;
  $("hc-total-diamonds").textContent = s.totalDiamonds;
  $("hc-coin-value").textContent = s.estimatedCoinValue;
}
async function loadHostGifts() {
  const r = await api(`/api/host-center/${me.userId}/gifts?period=${hostCenterPeriod}&limit=50`);
  const wrap = $("hc-gift-list");
  wrap.innerHTML = "";
  if (!r.success || !r.gifts.length) {
    $("hc-gift-empty").classList.remove("hidden");
    return;
  }
  $("hc-gift-empty").classList.add("hidden");
  r.gifts.forEach((g) => wrap.appendChild(hostGiftRow(g)));
}
function hostGiftRow(g) {
  const row = document.createElement("div");
  row.className = "user-row";
  row.innerHTML = `
    <div class="social-item-icon" style="width:40px;height:40px;">${g.senderAvatar ? `<img src="${escapeHtml(g.senderAvatar)}" alt="">` : "👤"}</div>
    <div class="user-row-body">
      <span class="name">${escapeHtml(g.senderName)} <span class="hint">(${escapeHtml(g.senderUserId)})</span></span>
      <span class="sub">🎁 ${escapeHtml(g.giftName)} · <img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> ${g.diamondAmount} · Room #${escapeHtml(String(g.roomNumber))} · ${formatVisitTime(g.time)}</span>
    </div>`;
  return row;
}
$("hc-period-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".social-tab");
  if (!btn) return;
  $("hc-period-tabs").querySelectorAll(".social-tab").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  hostCenterPeriod = btn.dataset.period;
  loadHostGifts();
});
// Live push from server whenever a new gift lands in this host's own room
// (see agencyHost.js registerGiftRecordedHook) — keeps Host Center in sync
// with Agency Center without either side polling or duplicating data.
function handleHostStatsUpdate(stats) {
  if (!$("view-host-center").classList.contains("active")) return;
  applyHostStats(stats);
}
function handleHostGiftReceived(gift) {
  if (!$("view-host-center").classList.contains("active")) return;
  if (hostCenterPeriod === "all" || hostCenterPeriod === "daily") {
    $("hc-gift-empty").classList.add("hidden");
    $("hc-gift-list").prepend(hostGiftRow(gift));
  }
}

// ===========================================================================
// COIN CENTER (Agency-style operator panel — only visible if Admin has
// designated this exact User ID as a Coin Center; see checkCoinCenterMenu)
// ===========================================================================
let ccOpSelectedUser = null;

async function openCoinCenterPanel() {
  const r = await api("/api/coin-center/mine/" + me.userId);
  if (!r.success || !r.account) {
    toast("Your Coin Center Account was not found");
    return;
  }
  $("cc-my-balance").textContent = r.account.balance.toLocaleString();
  ccOpSelectedUser = null;
  $("cc-op-user-card").classList.add("hidden");
  $("cc-op-search").value = "";
  $("cc-op-amount").value = "";
  $("cc-op-reason").value = "";
  $("btn-cc-op-send").disabled = true;
  await loadCoinCenterOpLog();
  showView("view-coin-center");
}

async function loadCoinCenterOpLog() {
  const wrap = $("cc-op-log");
  wrap.innerHTML = "";
  const r = await api("/api/coin-center/log/" + me.userId);
  if (!r.success || !r.log.length) {
    wrap.innerHTML = `<p class="hint">No transactions yet.</p>`;
    return;
  }
  r.log.forEach((entry) => {
    if (entry.type !== "send") return; // top-ups aren't shown here, only sends
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `<div class="user-row-body"><span class="name">${escapeHtml(entry.targetName || entry.targetUserId)}</span><span class="sub"><img src="/images/icons/icon-coin.png" class="currency-icon" alt="coin"> ${entry.amount} · ${escapeHtml(entry.reason || "No note")} · ${new Date(entry.time).toLocaleString()}</span></div>`;
    wrap.appendChild(row);
  });
}

$("btn-cc-op-search").addEventListener("click", async () => {
  const userId = $("cc-op-search").value.trim();
  if (!userId) { toast("Enter User ID"); return; }
  const r = await api("/api/user/by-id/" + userId);
  const card = $("cc-op-user-card");
  if (!r.success) {
    ccOpSelectedUser = null;
    card.classList.remove("hidden");
    card.innerHTML = `<p class="hint">${escapeHtml(r.message || "User not found")}</p>`;
    $("btn-cc-op-send").disabled = true;
    return;
  }
  ccOpSelectedUser = r.user;
  card.classList.remove("hidden");
  card.innerHTML = `<p class="field-label">${escapeHtml(r.user.name)}</p><p class="hint">ID: ${escapeHtml(r.user.userId)} · Current coins: ${r.user.coins}</p>`;
  $("btn-cc-op-send").disabled = false;
});

$("btn-cc-op-send").addEventListener("click", async () => {
  if (!ccOpSelectedUser) { toast("Find a User first"); return; }
  const amount = Number($("cc-op-amount").value);
  const reason = $("cc-op-reason").value.trim();
  if (!Number.isInteger(amount) || amount <= 0) { toast("Enter a valid (whole number) coin amount"); return; }

  const requestId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const btn = $("btn-cc-op-send");
  btn.disabled = true;
  try {
    const r = await api("/api/coin-center/send", "POST", {
      operatorUserId: me.userId, targetUserId: ccOpSelectedUser.userId, amount, reason, requestId
    });
    if (r.success) {
      toast(`${amount} coins sent`);
      $("cc-my-balance").textContent = r.balance.toLocaleString();
      $("cc-op-amount").value = "";
      $("cc-op-reason").value = "";
      loadCoinCenterOpLog();
    } else {
      toast(r.message || "Failed to send");
    }
  } finally {
    btn.disabled = false;
  }
});

// ===========================================================================
// ROOM "MORE" MENU — bottom sheet holding Music / TV / Playlist / Game /
// Shop now that they're no longer always-on icons in the room toolbar. Pure
// show/hide of the existing panel; every button inside still fires the
// exact same click handler it always did (see closeAllPanels/EXCLUSIVE_PANEL_IDS
// above for how opening one of them also closes this sheet automatically).
// ===========================================================================
$("btn-room-more").addEventListener("click", () => {
  closeAllPanels("room-more-menu");
  $("room-more-menu").classList.remove("hidden");
});
$("btn-room-more-close").addEventListener("click", () => {
  $("room-more-menu").classList.add("hidden");
});
$("room-more-menu").addEventListener("click", (e) => {
  if (e.target.id === "room-more-menu") $("room-more-menu").classList.add("hidden");
});
// btn-toggle-yt doesn't open a panel of its own (it just flips YouTube mode
// on/off for the room), so it wouldn't otherwise close this sheet the way
// the other More items do — this just tucks the sheet away after the tap,
// without touching the actual toggle logic above.
$("btn-toggle-yt").addEventListener("click", () => $("room-more-menu").classList.add("hidden"));

$("btn-open-shop").addEventListener("click", () => {
  $("room-more-menu").classList.add("hidden");
  showView("view-shop");
});
$("btn-shop-frames").addEventListener("click", () => openFrames());

// ===========================================================================
// ROOM TV SCREEN — Food Wheel / Teen Patti, opened on demand as a bottom-
// sheet overlay (see the room-tv-screen CSS fix note for why it's no longer
// a permanently-visible in-flow block).
// ===========================================================================
const ROOM_TV_GAMES = {
  foodwheel: "/foodwheel/index.html",
  teenpatti: "/teenpatti/index.html"
};
let roomTvActiveGame = "foodwheel";
let roomTvSyncTimer = null;

// Real winner feed cache (see socket.on("real-win", ...) above) — kept here
// so it survives between game opens without re-fetching every time.
let recentWins = [];
let recentWinsLoaded = false;
function sendRealWinsToGame() {
  const frame = $("room-tv-frame");
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage({ type: "REAL_WINS", wins: recentWins }, "*");
  }
}
async function ensureRecentWinsLoaded() {
  if (recentWinsLoaded) return;
  recentWinsLoaded = true;
  try {
    const r = await api("/api/games/recent-wins");
    if (r.success && Array.isArray(r.wins)) recentWins = r.wins;
  } catch (e) {}
}

function setRoomTvGame(key) {
  if (!ROOM_TV_GAMES[key]) return;
  roomTvActiveGame = key;
  $("room-tv-frame").src = ROOM_TV_GAMES[key];
  document.querySelectorAll(".room-tv-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.game === key);
  });
}

document.querySelectorAll(".room-tv-tab").forEach((tab) => {
  tab.addEventListener("click", () => setRoomTvGame(tab.dataset.game));
});

// Local only — opening/closing the game affects just the person who tapped
// the button, not the rest of the room.
$("btn-toggle-game").addEventListener("click", () => openRoomGame());
$("btn-room-tv-close").addEventListener("click", () => closeRoomGame());

let roomMusicWasPlayingBeforeGame = false;

function openRoomGame(game, fromRemote) {
  closeAllPanels("room-tv-screen");
  document.body.classList.add("game-locked");
  $("room-tv-screen").classList.add("tv-open");
  // Fix (sluggish app / stuck UI after playing): always load a fresh
  // instance of the game on open rather than trusting a stale `.src` check.
  // Combined with the teardown in closeRoomGame() below, this guarantees
  // the game is never silently running in the background when the panel
  // is closed.
  setRoomTvGame(game || roomTvActiveGame);

  // Fix (audio bug): the room's background music used to keep playing
  // underneath the game. Pause it locally while the game is open (each
  // user's own playback only — this doesn't touch the shared music state
  // for others) and remember whether it was playing so we can resume it
  // on close instead of guessing.
  const musicEl = $("room-audio");
  if (musicEl) {
    roomMusicWasPlayingBeforeGame = !musicEl.paused;
    musicEl.pause();
  }

  if (!fromRemote && currentRoomId) {
    socket.emit("game-toggle", { roomId: currentRoomId, open: true, game: game || roomTvActiveGame });
  }
}
function closeRoomGame(fromRemote) {
  document.body.classList.remove("game-locked");
  $("room-tv-screen").classList.remove("tv-open");

  // Fix (app feels stuck / leave-room unresponsive after playing): the
  // game iframe used to keep running forever in the background even once
  // "closed" here (only visually hidden via CSS), so all its timers —
  // Teen Patti's bot betting/dealing loops, Food Wheel's spin simulation —
  // kept firing and competing for the main thread the whole time you stayed
  // in the room, which is what made the rest of the UI (leave button, room
  // settings, chat) feel sluggish or unresponsive. Unloading the iframe
  // fully stops all of that; setRoomTvGame() loads a fresh instance again
  // next time the panel is opened.
  $("room-tv-frame").src = "about:blank";
  if (currentRoomId) socket.emit("fruitwheel-leave", { roomId: currentRoomId });

  const musicEl = $("room-audio");
  if (musicEl && roomMusicWasPlayingBeforeGame) {
    musicEl.play().catch(() => {});
  }
  roomMusicWasPlayingBeforeGame = false;

  if (!fromRemote && currentRoomId) {
    socket.emit("game-toggle", { roomId: currentRoomId, open: false });
  }
}

// Bridge messages coming from whichever game iframe is currently loaded on the TV screen
window.addEventListener("message", async (ev) => {
  const data = ev && ev.data;
  if (!data) return;
  // SECURITY FIX (Fruit Wheel audit, item #3, 2026-08-02): this listener
  // previously trusted any postMessage delivered to the window, regardless
  // of sender. The real fund-moving action (fruitwheel-bet/game-wheel-sync)
  // is always re-validated server-side against the user's real balance, so
  // this was never an actual coin-theft path — but a forged FOODWHEEL_BET
  // message from any other embedded/compromised script could still trigger
  // an unwanted real bet on the user's own money without them tapping
  // anything. Restricting to messages whose source is exactly the game
  // iframe's own contentWindow closes that gap with no behavior change for
  // the real game, which is the only legitimate sender.
  const gameFrame = $("room-tv-frame");
  if (!gameFrame || ev.source !== gameFrame.contentWindow) return;

  if (data.type === "FOODWHEEL_CLOSE") {
    // The in-game ✕ button now behaves exactly like the overlay's own close button.
    closeRoomGame();
  }

  if (data.type === "FOODWHEEL_READY") {
    // Hand the player's real wallet balance to the game on load — fetch it
    // fresh from the server (the single source of truth for coins) rather
    // than trusting the local cache, so the game never starts from a
    // slightly-stale number.
    const w = await api("/api/wallet/" + me.userId);
    if (w.success) { me.coins = w.coins; saveSession(); fillHomeProfile(); }
    $("room-tv-frame").contentWindow.postMessage({ type: "FOODWHEEL_INIT", balance: me.coins || 0 }, "*");
    await ensureRecentWinsLoaded();
    sendRealWinsToGame();
    // Fruit Wheel's round/result/payout all live on the server now — join
    // that room's round so this tab starts receiving real broadcasts.
    if (currentRoomId) socket.emit("fruitwheel-join", { roomId: currentRoomId });
    socket.emit("fruitwheel-leaderboard-request");
  }

  if (data.type === "FOODWHEEL_BET") {
    // The bet itself is sent to the server for validation and real-money
    // deduction; the game only plays the tap animation locally. The server
    // pushes back a wallet-update (handled above) with the true balance.
    if (currentRoomId) {
      socket.emit("fruitwheel-bet", { roomId: currentRoomId, foodId: data.foodId, amount: data.amount });
    }
  }

  if (data.type === "FOODWHEEL_BALANCE") {
    // The game reports its locally-displayed balance here purely so the
    // rest of the UI (home screen, other open tabs) can reflect it right
    // away. It is never trusted as-is: the server's own wallet-update,
    // driven only by real bets/payouts it resolved itself, always arrives
    // right after and overwrites this with the authoritative number.
    me.coins = Math.max(0, Math.floor(data.balance));
    saveSession(); fillHomeProfile();
  }

  if (data.type === "TEENPATTI_READY") {
    // Same bridge as Food Wheel: fetch the true current balance from the
    // server before handing it to Teen Patti on load.
    const w = await api("/api/wallet/" + me.userId);
    if (w.success) { me.coins = w.coins; saveSession(); fillHomeProfile(); }
    $("room-tv-frame").contentWindow.postMessage({ type: "TEENPATTI_INIT", balance: me.coins || 0 }, "*");
    await ensureRecentWinsLoaded();
    sendRealWinsToGame();
  }

  if (data.type === "TEENPATTI_BALANCE") {
    // Table wallet changed (bet placed or win) — same immediate local
    // update + fast real-time sync as Food Wheel.
    me.coins = Math.max(0, Math.floor(data.balance));
    saveSession(); fillHomeProfile();
    if (roomTvSyncTimer) clearTimeout(roomTvSyncTimer);
    roomTvSyncTimer = setTimeout(() => {
      socket.emit("game-wheel-sync", { roomId: currentRoomId, balance: Math.max(0, Math.floor(data.balance)), game: "Teen Patti" });
    }, 20);
  }

  if (data.type === "FOODWHEEL_BUY_COINS") {
    // The in-game "+" button opens the real wallet instead of granting free coins
    openWallet();
  }
});

// ===========================================================================
// TREASURE CHEST
// ===========================================================================
let chestConfigCache = null;
let chestCountdownTimer = null;
let chestResetAtMs = null;

async function loadChestConfig() {
  if (chestConfigCache) return chestConfigCache;
  const r = await api("/api/chest/config");
  if (r.success) chestConfigCache = r.levels;
  return chestConfigCache;
}

async function renderChest(chest) {
  await loadChestConfig();
  const idx = Math.min(chest.level - 1, (chestConfigCache || []).length - 1);
  const cfg = chestConfigCache && chestConfigCache[idx];
  const target = cfg ? cfg.target : chest.contributed || 1;
  const finished = chest.level > (chestConfigCache || []).length;

  $("chest-level").textContent = finished ? (chestConfigCache || []).length : chest.level;
  $("chest-contributed").textContent = Math.min(chest.contributed, target);
  $("chest-target").textContent = finished ? chest.contributed : target;
  const pct = finished ? 100 : Math.min(100, (chest.contributed / target) * 100);
  $("chest-progress-fill").style.width = pct + "%";

  chestResetAtMs = new Date(chest.resetAt).getTime();
  startChestCountdown();
}

function startChestCountdown() {
  clearInterval(chestCountdownTimer);
  chestCountdownTimer = setInterval(() => {
    if (!chestResetAtMs) return;
    const diff = Math.max(0, chestResetAtMs - Date.now());
    const h = String(Math.floor(diff / 3600000)).padStart(2, "0");
    const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, "0");
    $("chest-countdown").textContent = `${h}:${m}:${s}`;
  }, 1000);
}
function stopChestCountdown() { clearInterval(chestCountdownTimer); }

// ===========================================================================
// ROOM RANKING — Daily / Weekly / Monthly gifter leaderboard for the room.
// Data is fetched on open and then kept live by "room-ranking-update"
// broadcasts the server sends alongside every gift in this room.
// ===========================================================================
let rankingPeriod = "daily";
let rankingCache = { daily: [], weekly: [], monthly: [] };

// Short relative-time label for the optional "last gift" line (e.g. "2m
// ago", "3h ago"). Local to the ranking popup only — doesn't touch any
// other time-formatting logic elsewhere in the app.
function formatRankingLastGiftTime(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!isFinite(diffMs) || diffMs < 0) return "";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// FIX (Room Ranking popup, 2026-07-29): renders every row the server sends
// — no client-side Top-N trimming — since the popup is now a full-screen,
// fully scrollable list. Also surfaces User ID and an optional "last gift"
// time, and batches DOM insertion through a fragment instead of repeated
// appendChild calls (fewer reflows for rooms with large gifter counts).
function renderRanking() {
  const wrap = $("ranking-list");
  const list = rankingCache[rankingPeriod] || [];
  wrap.innerHTML = "";
  $("ranking-empty").classList.toggle("hidden", list.length > 0);
  const fragment = document.createDocumentFragment();
  list.forEach((row) => {
    const rankClass = row.rank === 1 ? "rank-top1" : row.rank === 2 ? "rank-top2" : row.rank === 3 ? "rank-top3" : "";
    const lastGift = formatRankingLastGiftTime(row.lastGiftTime);
    const item = document.createElement("div");
    item.className = "user-row";
    item.innerHTML = `
      <div class="rank-badge ${rankClass}">${row.rank}</div>
      <img class="avatar avatar-sm" src="${escapeHtml(row.photo || placeholderAvatar(row.name))}" alt="">
      <div class="user-row-body">
        <span class="name">${escapeHtml(row.name)}</span>
        <span class="sub">ID: ${escapeHtml(row.userId)} · 🎁 ${row.giftCount}${lastGift ? " · " + escapeHtml(lastGift) : ""}</span>
      </div>
      <div class="ranking-diamonds"><img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> ${row.totalDiamonds.toLocaleString()}</div>
    `;
    fragment.appendChild(item);
  });
  wrap.appendChild(fragment);
}

$("btn-room-ranking").addEventListener("click", () => {
  if (!currentRoomId) return;
  closeAllPanels("modal-room-ranking");
  $("modal-room-ranking").classList.remove("hidden");
  renderRanking();
  socket.emit("get-room-ranking", { roomId: currentRoomId });
});
$("btn-ranking-x-close").addEventListener("click", () => $("modal-room-ranking").classList.add("hidden"));
$("ranking-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".social-tab");
  if (!btn) return;
  $("ranking-tabs").querySelectorAll(".social-tab").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  rankingPeriod = btn.dataset.period;
  renderRanking();
});

// ===========================================================================
// GIFT BOX / LEVEL INFORMATION — read-only view of the Level System.
// Level itself only ever changes server-side, and only from a successful
// room gift send (see idLevel.js) — this popup just displays whatever the
// server last told it via "level-info-data" (on open) or "id-level-up"
// (pushed live the instant a send actually crosses a threshold, from
// anywhere in the app, not just while this popup is open).
// ===========================================================================
let levelInfoCache = null;

function renderLevelInfo() {
  const info = levelInfoCache;
  if (!info) return;
  $("level-info-badge").textContent = info.currentLevel;
  $("level-info-current-level").textContent = `Level ${info.currentLevel}`;
  $("level-info-lifetime").textContent = info.lifetimeGiftSent.toLocaleString();
  $("level-info-max").classList.toggle("hidden", !info.isMaxLevel);
  $("level-info-next-wrap").classList.toggle("hidden", info.isMaxLevel);
  if (!info.isMaxLevel) {
    $("level-info-next-level").textContent = `Level ${info.nextLevel}`;
    $("level-info-progress-fill").style.width = info.progressPercent + "%";
    $("level-info-remaining").textContent = `Need ${info.giftNeededForNextLevel.toLocaleString()} more gift value to reach the next level.`;
  }
  // UPGRADE (2026-08-04, Level Management): apply the current group's
  // theme — badge PNG, gradient background, text color, glow — to the
  // badge circle, and show a small "next badge" preview when the next
  // level lands in a different (admin-themed) group.
  $("level-info-group-label").textContent = `Level Group ${info.groupLabel}`;
  applyLevelTheme($("level-info-badge-wrap"), info.theme);
  const badgeImg = $("level-info-badge-img");
  if (info.theme && info.theme.badgeUrl) {
    badgeImg.src = info.theme.badgeUrl;
    badgeImg.classList.remove("hidden");
  } else {
    badgeImg.classList.add("hidden");
  }
  const nextWrap = $("level-info-next-badge-wrap");
  if (!info.isMaxLevel && info.nextTheme) {
    nextWrap.classList.remove("hidden");
    $("level-info-next-group-label").textContent = info.nextGroupLabel;
    const nextImg = $("level-info-next-badge-img");
    if (info.nextTheme.badgeUrl) { nextImg.src = info.nextTheme.badgeUrl; nextImg.classList.remove("hidden"); }
    else nextImg.classList.add("hidden");
  } else {
    nextWrap.classList.add("hidden");
  }
}

// UPGRADE (2026-08-04, Level Management): shared helper — paints a level
// badge element (background gradient, text color, optional glow) from a
// theme object returned by the server (idLevel.js's getTheme()/
// getLevelInfo()). Used by the Level Information modal above and by the
// live "level-theme-update" broadcast handler below. Never throws if
// theme/el is missing (badges render fine with the CSS default look).
function applyLevelTheme(el, theme) {
  if (!el) return;
  if (!theme) { el.style.background = ""; el.style.boxShadow = ""; el.style.color = ""; return; }
  el.style.background = `linear-gradient(135deg, ${theme.gradientFrom || "#8a8f98"}, ${theme.gradientTo || "#5c6068"})`;
  el.style.color = theme.textColor || "#fff";
  el.style.boxShadow = theme.glowEnabled ? `0 0 14px ${theme.glowColor || theme.gradientFrom || "#fff"}` : "";
}

// UPGRADE (2026-08-04, Level Management) — GLOBAL THEME UPDATE: when an
// admin saves a new theme for a level group, every online user currently
// in that group should see it immediately, with no reload. The actual
// socket.on("level-theme-update", ...) listener lives inside
// connectSocket() (see the ROOT-CAUSE FIX comment there for why it must
// NOT be a bare top-level statement) — this comment is just a pointer so
// the logic isn't a mystery when read from here.

$("btn-level-info").addEventListener("click", () => {
  closeAllPanels("modal-level-info");
  $("modal-level-info").classList.remove("hidden");
  if (levelInfoCache) renderLevelInfo();
  socket.emit("get-level-info");
});
$("btn-level-info-x-close").addEventListener("click", () => $("modal-level-info").classList.add("hidden"));
// (level-info-data / id-level-up socket listeners moved into connectSocket() —
// see the ROOT-CAUSE FIX comment there. Registering them here, at top level,
// was the actual cause of the session-restore and settings-icon bugs.)

$("btn-chest-info").addEventListener("click", async () => {
  closeAllPanels("modal-chest-info");
  await loadChestConfig();
  const wrap = $("chest-level-list");
  wrap.innerHTML = "";
  (chestConfigCache || []).forEach((cfg) => {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `<div class="user-row-body"><span class="name">Level ${cfg.level}</span><span class="sub">${cfg.target.toLocaleString()} <img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> will open once reached</span></div>`;
    wrap.appendChild(row);
  });
  $("modal-chest-info").classList.remove("hidden");
});
$("btn-close-chest-info").addEventListener("click", () => $("modal-chest-info").classList.add("hidden"));

function playChestOpenAnimation(data) {
  const box = $("chest-box");
  box.classList.add("opening");
  setTimeout(() => {
    box.classList.remove("opening");
    box.classList.add("opened");
    showChestReward(data);
    setTimeout(() => box.classList.remove("opened"), 2500);
  }, 1600);
}

// Counts a number up from `from` to `to` inside `el`, calling `format` to
// render each intermediate value (e.g. to keep a fixed prefix/suffix).
function animateCountUp(el, from, to, duration, format) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const value = Math.round(from + (to - from) * eased);
    // innerHTML (2026-08-04, was textContent): its one caller (chest reward
    // reveal) now formats in a currency icon <img>, not plain text.
    el.innerHTML = format(value);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function showChestReward(data) {
  $("chest-reward-level").textContent = data.level;
  // Icon swap (2026-08-04): was plain-text emoji via textContent; the counter
  // below (animateCountUp) now writes innerHTML instead so the real coin/
  // diamond icon image can render inline, same as everywhere else.
  const currencyIconHtml = data.reward.type === "coins"
    ? '<img src="/images/icons/icon-coin.png" class="currency-icon" alt="coin">'
    : '<img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond">';
  $("chest-reward-card-visual").textContent = "🎁";

  // Suspense: show the mystery ("?") box first, then after a short beat flip
  // it away to reveal the gift + count the reward amount up from 0.
  const mysteryImg = $("chest-reward-mystery-img");
  const revealVisual = $("chest-reward-card-visual");
  const amountEl = $("chest-reward-amount");
  mysteryImg.classList.remove("reveal-out");
  revealVisual.classList.remove("reveal-in");
  revealVisual.classList.add("hidden");
  amountEl.classList.add("counting");
  amountEl.innerHTML = `+0 ${currencyIconHtml}`;

  setTimeout(() => {
    mysteryImg.classList.add("reveal-out");
    revealVisual.classList.remove("hidden");
    requestAnimationFrame(() => revealVisual.classList.add("reveal-in"));
    animateCountUp(amountEl, 0, data.reward.amount, 900, (v) => `+${v} ${currencyIconHtml}`);
    setTimeout(() => amountEl.classList.remove("counting"), 900);
  }, 700);

  const topWrap = $("chest-reward-top");
  topWrap.innerHTML = "";
  const owner = currentRoom ? { name: currentRoom.hostName, tag: "Room Owner" } : null;
  if (owner) {
    const row = document.createElement("div");
    row.className = "chest-reward-top-row";
    row.innerHTML = `<span>👑 ${escapeHtml(owner.name)}</span><span>${owner.tag}</span>`;
    topWrap.appendChild(row);
  }
  (data.topContributors || []).forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "chest-reward-top-row";
    row.innerHTML = `<span>#${i + 1} ${escapeHtml(c.name)}</span><span><img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> ${c.amount}</span>`;
    topWrap.appendChild(row);
  });
  $("modal-chest-reward").classList.remove("hidden");
  // Bug fix: this popup previously only closed via the ✕ button, and with
  // its old low z-index it could render behind an open game where that ✕
  // wasn't reachable at all, so it looked permanently "stuck" on screen.
  // Auto-close it after 3s (any earlier manual close/reopen clears/resets
  // this timer so it never fires twice or fights a fresh chest popup).
  closeChestRewardTimer && clearTimeout(closeChestRewardTimer);
  closeChestRewardTimer = setTimeout(closeChestReward, 3000);
}
let closeChestRewardTimer = null;
function closeChestReward() {
  closeChestRewardTimer && clearTimeout(closeChestRewardTimer);
  closeChestRewardTimer = null;
  $("modal-chest-reward").classList.add("hidden");
}
$("btn-close-chest-reward").addEventListener("click", closeChestReward);

// ===========================================================================
// ROOM MODERATION
// ===========================================================================
let seatLockButtons = [];
(function buildSeatLockRow() {
  const row = $("seat-lock-row");
  for (let n = 1; n <= 8; n++) {
    const b = document.createElement("button");
    b.className = "pick-btn";
    b.textContent = n;
    b.addEventListener("click", () => {
      const isLocked = (currentRoom?.lockedSeats || []).includes(n);
      socket.emit("lock-seat", { roomId: currentRoomId, seatNumber: n, locked: !isLocked });
    });
    row.appendChild(b);
    seatLockButtons.push(b);
  }
})();

$("mod-room-lock-toggle").addEventListener("change", (e) => {
  $("mod-room-lock-password").classList.toggle("hidden", !e.target.checked);
});
$("btn-mod-room-lock-save").addEventListener("click", () => {
  const locked = $("mod-room-lock-toggle").checked;
  const password = $("mod-room-lock-password").value;
  if (locked && !password.trim()) { toast("Enter Password"); return; }
  socket.emit("set-room-lock", { roomId: currentRoomId, locked, password });
  toast(locked ? "Room locked" : "Room unlocked");
  $("mod-room-lock-password").value = "";
});

$("btn-room-mod").addEventListener("click", () => {
  // Bug fix: this used to fail completely silently (no toast, nothing) if
  // tapped before the room's data had finished loading over the socket —
  // which reads exactly like "the settings icon is not clickable / blocked"
  // even though the click WAS registering. Now it tells the user to wait a
  // beat instead of doing nothing.
  if (!currentRoom) { toast("Room is loading, try again in a moment"); return; }
  // BUG FIX (settings-icon-does-nothing, 2026-07-29): everything below reads
  // me.userId repeatedly. If `me` is ever null when this fires (e.g. a
  // session hiccup) this used to throw INSIDE the click handler with no
  // toast and no console-visible feedback for the user to report — it just
  // looked like the tap did nothing at all. Now: an invalid session is
  // caught explicitly up front, and anything else that goes wrong is caught
  // too, so tapping this icon can never again silently do nothing — the
  // user always gets either the panel or a clear toast telling them why not.
  if (!me) { toast("Session issue — please log in again"); showView("view-login"); return; }
  try {
    const isOwner = currentRoom.hostId === me.userId;
    $("mod-room-lock-section").classList.toggle("hidden", !isOwner);
    $("mod-room-lock-toggle").checked = !!currentRoom.roomLocked;
    $("mod-room-lock-password").classList.toggle("hidden", !currentRoom.roomLocked);
    $("mod-room-lock-password").value = "";
    const others = (currentRoom.onlineUsers || []).filter(u => u.userId !== me.userId);
    const kickSelect = $("mod-kick-select");
    kickSelect.innerHTML = "";
    others.filter(u => u.userId !== currentRoom.hostId).forEach(u => {
      const opt = document.createElement("option"); opt.value = u.userId; opt.textContent = u.userName; kickSelect.appendChild(opt);
    });
    const adminSelect = $("mod-admin-select");
    adminSelect.innerHTML = "";
    others.forEach(u => {
      const opt = document.createElement("option"); opt.value = u.userId; opt.textContent = u.userName; adminSelect.appendChild(opt);
    });
    renderModBulkList(others);
    seatLockButtons.forEach((b, idx) => {
      const n = idx + 1;
      b.classList.toggle("locked", (currentRoom.lockedSeats || []).includes(n));
    });
    openRoomModWithBackHandling();
  } catch (err) {
    console.error("[ROOM-MOD] error opening Room Settings:", err);
    toast("Couldn't open Settings — please try again");
  }
});

// ---------------------------------------------------------------------
// Room Settings close handling.
// Fix (close/back navigation bug): previously the modal could only be
// dismissed by the small "Close" text button, and the Android
// hardware/gesture Back button navigated the whole app away from the
// room instead of just closing the modal. Now:
//   - an explicit ✕ button (top-right) always closes it
//   - opening the modal pushes one history entry, so Back closes the
//     modal first (via popstate) instead of leaving the room
//   - closing it any other way (✕ or "Close") also unwinds that
//     history entry so Back afterwards behaves normally again — the
//     modal can never get stuck open.
// ---------------------------------------------------------------------
let roomModHistoryPushed = false;
function openRoomModWithBackHandling() {
  $("modal-room-mod").classList.remove("hidden");
  if (!roomModHistoryPushed) {
    roomModHistoryPushed = true;
    history.pushState({ ppRoomMod: true }, "");
  }
}
function closeRoomMod() {
  $("modal-room-mod").classList.add("hidden");
  if (roomModHistoryPushed) {
    roomModHistoryPushed = false;
    if (history.state && history.state.ppRoomMod) history.back();
  }
}
window.addEventListener("popstate", () => {
  if (!$("modal-room-mod").classList.contains("hidden")) {
    $("modal-room-mod").classList.add("hidden");
    roomModHistoryPushed = false;
  }
});
$("btn-close-mod").addEventListener("click", closeRoomMod);
$("btn-mod-x-close").addEventListener("click", closeRoomMod);

$("btn-mod-kick").addEventListener("click", () => {
  const targetUserId = $("mod-kick-select").value;
  if (!targetUserId) return;
  socket.emit("kick-user", { roomId: currentRoomId, targetUserId });
  $("modal-room-mod").classList.add("hidden");
});
$("btn-mod-make-admin").addEventListener("click", () => {
  const targetUserId = $("mod-admin-select").value;
  if (!targetUserId) return;
  socket.emit("set-admin", { roomId: currentRoomId, targetUserId, isAdmin: true });
  toast("Made Admin");
});
$("btn-mod-remove-admin").addEventListener("click", () => {
  const targetUserId = $("mod-admin-select").value;
  if (!targetUserId) return;
  socket.emit("set-admin", { roomId: currentRoomId, targetUserId, isAdmin: false });
  toast("Admin removed");
});

// ---- Bulk moderation: multi-select users, then mute/invite/move/tag/announce ----
let selectedModTargets = new Set();
function renderModBulkList(users) {
  const list = $("mod-bulk-list");
  list.innerHTML = "";
  if (!users.length) {
    list.innerHTML = '<div class="gift-target-empty">No one else in the room</div>';
    $("mod-bulk-select-all").checked = false;
    $("mod-bulk-select-all").disabled = true;
    return;
  }
  $("mod-bulk-select-all").disabled = false;
  users.forEach((u) => {
    const row = document.createElement("label");
    row.className = "gift-target-row";
    const checked = selectedModTargets.has(u.userId) ? "checked" : "";
    row.innerHTML = `<input type="checkbox" data-userid="${u.userId}" ${checked}><span>${escapeHtml(u.userName)}</span>`;
    row.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selectedModTargets.add(u.userId);
      else selectedModTargets.delete(u.userId);
      $("mod-bulk-select-all").checked = users.every(x => selectedModTargets.has(x.userId));
    });
    list.appendChild(row);
  });
  $("mod-bulk-select-all").checked = users.every(u => selectedModTargets.has(u.userId));
}
$("mod-bulk-select-all").addEventListener("change", (e) => {
  const others = (currentRoom?.onlineUsers || []).filter(u => u.userId !== me.userId);
  if (e.target.checked) others.forEach(u => selectedModTargets.add(u.userId));
  else selectedModTargets.clear();
  renderModBulkList(others);
});
function requireModSelection() {
  const ids = Array.from(selectedModTargets);
  if (!ids.length) toast("Select a user first");
  return ids;
}
$("btn-mod-bulk-mute").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  const minutes = parseInt($("mod-bulk-mute-minutes").value, 10) || 0;
  socket.emit("mod-mute-users", { roomId: currentRoomId, targetUserIds: ids, minutes });
  toast(minutes > 0 ? `${ids.length} user(s) muted` : `${ids.length} user(s) unmuted`);
});
$("btn-mod-bulk-invite").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  socket.emit("mod-invite-to-seat", { roomId: currentRoomId, targetUserIds: ids });
  toast("Seat invite sent");
});
$("btn-mod-bulk-audience").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  socket.emit("mod-move-to-audience", { roomId: currentRoomId, targetUserIds: ids });
  toast("Sent to Audience");
});
$("btn-mod-bulk-label").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  const text = $("mod-bulk-label-text").value;
  socket.emit("mod-label-users", { roomId: currentRoomId, targetUserIds: ids, text, color: "#F7CE7E" });
  $("mod-bulk-label-text").value = "";
  toast(text.trim() ? "Tag applied" : "Tag removed");
});
$("btn-mod-bulk-announce").addEventListener("click", () => {
  const ids = requireModSelection();
  if (!ids.length) return;
  const message = $("mod-bulk-announce-text").value.trim();
  if (!message) { toast("Write a message"); return; }
  socket.emit("mod-announce-users", { roomId: currentRoomId, targetUserIds: ids, message });
  $("mod-bulk-announce-text").value = "";
  toast("Message sent");
});

// Someone with permission invited me to a seat — accepting just runs the
// normal take-seat flow for the suggested seat number.
// (moved into connectSocket() — see the fix note there)
// Host/admin muted or unmuted me — enforce locally by forcing the mic off
// and disabling the toggle for the duration.
let hostMutedUntil = 0;
// (mod-mute-update / mod-announcement handlers moved into connectSocket())
$("mod-logo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("logo", file);
  const r = await apiUpload("/api/room/logo/upload", fd);
  if (r.success) socket.emit("update-room-logo", { roomId: currentRoomId, url: r.url });
  else toast(r.message || "Upload failed");
});
// ---------------------------------------------------------------------------
// Room Theme (background) — Upload / Preview / Save / Cancel dialog.
// Reuses the exact same upload endpoint + socket event as before
// (/api/room/background/upload + update-room-background), so persistence
// and real-time sync are unchanged — this only adds an explicit preview +
// save step instead of applying on file-select.
// ---------------------------------------------------------------------------
let themeSelectedFile = null;
let themeSelectedLibraryUrl = null;
let themeLibraryCache = [];
function resetThemeModal() {
  themeSelectedFile = null;
  themeSelectedLibraryUrl = null;
  $("theme-file-input").value = "";
  $("theme-preview-img").style.display = "none";
  $("theme-preview-img").removeAttribute("src");
  $("theme-preview-empty").classList.remove("hidden");
  $("btn-theme-save").disabled = true;
  renderThemeLibraryGrid();
}
async function loadThemeLibrary() {
  const r = await api("/api/theme-library/list");
  if (r.success) { themeLibraryCache = r.themes; renderThemeLibraryGrid(); }
}
function renderThemeLibraryGrid() {
  const grid = $("theme-library-grid");
  const empty = $("theme-library-empty");
  if (!grid) return;
  empty.classList.toggle("hidden", themeLibraryCache.length > 0);
  grid.innerHTML = "";
  themeLibraryCache.forEach((t) => {
    const item = document.createElement("div");
    item.className = "theme-library-item" + (themeSelectedLibraryUrl === t.url ? " selected" : "");
    item.innerHTML = `<img src="${escapeHtml(t.url)}" alt=""><div class="theme-library-name">${escapeHtml(t.name)}</div>`;
    item.addEventListener("click", () => {
      themeSelectedFile = null;
      themeSelectedLibraryUrl = t.url;
      $("theme-file-input").value = "";
      $("theme-preview-img").src = t.url;
      $("theme-preview-img").style.display = "block";
      $("theme-preview-empty").classList.add("hidden");
      $("btn-theme-save").disabled = false;
      renderThemeLibraryGrid();
    });
    grid.appendChild(item);
  });
}
// (theme-library-update handler moved into connectSocket())
$("btn-open-room-theme").addEventListener("click", () => {
  closeRoomMod();
  resetThemeModal();
  loadThemeLibrary();
  $("modal-room-theme").classList.remove("hidden");
});
$("theme-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) { resetThemeModal(); return; }
  themeSelectedFile = file;
  themeSelectedLibraryUrl = null;
  const reader = new FileReader();
  reader.onload = () => {
    $("theme-preview-img").src = reader.result;
    $("theme-preview-img").style.display = "block";
    $("theme-preview-empty").classList.add("hidden");
    $("btn-theme-save").disabled = false;
    renderThemeLibraryGrid();
  };
  reader.readAsDataURL(file);
});
$("btn-theme-cancel").addEventListener("click", () => {
  resetThemeModal();
  $("modal-room-theme").classList.add("hidden");
});
$("btn-theme-save").addEventListener("click", async () => {
  if (!themeSelectedFile && !themeSelectedLibraryUrl) return;
  const btn = $("btn-theme-save");
  btn.disabled = true;
  btn.textContent = "Saving...";
  // Library pick needs no re-upload — the image is already on the server.
  if (themeSelectedLibraryUrl) {
    socket.emit("update-room-background", { roomId: currentRoomId, url: themeSelectedLibraryUrl });
    btn.textContent = "Save";
    toast("Theme saved ✅");
    resetThemeModal();
    $("modal-room-theme").classList.add("hidden");
    return;
  }
  const fd = new FormData();
  fd.append("background", themeSelectedFile);
  const r = await apiUpload("/api/room/background/upload", fd);
  btn.textContent = "Save";
  if (r.success) {
    socket.emit("update-room-background", { roomId: currentRoomId, url: r.url });
    toast("Theme saved ✅");
    resetThemeModal();
    $("modal-room-theme").classList.add("hidden");
  } else {
    btn.disabled = false;
    toast(r.message || "Upload failed");
  }
});
$("btn-mod-clear-chat").addEventListener("click", () => {
  socket.emit("clear-chat", { roomId: currentRoomId });
  $("modal-room-mod").classList.add("hidden");
});
$("btn-mod-close-room").addEventListener("click", () => {
  if (!confirm("Close this room? Everyone will be removed.")) return;
  socket.emit("close-room", { roomId: currentRoomId });
  $("modal-room-mod").classList.add("hidden");
  closeRoomGame();
  teardownYtPlayer();
  currentRoomId = null; currentRoom = null;
  joinedRoomId = null; joinInProgress = false; pendingJoinRequest = null; // join-lifecycle guard (2026-08-14 fix)
  currentRelationshipLinks = [];
  saveActiveRoom(null);
  showView("view-home"); loadRoomList();
});

// ===========================================================================
// BOOTSTRAP
// ===========================================================================
// FIX (2026-07-29, login-looks-broken): this used to render a black/green
// diagnostic overlay covering up to 40% of the screen height on every
// single app load (login, refresh, reconnect — every bootstrap() call).
// It was added temporarily to trace an earlier session bug via screenshots
// and was never meant to ship — but it stayed on, so anyone opening the
// app saw a wall of debug text sitting on top of the login/home screen,
// which is very reasonably read as "the app is broken / logging me out"
// even when the actual session logic underneath was working correctly.
// Same diagnostic detail is still fully available in the browser console
// (DevTools) via the matching console.log lines throughout bootstrap() —
// this just stops it from being drawn on screen for every real user.
function showDebugBadge(text) {
  console.log("[BOOTSTRAP-DEBUG]", text);
}

// Fix (stale/incorrect session survives refresh): previously the cached
// profile in localStorage was trusted forever and used as-is — a ban, a
// deleted account, or just stale coins/diamonds would only be corrected the
// next time the user happened to open their profile screen. Now we
// re-validate against the server once on load; if the account is gone or
// banned we clear the local session and send them back to login instead of
// letting them sit in a broken half-logged-in state.
async function bootstrap() {
  console.log("[BOOTSTRAP] start");
  showDebugBadge("BOOTSTRAP start. localStorage pp_user raw = " + (localStorage.getItem("pp_user") ? "PRESENT (" + localStorage.getItem("pp_user").length + " chars)" : "MISSING") + " | pp_auth_token = " + (localStorage.getItem("pp_auth_token") ? "PRESENT" : "MISSING"));
  loadSession();
  console.log("[BOOTSTRAP] loadSession ->", me ? { mobile: me.mobile, userId: me.userId } : null);
  if (!me || !me.mobile) {
    console.log("[BOOTSTRAP] no cached session, showing login");
    showDebugBadge("RESULT: no cached session in localStorage -> showing login screen. (If you just logged in and this still says MISSING, saveSession() itself did not persist — that's the bug. If it says PRESENT here but you still see this, the account/mobile field inside it is malformed.)");
    showView("view-login");
    return;
  }

  // Fix (auto-logout-on-refresh bug): a single "not found" response used
  // to wipe the saved session immediately and bounce the user to the
  // login screen on every refresh — but that response can also happen
  // from a transient server hiccup (brief restart, momentary DB read
  // miss) and not just a genuine deletion. Now we retry once after a
  // short pause; only a session-wiping logout if the account is still
  // confirmed missing after the retry. A saved login now survives
  // refresh and stays signed in until the user explicitly logs out.
  showDebugBadge("cached session found for mobile=" + me.mobile + ", userId=" + me.userId + ". Now validating against server...");
  let r = await api("/api/user/" + me.mobile);
  console.log("[BOOTSTRAP] server validation attempt 0 ->", r);
  showDebugBadge("server validation attempt 0 -> success=" + r.success + (r.networkError ? " (networkError!)" : "") + (r.message ? " message=" + r.message : ""));
  // Bug fix (auto-logout on refresh, take 2): one retry wasn't always enough
  // — a server restart/deploy or a slow cold-start can keep failing for a
  // couple of seconds, which used to still read as "confirmed not found"
  // and log the user out. Retry a few more times with a short backoff
  // before ever concluding the account is genuinely gone, and never trust
  // a "not found" if the browser itself thinks it's currently offline.
  let attempts = 0;
  while (!r.success && !r.networkError && attempts < 3) {
    await new Promise(res => setTimeout(res, 700));
    r = await api("/api/user/" + me.mobile);
    attempts++;
    console.log(`[BOOTSTRAP] server validation retry ${attempts} ->`, r);
  }
  if (!r.success) {
    if (r.networkError || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      // Network hiccup during boot — don't force a logout over a transient
      // error, just proceed with the cached copy.
      console.log("[BOOTSTRAP] logout decision: KEEP SESSION (network error / offline)");
      showDebugBadge("RESULT: KEEP SESSION — server call failed as a network error (not a real 'account not found'). Entering app normally.");
      // FIX (Auto-Join Room bug, 2026-07-29) + FIX (room lost on refresh,
      // 2026-07-29): loadActiveRoomIfFresh() only returns a room if it was
      // saved within the last ROOM_REJOIN_FRESHNESS_MS — i.e. this is an
      // actual refresh/reconnect, not the app being reopened long after the
      // fact. That keeps the original Auto-Join fix's intent (no silent
      // drop into a stale room) while still seamlessly restoring the room
      // for a genuine refresh, which is what the server's 8s seat grace
      // period was already designed to support.
      currentRoomId = loadActiveRoomIfFresh();
      try { connectSocket(); enterApp(); }
      catch (err) { console.error("[BOOTSTRAP] error (network-error branch), forcing Home view:", err); showView("view-home"); }
      return;
    }
    // Still not found after a retry — the server responded and confirmed
    // this account no longer exists (e.g. an admin deleted it). Don't let
    // a deleted account keep riding on stale cached session data, log it
    // out for real — UNLESS the user has explicitly turned on Logout Lock,
    // in which case honor that and keep them on the cached session instead
    // of force-logging them out on their behalf.
    if (isLogoutLockOn()) {
      console.log("[BOOTSTRAP] logout decision: KEEP SESSION (Logout Lock is ON, account reported not-found)");
      showDebugBadge("RESULT: KEEP SESSION — server said account not found, but Logout Lock is ON so staying logged in on cached data.");
      // FIX (Auto-Join Room bug, 2026-07-29) + FIX (room lost on refresh,
      // 2026-07-29): see the matching note in the network-error branch above.
      currentRoomId = loadActiveRoomIfFresh();
      try { connectSocket(); enterApp(); }
      catch (err) { console.error("[BOOTSTRAP] error (Logout Lock branch), forcing Home view:", err); showView("view-home"); }
      return;
    }
    console.log("[BOOTSTRAP] logout decision: CLEAR SESSION (account confirmed not-found after retries, Logout Lock is OFF)");
    showDebugBadge("RESULT: CLEAR SESSION AND LOG OUT — server confirmed GET /api/user/" + me.mobile + " returned 'not found' after " + attempts + " retries. THIS IS THE ACTUAL LOGOUT CAUSE if you see this line. Check the server console for a matching [SESSION-CHECK] line for this exact mobile number at this exact time.");
    clearSession("account-not-found");
    showView("view-login");
    toast("Your account could no longer be found, please log in again");
    return;
  }
  if (r.user.banned) {
    console.log("[BOOTSTRAP] logout decision: CLEAR SESSION (banned)");
    showDebugBadge("RESULT: CLEAR SESSION — server reports this account is banned.");
    clearSession("banned");
    showView("view-login");
    toast("Your account has been banned");
    return;
  }
  console.log("[BOOTSTRAP] logout decision: none, entering app normally");
  showDebugBadge("RESULT: SESSION RESTORED SUCCESSFULLY — server confirmed the account, entering app normally. If you were still bounced to login after seeing this, something later in enterApp()/connectSocket() is navigating away — tap this badge to dismiss it and check what happens next.");
  me = r.user;
  saveSession();
  // FIX (Auto-Join Room bug, 2026-07-29): previously called
  // `currentRoomId = loadActiveRoom()` here unconditionally, which silently
  // rejoined whatever room the user was last in the moment they opened the
  // app — no tap, no confirmation, even if that was hours/days ago.
  //
  // FIX (room lost on refresh, 2026-07-29): that fix then over-corrected —
  // it also broke the case of an actual browser refresh seconds into a
  // room session, where the server's 8s seat grace period was already
  // holding the seat open and the client just never asked to go back.
  // loadActiveRoomIfFresh() resolves both: it only restores the room if
  // pp_room was saved within the last ROOM_REJOIN_FRESHNESS_MS (a real
  // refresh/reconnect gap, kept rolling by the heartbeat near
  // connectSocket()), and returns null — same as before — for a stale
  // marker from a long-since-ended session. Room membership beyond that is
  // still only ever set by joinRoom() when the user manually taps a room
  // or joins by ID (see "VOICE ROOM" section below).
  currentRoomId = loadActiveRoomIfFresh();
  //
  // FIX (refresh-logout investigation, 2026-07-29): connectSocket()/
  // enterApp() below were previously called with no try/catch. The session
  // was already fully validated and restored above at this point — but any
  // unrelated JS error inside these (a missing DOM element, a third-party
  // script race, etc.) used to leave execution stuck wherever it threw,
  // never reaching showView("view-home"). Since "view-login" is the default
  // visible section in the raw HTML, that made a perfectly valid, restored
  // session LOOK exactly like a logout — with nothing in server logs to
  // explain it, since the failure never left the browser. Now: on any such
  // error, log it clearly (browser console) and still force the Home view,
  // since `me` is already confirmed valid at this point — the user stays
  // logged in even if some secondary widget failed to render.
  try {
    connectSocket();
    enterApp();
  } catch (err) {
    console.error("[BOOTSTRAP] error after session was already validated — session is NOT cleared, forcing Home view anyway:", err);
    showView("view-home");
  }
}
bootstrap().catch((err) => {
  // Safety net (audit fix, 2026-07-29): bootstrap() already wraps its own
  // risky calls internally, but this catches anything truly unforeseen so
  // it can never surface as a silent unhandled-rejection with the user
  // stuck on whatever the raw HTML defaults to.
  console.error("[BOOTSTRAP] uncaught fatal error, forcing login screen:", err);
  const loginView = document.getElementById("view-login");
  if (loginView) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    loginView.classList.add("active");
  }
});

// ===========================================================================
// CALL HOSTING (client) — additive, see callHosting.js on the server and
// the #hostcall-overlay markup in index.html. Deliberately its own state
// (chXxx variables) and its own "hostcall:*" socket events — no line of
// the existing private-inbox call code above (currentCall/callPc/
// call:*) is read or modified. getIceServers() is reused as-is (it's a
// pure, side-effect-free fetch) per "reuse the existing WebRTC
// architecture, don't rebuild the call engine".
// ===========================================================================
let chCall = null;      // { callId, peerId, peerName, peerPhoto, type, role }
let chLocalStream = null;
let chPc = null;

async function chApplyCallButtonVisibility(userId) {
  $("btn-call-host-audio").classList.add("hidden");
  $("btn-call-host-video").classList.add("hidden");
  try {
    const r = await api("/api/call-hosting/status/" + userId);
    if (r.success && r.isHost && r.enabled && userId !== me.userId) {
      $("btn-call-host-audio").classList.remove("hidden");
      $("btn-call-host-video").classList.remove("hidden");
    }
  } catch (e) { /* fail closed — no Call button if the check fails */ }
}

// VIDEO SECURITY (best-effort): there is no web-standard API that can
// force-prevent a screenshot or screen recording — this is fundamentally
// an OS/platform capability, not something JavaScript can guarantee. If
// this app is wrapped in a native Android WebView shell, that shell can
// expose a bridge object (e.g. `window.AndroidSecureBridge.setSecure`)
// that calls WindowManager.LayoutParams.FLAG_SECURE — this hook calls it
// if present. Without a native wrapper, this only applies the browser-
// level deterrents that exist (disabling context-menu/long-press-save on
// the video element) — genuine prevention is not achievable in a plain
// browser tab, and the call is never blocked or degraded over this.
function applyHostCallSecureMode(enable) {
  try {
    if (window.AndroidSecureBridge && typeof window.AndroidSecureBridge.setSecure === "function") {
      window.AndroidSecureBridge.setSecure(enable);
    }
  } catch (e) { /* no native bridge present — best-effort only, see comment above */ }
  const remote = $("hostcall-video-remote");
  const local = $("hostcall-video-local");
  [remote, local].forEach((el) => {
    if (!el) return;
    el.oncontextmenu = enable ? (() => false) : null;
    el.style.userSelect = enable ? "none" : "";
    el.setAttribute("controlsList", enable ? "nodownload noremoteplayback" : "");
  });
}

function chShowOverlay() { $("hostcall-overlay").classList.remove("hidden"); }
function chHideOverlay() {
  $("hostcall-overlay").classList.add("hidden");
  $("hostcall-video-remote-wrap").classList.add("hidden");
  $("hostcall-incoming-actions").classList.add("hidden");
  $("hostcall-outgoing-actions").classList.add("hidden");
  $("hostcall-active-controls").classList.add("hidden");
  $("hostcall-video-remote").srcObject = null;
  $("hostcall-video-local").srcObject = null;
  $("hostcall-billing-text").textContent = "";
}
function chSetStatusText(t) { $("hostcall-status-text").textContent = t; }

function chTeardown() {
  applyHostCallSecureMode(false);
  if (chPc) {
    try { chPc.getSenders().forEach((s) => { if (s.track) { s.track.onended = null; s.track.stop(); } }); } catch (e) {}
    chPc.onicecandidate = null; chPc.ontrack = null;
    try { chPc.close(); } catch (e) {}
    chPc = null;
  }
  if (chLocalStream) { chLocalStream.getTracks().forEach((t) => { t.onended = null; t.stop(); }); chLocalStream = null; }
  $("btn-hostcall-mute").classList.remove("active");
  chCall = null;
  chHideOverlay();
}

async function chAcquireLocalMedia(type) {
  const constraints = type === "video" ? { audio: true, video: { facingMode: "user" } } : { audio: true, video: false };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  chLocalStream = stream;
  if (type === "video") {
    $("hostcall-video-remote-wrap").classList.remove("hidden");
    const lv = $("hostcall-video-local");
    lv.srcObject = stream;
    const p = lv.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }
  return stream;
}

function chCreatePeerConnection(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  const sentCandidates = new Set();
  pc.onicecandidate = (e) => {
    if (!e.candidate || !chCall) return;
    const key = e.candidate.candidate;
    if (sentCandidates.has(key)) return;
    sentCandidates.add(key);
    socket.emit("hostcall:ice-candidate", { callId: chCall.callId, data: e.candidate });
  };
  pc.ontrack = (e) => {
    const rv = $("hostcall-video-remote");
    if (rv && rv.srcObject !== e.streams[0]) {
      rv.srcObject = e.streams[0];
      $("hostcall-video-remote-wrap").classList.remove("hidden");
      const p = rv.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  };
  return pc;
}

async function chStartCall(hostUserId, hostName, hostPhoto, type) {
  if (chCall) { toast("You're already on a call"); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("Calling isn't supported on this browser"); return; }
  chCall = { callId: null, peerId: hostUserId, peerName: hostName, peerPhoto: hostPhoto, type, role: "caller" };
  $("hostcall-peer-photo").src = hostPhoto || placeholderAvatar(hostName);
  $("hostcall-peer-name").textContent = hostName;
  chSetStatusText("Calling...");
  $("hostcall-outgoing-actions").classList.remove("hidden");
  chShowOverlay();
  try {
    const iceServers = await getIceServers();
    await chAcquireLocalMedia(type);
    chPc = chCreatePeerConnection(iceServers);
    chLocalStream.getTracks().forEach((t) => chPc.addTrack(t, chLocalStream));
  } catch (e) {
    toast("Couldn't access microphone/camera");
    chTeardown();
    return;
  }
  socket.emit("hostcall:invite", { toUserId: hostUserId, callType: type });
}
$("btn-call-host-audio").addEventListener("click", () => { if (otherProfileUser) chStartCall(otherProfileUser.userId, otherProfileUser.name, otherProfileUser.photo, "audio"); });
$("btn-call-host-video").addEventListener("click", () => { if (otherProfileUser) chStartCall(otherProfileUser.userId, otherProfileUser.name, otherProfileUser.photo, "video"); });

function chShowIncoming(callId, callType, from) {
  chCall = { callId, peerId: from.userId, peerName: from.userName, peerPhoto: from.userPhoto, type: callType, role: "callee" };
  $("hostcall-peer-photo").src = from.userPhoto || placeholderAvatar(from.userName);
  $("hostcall-peer-name").textContent = from.userName;
  chSetStatusText(callType === "video" ? "Incoming video call..." : "Incoming call...");
  $("hostcall-incoming-actions").classList.remove("hidden");
  chShowOverlay();
}

$("btn-hostcall-reject").addEventListener("click", () => { if (chCall) socket.emit("hostcall:reject", { callId: chCall.callId }); chTeardown(); });
$("btn-hostcall-cancel").addEventListener("click", () => { if (chCall) socket.emit("hostcall:end", { callId: chCall.callId }); chTeardown(); });
$("btn-hostcall-hangup").addEventListener("click", () => { if (chCall) socket.emit("hostcall:end", { callId: chCall.callId }); chTeardown(); });
$("btn-hostcall-mute").addEventListener("click", () => {
  if (!chLocalStream) return;
  const audioTrack = chLocalStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  $("btn-hostcall-mute").classList.toggle("active", !audioTrack.enabled);
});

$("btn-hostcall-accept").addEventListener("click", async () => {
  if (!chCall) return;
  const callId = chCall.callId;
  $("hostcall-incoming-actions").classList.add("hidden");
  chSetStatusText("Connecting...");
  try {
    const iceServers = await getIceServers();
    await chAcquireLocalMedia(chCall.type);
    chPc = chCreatePeerConnection(iceServers);
    chLocalStream.getTracks().forEach((t) => chPc.addTrack(t, chLocalStream));
  } catch (e) {
    toast("Couldn't access microphone/camera");
    socket.emit("hostcall:reject", { callId });
    chTeardown();
    return;
  }
  socket.emit("hostcall:accept", { callId });
});

function chRegisterSocketHandlers() {
  socket.on("hostcall:incoming", ({ callId, callType, from, secureMode }) => {
    chShowIncoming(callId, callType, from);
    if (secureMode) applyHostCallSecureMode(true);
  });

  socket.on("hostcall:ringing", ({ host }) => chSetStatusText(`Calling ${host.userName}...`));

  socket.on("hostcall:accepted", async ({ callId, secureMode, rate }) => {
    if (!chCall || chCall.callId !== callId && chCall.callId !== null) chCall = chCall || {};
    chCall.callId = callId;
    $("hostcall-outgoing-actions").classList.add("hidden");
    $("hostcall-incoming-actions").classList.add("hidden");
    $("hostcall-active-controls").classList.remove("hidden");
    chSetStatusText("Connected");
    if (rate) $("hostcall-billing-text").textContent = `${rate} coins / minute`;
    if (secureMode) applyHostCallSecureMode(true);
    if (chCall.role === "caller" && chPc) {
      const offer = await chPc.createOffer();
      await chPc.setLocalDescription(offer);
      socket.emit("hostcall:offer", { callId, data: offer });
    }
  });

  socket.on("hostcall:offer", async ({ callId, data }) => {
    if (!chPc || !chCall || chCall.callId !== callId) return;
    await chPc.setRemoteDescription(new RTCSessionDescription(data));
    const answer = await chPc.createAnswer();
    await chPc.setLocalDescription(answer);
    socket.emit("hostcall:answer", { callId, data: answer });
  });

  socket.on("hostcall:answer", async ({ data }) => {
    if (!chPc) return;
    await chPc.setRemoteDescription(new RTCSessionDescription(data));
  });

  socket.on("hostcall:ice-candidate", async ({ data }) => {
    if (!chPc || !data) return;
    try { await chPc.addIceCandidate(new RTCIceCandidate(data)); } catch (e) {}
  });

  // Server-authoritative billing display (requirement #5 — client only
  // ever displays what the server already deducted, never computes it).
  socket.on("hostcall:tick", ({ coinsCharged, balance, elapsedSec }) => {
    if (coinsCharged == null) return;
    const mins = Math.floor(elapsedSec / 60), secs = elapsedSec % 60;
    $("hostcall-status-text").textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    $("hostcall-billing-text").textContent = `${coinsCharged} coins charged` + (balance != null ? ` · balance: ${balance}` : "");
  });

  socket.on("hostcall:low-balance-warning", () => toast("Low balance — this call may end soon"));

  socket.on("hostcall:peer-reconnecting", () => chSetStatusText("Reconnecting..."));
  socket.on("hostcall:peer-resumed", () => chSetStatusText("Connected"));

  socket.on("hostcall:ended", ({ reason }) => {
    const messages = {
      "no-answer": "No answer", "rejected": "Call declined", "cancelled": "Call cancelled",
      "ended-by-user": "Call ended", "insufficient-balance": "Call ended — insufficient balance",
      "max-duration-reached": "Call ended — maximum duration reached",
      "daily-limit-reached": "Call ended — daily limit reached",
      "call-hosting-disabled": "Call Hosting is currently disabled",
      "host-status-changed": "This host is no longer available",
      "peer-disconnected": "Call ended — connection lost", "caller-not-found": "Call ended"
    };
    toast(messages[reason] || "Call ended");
    chTeardown();
  });

  socket.on("hostcall:error", ({ code, minBalance }) => {
    const messages = {
      "already-in-call": "You're already on a call", "host-busy": "This host is on another call",
      "not-a-host": "This user isn't an approved Call Host", "call-hosting-disabled": "Call Hosting is currently disabled",
      "insufficient-balance": `You need at least ${minBalance || 0} coins to start this call`,
      "host-offline": "Host is offline", "caller-not-found": "Something went wrong"
    };
    toast(messages[code] || "Couldn't start the call");
    chTeardown();
  });
}
