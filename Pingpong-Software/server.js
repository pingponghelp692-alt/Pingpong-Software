require("dotenv").config();
const APP_NAME = "PingPong";

// PHASE 6 (2026-08-17 — env/secrets hardening, master fix spec §29): fail
// fast in production if VOICE_MODE explicitly requests SFU/staged but
// LiveKit isn't actually configured, instead of silently degrading to
// mesh. Deliberately placed as the very first thing after dotenv loads —
// before any port is bound, any socket accepted, any route registered —
// so a misconfigured production deploy never serves a single request in
// a state it didn't ask for. Does nothing outside production, and does
// nothing when VOICE_MODE=mesh is the explicit (valid) choice — see
// envReadiness.js's assertProductionVoiceReadiness() for the exact scope.
try {
    require("./envReadiness.js").assertProductionVoiceReadiness();
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
// Startup readiness snapshot — one line per subsystem, booleans/enums
// only, never a secret value (see envReadiness.js's header for why that's
// a hard guarantee, not just convention here).
{
    const r = require("./envReadiness.js").getReadinessReport();
    console.log(`[startup] voiceMode=${r.voiceMode} livekit=${r.livekit} turn=${r.turn} redis=${r.redis} database=${r.database} firebase=${r.firebase}`);
}

// AUDIT FIX (Final integration sweep, 2026-07-29): every actual await in
// this codebase was already individually wrapped in try/catch (verified —
// see server.js's message-send route, image-processing routes, and every
// AI module) so nothing found today was actually throwing uncaught. This
// is the missing safety net on top of that, not a fix for a live bug:
// without a process-level handler, Node 18+ terminates the entire process
// — every connected user, every open room, every in-flight request — on
// ANY future uncaught exception or unhandled promise rejection, including
// ones from code added later that misses a try/catch. Log-and-continue is
// the right default for a long-running server handling many independent
// users; a crash loop is strictly worse than one bad request being logged.
process.on("uncaughtException", (err) => {
    console.error("🚨 Uncaught exception (server kept running):", err);
});
process.on("unhandledRejection", (reason) => {
    console.error("🚨 Unhandled promise rejection (server kept running):", reason);
});

const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { socketIoCorsOptions } = require("./security/corsConfig");
// PRODUCTION AUDIT FIX (2026-08-10): additive, no-op-if-unused shared HTTP
// middleware (request IDs, no-store, JSON enforcement helpers). Contains
// no auth/business logic per its own README; only the requestId() helper
// is used below, for HTTP response correlation IDs.
const sharedMiddleware = require("./integration_update/middleware");
const io = require("socket.io")(http, {
    // AUDIT FIX (2026-07-27, voice/socket stability): running on Socket.IO's
    // bare defaults (pingInterval 25s / pingTimeout 20s) means a brief
    // mobile-network blip — a few seconds in a tunnel/elevator, a carrier
    // handoff — that misses even one ping cycle tears the whole connection
    // down and re-triggers this app's 8s room-leave grace period on top of
    // it. That combination is a plausible source of the reported random
    // voice disconnects/freezes on mobile. Widening the timeout gives normal
    // brief drops room to recover via Socket.IO's own reconnect before the
    // app ever sees a "disconnect" at all; it does not change behavior for a
    // connection that's genuinely gone, just how long that takes to confirm.
    pingInterval: 25000,
    pingTimeout: 60000,
    // Slightly above default (1MB) headroom for larger payloads (gift
    // catalogs with images, playlists) without affecting normal traffic.
    maxHttpBufferSize: 2 * 1024 * 1024,
    // MODULE 5.2: same env-driven allowlist as the HTTP `cors()` call below
    // (see security/corsConfig.js) — kept in one shared module so HTTP and
    // WebSocket/polling transport CORS behavior can't drift apart.
    cors: socketIoCorsOptions
});

// ---------- Socket.IO Redis Adapter (Phase 2B-1, see redis/socketAdapter.js) ----------
// Attached here, immediately after `io` is created and before any route
// or socket handler is registered, so every io.to()/emit() call
// anywhere else in this file transparently broadcasts across every
// instance sharing the same Redis the moment more than one instance is
// deployed. Safe no-op today: without REDIS_URL/REDIS_HOST configured
// (or without the @socket.io/redis-adapter package installed), `io`
// keeps Socket.IO's default in-memory adapter — single-instance
// behavior, byte-for-byte unchanged. Wrapped defensively, same pattern
// as every other optional module in this file, so a problem here can
// never block startup.
try {
    const { initSocketIOAdapter } = require("./redis/socketAdapter.js");
    initSocketIOAdapter(io);
} catch (e) {
    console.warn(`[redis] Socket.IO Redis Adapter failed to initialize, continuing on default in-memory adapter: ${e.message}`);
}

const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const crypto = require("crypto");

// ---------- PingPong AI Core ----------
// Modular AI backend (chat support, monitoring, security, moderation,
// analytics, dashboard) — lives entirely under ai/ and never touches wallet
// logic directly. See ai/ai-config.js for how to configure/rotate the
// Gemini API key and README.md for setup notes.
const aiChat = require("./ai/ai-chat");
const aiMonitor = require("./ai/ai-monitor");
const aiSecurity = require("./ai/ai-security");
const aiModerator = require("./ai/ai-moderator");
const aiRoomAssistant = require("./ai/ai-room-assistant");
const aiDashboardRouter = require("./ai/ai-dashboard");
// ---------- PingPong Security Hardening (Phase 10) ----------
// Additive, self-contained modules under security/ — same pattern as
// analyticsHub.js/banManagement.js. See security/*.js for details on each.
const { securityHeaders } = require("./security/headers");
const { httpCorsOptions } = require("./security/corsConfig"); // MODULE 5.2
const { otpLimiter, authLimiter, adminLoginLimiter, apiLimiter } = require("./security/rateLimiter");
const bruteForce = require("./security/bruteForce");
const adminSessionGuard = require("./security/session");
const { sanitizeText, isValidMobile, safeFilename, isSafeObjectKey } = require("./security/validation");
const userAuth = require("./security/userAuth");
const socketIdentity = require("./security/socketIdentity");
const { createMetrics } = require("./monitoring/metrics");
// Firebase Auth Migration — Phase A. Kept for Google Sign-In ONLY (see
// PINGPONG-REPLACE-FIREBASE-OTP spec). Phone OTP no longer goes through
// this module at all — see security/otpService.js + sms/gateway.js below.
// If not configured yet, the module degrades gracefully and only
// /api/auth/firebase-login (Google) is affected.
const firebaseAuth = require("./security/firebaseAuth");
// Self-hosted OTP (replaces Firebase Phone Auth AND the old insecure
// Math.random()/console.log OTP). Additive, self-contained module — same
// initX({deps}) pattern as svip.js. See security/otpService.js.
const { initOtpService } = require("./security/otpService");
// Local Android/Termux SMS gateway — the ONLY delivery mechanism for OTPs.
// No cloud/third-party SMS provider is used anywhere in this codebase.
const smsGateway = require("./sms/gateway");
// ---------- Private Inbox Audio/Video Calling (2026-07-27) ----------
// Additive module, same wiring pattern as banManagement.js/analyticsHub.js —
// see callSignaling.js for the full design note (WebRTC peer-to-peer media,
// Socket.IO used only to relay signaling between the two participants).
const { initCallSignaling } = require("./callSignaling.js");
const { initCallHosting } = require("./callHosting.js");
// First Time Profile Setup — shared country/language catalogue (server
// validation + client dropdown both read from this, see countries.js).
const countries = require("./countries");
// Phase 11: performance modules — same additive pattern as security/*.js.
// See each file for what it does and why.
const writeQueue = require("./perf/writeQueue");
const { attachIndex } = require("./perf/userIndex");
const { compression } = require("./perf/compression");
// SVIP Tag Management — image processing is optional at startup, so the
// server still boots on platforms where sharp's prebuilt native binary
// doesn't match the runtime (this was crashing on Android Termux with
// "Could not load the sharp module using the android-arm64 runtime").
// Preference order when actually processing an upload: sharp -> jimp ->
// store the original PNG unresized. See saveSvipTagImage() below.
let sharp = null;
try {
    sharp = require("sharp");
} catch (err) {
    console.warn(`⚠️  'sharp' not available (${err.message}) — SVIP tag uploads will use the jimp fallback, or store PNGs unresized if jimp isn't available either. This does not affect any other feature.`);
}
let jimp = null;
if (!sharp) {
    try {
        jimp = require("jimp");
    } catch (err) {
        console.warn(`⚠️  'jimp' not available either (${err.message}) — SVIP tag PNGs will be saved without auto-resizing.`);
    }
}

// ---------- Admin Config ----------
// Production MUST provide explicit owner credentials. Development keeps the
// historical defaults only when NODE_ENV is not "production", so the existing
// local/Termux workflow is not broken while a production deployment can never
// silently fall back to a public credential.
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || (IS_PRODUCTION ? "" : "admin");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PRODUCTION ? "" : "admin123");
if (IS_PRODUCTION && (!ADMIN_USERNAME || !ADMIN_PASSWORD)) {
    throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required when NODE_ENV=production. Refusing to start with insecure admin defaults.");
}
let adminSessions = new Map(); // token -> admin account id (was username; every existing call site reads the account via rbac now, see adminAccountFromReq)
// Phase 11: when session.js's own periodic sweep expires a token, also
// remove it here — otherwise an abandoned (never-logged-out) admin
// session sits in this Map until someone happens to reuse that exact
// token after expiry, which never happens for an abandoned one.
adminSessionGuard.setOnExpire((token) => adminSessions.delete(token));

// ---------- RBAC (Enterprise Role Based Admin) ----------
// Additive layer only — does not change any business logic above/below.
// See rbac.js for the full role/permission model. The legacy
// ADMIN_USERNAME/ADMIN_PASSWORD keeps logging in exactly as before; it is
// transparently migrated to the "owner" role on first boot.
const rbac = require("./rbac").makeStore(path.join(__dirname, "data"));
let socketsByUserId = {}; // userId -> socket.id (unchanged: "most recent" socket, still what every existing module reads)

// GAP #1 (Redis Authoritative Runtime State) — cross-instance-safe targeted
// emit. socketsByUserId[userId] only ever knows about a socket connected to
// THIS instance, so `io.to(socketsByUserId[userId]).emit(...)` silently
// fails to deliver to a user connected to a different cluster instance.
// Every socket now also joins a small per-user room (`user:${userId}`, see
// the "identify" and "join-room" handlers below) — Socket.IO's Redis
// Adapter (already wired in near the top of this file) makes room
// membership and emits to it cross-instance automatically, so this reaches
// the user regardless of which instance they're connected to, and safely
// reaches nobody (a no-op, same as today's `if (sid)` false branch) if
// they're not connected anywhere. Single-instance/no-Redis behavior is
// unchanged either way, since a local socket is a member of its own
// `user:${userId}` room too.
//
// NOT a full replacement for every `socketsByUserId[x]` read in this file —
// this pass migrates the clearest, most directly cross-instance-affected
// call sites (private messaging, follow-status). See the delivery report's
// "known limitations" for the remaining call sites left as local-only.
function emitToUser(userId, event, payload) {
    io.to(`user:${userId}`).emit(event, payload);
}

// VOICE FIX (multi-device): a dedicated userId -> Set<socket.id> registry,
// used ONLY for call invite ringing / cleanup in callSignaling.js. Kept
// deliberately separate from socketsByUserId above rather than replacing
// it — socketsByUserId is read by ~30 unrelated modules (wallet, RBAC,
// admin online-status, groups, etc.) that all just want "a" socket to
// notify and have no concept of multiple devices; changing its shape would
// mean touching every one of those call sites, which is explicitly out of
// scope. This registry adds true multi-socket awareness without altering
// any of that existing single-socket behavior.
let callSocketsByUserId = new Map();
function addCallSocket(userId, socketId) {
    if (!userId || !socketId) return;
    let set = callSocketsByUserId.get(userId);
    if (!set) { set = new Set(); callSocketsByUserId.set(userId, set); }
    set.add(socketId);
}
function removeCallSocket(userId, socketId) {
    if (!userId || !socketId) return;
    const set = callSocketsByUserId.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) callSocketsByUserId.delete(userId);
}
let pendingDisconnects = {}; // userId -> { timer, roomId }  (reconnect grace period)
// AUDIT FIX (2026-07-29, socket-reconnection-stability) — Ghost socket cleanup
// for users who are NOT in a room. `socketsByUserId` was only ever cleared by
// handleUserLeaveRoom(isDisconnecting=true), which is exclusively reached from
// the room-based grace-period timer below. A user connected but never in a
// room (e.g. browsing Home via "identify") who disconnects was never removed
// from socketsByUserId — the entry pointed at a dead socket.id forever,
// permanently reporting them "online", inflating online counts, and leaking
// memory for the life of the server. This mirrors the exact same grace-period
// pattern already used for room members, just for the no-room case.
let pendingPresenceDisconnects = {}; // userId -> { timer, socketId } (non-room reconnect grace period)

// ROOT-CAUSE FIX (2026-08-14, reconnect / duplicate join-room / room
// lifecycle audit): connection-generation tracking. Before this fix, a
// disconnect's 30s grace-period timer only ever checked
// `socketsByUserId[uid] !== socket.id` to decide whether it was still
// safe to act (see the "disconnect" handler below) — correct in the
// common case, but with no independent second signal it was possible for
// a stale/delayed callback to still see a match by coincidence during a
// fast reconnect/room-switch race and wrongly tear down a NEWER
// connection's room/seat/presence state (freeing a seat that had already
// been re-taken, flapping the owner offline, etc. — exactly the symptoms
// in the production log this fix responds to).
//
// userConnGeneration[userId] is a monotonically increasing counter,
// bumped every time a DIFFERENT socket becomes "current" for that user
// (see bindSocketToUser() below). Each socket remembers the generation
// number that was current when it was bound (socket.connGen). Any
// deferred/async callback that's about to mutate a user's presence, room
// membership, seat, owner, or voice state now verifies BOTH that
// socketsByUserId[uid] still equals its own socket.id AND that
// userConnGeneration[uid] still equals the generation it captured at
// schedule time — i.e. it must still be dealing with the exact
// connection instance it was scheduled for, not just a coincidentally
// matching socket id.
let userConnGeneration = {}; // userId -> integer, bumped every time a new socket becomes current for that user

// Binds a socket as the CURRENT connection for a user (used by both the
// "identify" and "join-room" handlers below) — this is the single place
// socketsByUserId[userId] is ever assigned, so connection-generation
// bookkeeping can never drift out of sync with it. Idempotent: calling it
// again for the socket that's already current for this user is a no-op
// on the generation counter (does not treat a socket as "new" relative
// to itself, e.g. on a duplicate "join-room" for the same socket).
function bindSocketToUser(socket, userId) {
    if (socketsByUserId[userId] !== socket.id) {
        userConnGeneration[userId] = (userConnGeneration[userId] || 0) + 1;
    }
    socketsByUserId[userId] = socket.id;
    socket.connGen = userConnGeneration[userId];
}

// Fix (updates not showing up after deploy): browsers/WebViews aggressively
// cache static files by default, so HTML is served no-cache — every load
// re-fetches index.html, which always has the current <script src="app.js?v=...">
// tag pointing at the current version.
//
// Fix (regression: room/seat dropped on every refresh): an earlier attempt
// at this also put app.js/style.css on no-cache, thinking it would stop
// phones from silently running an old cached app.js after a deploy. It did,
// but at a real cost — every single refresh then had to re-download the
// full JS bundle over the network before bootstrap() could even start,
// which on a slow/congested mobile connection was sometimes enough to blow
// past the 8s room reconnect grace period, so the person's seat got freed
// and they were dropped from the room on refresh even though their account
// session was fine. The ?v=YYYYMMDD query string on the <script>/<link>
// tags above already busts the cache correctly on an actual deploy (new
// version string = new URL = guaranteed fresh fetch), so JS/CSS can go back
// to normal browser caching for everything in between.
const staticNoCacheHtml = { setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
} };
// Phase 13 production-readiness fix: without this, every request behind
// a reverse proxy (see nginx.conf.example) arrives at Express with
// req.ip === the proxy's own loopback address (127.0.0.1) for every
// client, because Express trusts the raw TCP socket by default and
// ignores X-Forwarded-For. That's a real bug once Nginx is introduced —
// security/rateLimiter.js's default per-IP bucket (used by apiLimiter,
// otpLimiter, authLimiter, adminLoginLimiter) would then key on the same
// "127.0.0.1" for literally every user, turning a per-IP ceiling into one
// shared global ceiling, and every rbac.logAction audit-log entry would
// record "127.0.0.1" instead of the real client IP, losing forensic
// value. Opt-in via TRUST_PROXY so a bare/direct deployment (e.g. the
// existing Termux setup, or local dev with no Nginx in front) keeps
// req.ip as the real connecting socket address exactly as before — only
// set TRUST_PROXY=1 in .env once Nginx is actually in front of this
// process (see nginx.conf.example + README.md "Deployment steps").
if (process.env.TRUST_PROXY) {
    app.set("trust proxy", process.env.TRUST_PROXY === "1" ? 1 : process.env.TRUST_PROXY);
}
// MODULE 5.2: was `app.use(cors())` (all origins, unconditionally). Now
// env-driven — see security/corsConfig.js for the exact allowlist/default
// behavior (CORS_ORIGINS unset = same-origin/mobile-app/localhost-dev only).
app.use(cors(httpCorsOptions));
// PRODUCTION AUDIT FIX (2026-08-10): correlation/request IDs on every HTTP
// response, per Section 10 (Monitoring/Observability) of the production
// audit — was flagged as missing. Uses the existing, previously-unwired
// integration_update/middleware/requestId helper (additive, no auth/business
// logic, sets only a response header + req.httpRequestId). Named
// `httpRequestId` (not `req.requestId`) deliberately: server.js already uses
// `requestId` extensively as a client-supplied gift/coin idempotency key
// destructured from req.body — reusing that name on the req object itself
// would be confusing even though there's no actual collision.
app.use((req, res, next) => {
    sharedMiddleware.requestId(req, res, () => {
        req.httpRequestId = req.requestId; // alias for clarity, keep original too for the helper's own contract
        next();
    });
});
app.use(securityHeaders); // Phase 10: security headers on every response
app.use(compression); // Phase 11: gzip/deflate responses (skips already-compressed binary content)
app.use(express.json({ limit: "2mb" })); // Phase 10: bound JSON body size (was unbounded)
app.use(express.static("public", staticNoCacheHtml));
app.use("/club", express.static("public/club", staticNoCacheHtml));
app.use("/admin", express.static("admin", staticNoCacheHtml));
// Owner Panel / Admin Panel split (additive, same underlying admin/
// app.js+index.html+style.css bundle — see admin/app.js PANEL_TYPE and
// the /api/admin/login panelType check below for the actual access
// segregation). /admin itself is left mounted exactly as before for
// backward compatibility with any existing bookmarks/links; it stays
// unrestricted (no panelType sent from that path), matching current
// behavior 1:1. These two new paths are the ones meant to be used going
// forward: /owner-panel for the Owner account only, /admin-panel for
// every other role.
app.use("/owner-panel", express.static("admin", staticNoCacheHtml));
app.use("/admin-panel", express.static("admin", staticNoCacheHtml));
app.use("/api", apiLimiter); // Phase 10: general per-IP ceiling on all API routes
app.use("/api/admin/ai", aiDashboardRouter(requireAdmin, requirePermission));

// Phase 13: health-check endpoint. Deliberately unauthenticated (a load
// balancer / PM2 / uptime monitor / Nginx upstream check has no admin
// token) and deliberately minimal — no user data, no counts, nothing an
// unauthenticated caller shouldn't see, just process liveness + uptime so
// PM2/Nginx/an external monitor can tell "server process is up and the
// event loop is responsive" apart from "server process is down/hung".
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

// PHASE 6 (2026-08-17 — master fix spec §28): GET /healthz — same
// unauthenticated-liveness posture as /api/health above (kept for
// backward compat with anything already polling it), but reports the
// config-status shape requested by the spec: voiceMode/livekit/turn/
// redis/database. Still deliberately no operator/infra detail (connection
// counts, pool state) and NEVER a secret value — see envReadiness.js's
// header for why that's a hard guarantee, not just convention.
app.get("/healthz", (req, res) => {
    res.json(require("./envReadiness.js").getPublicHealth());
});

// Admin-authenticated variant: same fields, plus firebase status and any
// deeper connection detail (e.g. Redis allReady) that's fine for an
// authenticated operator to see but not for an anonymous health-check
// caller. No `requirePermission(...)` scoping beyond requireAdmin itself —
// this is read-only config status, not an action.
app.get("/api/admin/health", requireAdmin, (req, res) => {
    res.json({ success: true, ...require("./envReadiness.js").getReadinessReport() });
});


// ---------- Folders ----------
// PHASE 12 (additive, optional): resolves against PERSISTENT_DISK_PATH if
// set (e.g. a Render Persistent Disk mount) — see perf/dataFolder.js.
// Unset (the default/unchanged behavior), these resolve exactly as before.
const { resolveDataFolder, resolveUploadsRoot } = require("./perf/dataFolder.js");
const DATA_FOLDER = resolveDataFolder(__dirname);
const UPLOADS_ROOT = resolveUploadsRoot(__dirname);
const MUSIC_FOLDER = path.join(UPLOADS_ROOT, "music");
const PHOTO_FOLDER = path.join(UPLOADS_ROOT, "photos");
const BG_FOLDER = path.join(UPLOADS_ROOT, "backgrounds");
const LOGO_FOLDER = path.join(UPLOADS_ROOT, "logos");
const FRAME_FOLDER = path.join(UPLOADS_ROOT, "frames");
// Video Gift System — admin-uploaded MP4 gifts + their thumbnails.
const VIDEO_GIFT_FOLDER = path.join(UPLOADS_ROOT, "video-gifts");
const VIDEO_GIFT_THUMB_FOLDER = path.join(UPLOADS_ROOT, "video-gifts-thumbs");
// SVIP Tag Management — admin-uploaded PNG tag per SVIP level (svip1.png..svip8.png).
const SVIP_TAG_FOLDER = path.join(UPLOADS_ROOT, "svip-tags");
// Groups — icon uploads for the Home screen Groups tab.
const GROUP_ICON_FOLDER = path.join(UPLOADS_ROOT, "group-icons");
// Gift Manager — admin-uploaded PNG image + MP3 sound per regular gift
// (Normal/VIP/Legend tabs in the Gift Box). Separate from the Video Gift
// System above, which is its own "Custom" tab.
const GIFT_IMAGE_FOLDER = path.join(UPLOADS_ROOT, "gift-images");
const GIFT_SOUND_FOLDER = path.join(UPLOADS_ROOT, "gift-sounds");
// Home Banner System — admin-uploaded banner images for the Home page slider.
const BANNER_FOLDER = path.join(UPLOADS_ROOT, "banners");
// Vehicle Entry System (add-on) — admin-uploaded thumbnail + full-screen
// entry video + optional music/sound per vehicle. See vehicles.js.
const VEHICLE_THUMB_FOLDER = path.join(UPLOADS_ROOT, "vehicle-thumbs");
const VEHICLE_VIDEO_FOLDER = path.join(UPLOADS_ROOT, "vehicle-videos");
const VEHICLE_AUDIO_FOLDER = path.join(UPLOADS_ROOT, "vehicle-audio");
// Level Management (ID Level System Upgrade, 2026-08-04) — admin-uploaded
// badge/icon/border/background PNGs, one set per 10-level group.
const LEVEL_THEME_FOLDER = path.join(UPLOADS_ROOT, "level-themes");
// Friendship/CP visual system (2026-08-11) — admin-uploaded custom PNG per
// relationship type (CP heart / Friendship heart). Bundled defaults stay in
// public/images/relationships/ (see friendshipCp.js); this folder only
// holds admin-replaced custom assets.
const RELATIONSHIP_ASSET_FOLDER = path.join(UPLOADS_ROOT, "relationship-assets");

[DATA_FOLDER, MUSIC_FOLDER, PHOTO_FOLDER, BG_FOLDER, FRAME_FOLDER, LOGO_FOLDER, VIDEO_GIFT_FOLDER, VIDEO_GIFT_THUMB_FOLDER, SVIP_TAG_FOLDER, GROUP_ICON_FOLDER, GIFT_IMAGE_FOLDER, GIFT_SOUND_FOLDER, BANNER_FOLDER, VEHICLE_THUMB_FOLDER, VEHICLE_VIDEO_FOLDER, VEHICLE_AUDIO_FOLDER, LEVEL_THEME_FOLDER, RELATIONSHIP_ASSET_FOLDER].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const noCacheStatic = { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache, must-revalidate") };
app.use("/music", express.static(MUSIC_FOLDER));
app.use("/photos", express.static(PHOTO_FOLDER));
app.use("/backgrounds", express.static(BG_FOLDER, noCacheStatic));
app.use("/frames", express.static(FRAME_FOLDER));
app.use("/logos", express.static(LOGO_FOLDER, noCacheStatic));
app.use("/group-icons", express.static(GROUP_ICON_FOLDER, noCacheStatic));
app.use("/video-gifts", express.static(VIDEO_GIFT_FOLDER));
app.use("/video-gifts-thumbs", express.static(VIDEO_GIFT_THUMB_FOLDER));
app.use("/svip-tags", express.static(SVIP_TAG_FOLDER));
app.use("/gift-images", express.static(GIFT_IMAGE_FOLDER, noCacheStatic));
app.use("/gift-sounds", express.static(GIFT_SOUND_FOLDER, noCacheStatic));
app.use("/banner-images", express.static(BANNER_FOLDER, noCacheStatic));
app.use("/vehicle-thumbs", express.static(VEHICLE_THUMB_FOLDER));
app.use("/vehicle-videos", express.static(VEHICLE_VIDEO_FOLDER, { maxAge: "7d" })); // cacheable — lets client Preload/Cache per the perf requirement
app.use("/vehicle-audio", express.static(VEHICLE_AUDIO_FOLDER, { maxAge: "7d" }));
// no-cache: admin-replaced CP/Friendship PNGs are already cache-busted via
// the ?v=<config version> query string (see friendshipCp.js publicVisualConfig),
// but no-cache is kept here too as defense-in-depth against a CDN/proxy that
// strips query strings from its cache key.
app.use("/relationship-assets", express.static(RELATIONSHIP_ASSET_FOLDER, noCacheStatic));
app.use("/level-themes", express.static(LEVEL_THEME_FOLDER, noCacheStatic));

// ---------- File Upload Config ----------
const musicStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, MUSIC_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname)) // Phase 10: path-traversal-safe filename
});
const upload = multer({
    storage: musicStorage,
    limits: { fileSize: 15 * 1024 * 1024 }, // Phase 10: 15MB cap (was unbounded)
    fileFilter: (req, file, cb) => { // Phase 10
        if (!/^audio\//.test(file.mimetype)) return cb(new Error("Only audio files can be uploaded"));
        cb(null, true);
    }
});

const photoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTO_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname)) // Phase 10: path-traversal-safe filename
});
const uploadPhoto = multer({
    storage: photoStorage,
    limits: { fileSize: 8 * 1024 * 1024 }, // Phase 10: 8MB cap (was unbounded)
    fileFilter: (req, file, cb) => { // Phase 10
        if (!/^image\//.test(file.mimetype)) return cb(new Error("Only images can be uploaded"));
        cb(null, true);
    }
});

const bgStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, BG_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname)) // Phase 10: path-traversal-safe filename
});
const uploadBg = multer({
    storage: bgStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // Phase 10: 10MB cap (was unbounded)
    fileFilter: (req, file, cb) => { // Phase 10
        if (!/^image\//.test(file.mimetype)) return cb(new Error("Only images can be uploaded"));
        cb(null, true);
    }
});

const frameStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, FRAME_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname)) // Phase 10: path-traversal-safe filename
});
const uploadFrame = multer({
    storage: frameStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // Phase 10: 5MB cap (was unbounded)
    fileFilter: (req, file, cb) => { // Phase 10
        if (file.mimetype !== "image/png") return cb(new Error("Only PNG frames can be uploaded"));
        cb(null, true);
    }
});

// Friendship/CP visual system — admin-uploaded custom PNG per type, same
// path-traversal-safe filename + type/size validation pattern as frames.
const relationshipAssetStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, RELATIONSHIP_ASSET_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname))
});
const uploadRelationshipAsset = multer({
    storage: relationshipAssetStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap, same as frames
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "image/png") return cb(new Error("Only PNG images can be uploaded"));
        cb(null, true);
    }
});

const logoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOGO_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname)) // Phase 10: path-traversal-safe filename
});
const uploadLogo = multer({
    storage: logoStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // Phase 10: 5MB cap (was unbounded)
    fileFilter: (req, file, cb) => { // Phase 10
        if (!/^image\//.test(file.mimetype)) return cb(new Error("Only images can be uploaded"));
        cb(null, true);
    }
});

const bannerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, BANNER_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname))
});
const uploadBanner = multer({
    storage: bannerStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap, per spec
    fileFilter: (req, file, cb) => {
        if (!/^image\/(jpeg|jpg|png|webp)$/.test(file.mimetype)) return cb(new Error("Only JPG, PNG or WEBP images can be uploaded"));
        cb(null, true);
    }
});

// Level Management (ID Level System Upgrade, 2026-08-04) — one upload
// endpoint handles all 4 optional image fields (badge/icon/border/
// background) for a single group-theme save in one request.
const levelThemeStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, LEVEL_THEME_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname))
});
const uploadLevelTheme = multer({
    storage: levelThemeStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!/^image\//.test(file.mimetype)) return cb(new Error("Only images can be uploaded"));
        cb(null, true);
    }
});

const groupIconStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, GROUP_ICON_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname)) // Phase 10: path-traversal-safe filename
});
const uploadGroupIcon = multer({
    storage: groupIconStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // Phase 10: 5MB cap (was unbounded)
    fileFilter: (req, file, cb) => { // Phase 10
        if (!/^image\//.test(file.mimetype)) return cb(new Error("Only images can be uploaded"));
        cb(null, true);
    }
});

// SVIP Tag uploads: kept in memory (not written to disk directly) because
// each upload is auto-resized + re-encoded with `sharp` (preserving PNG
// transparency) before being saved as a fixed svip{level}.png filename.
const uploadSvipTag = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB is plenty for a tag icon
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== "image/png") return cb(new Error("Only PNG files can be uploaded"));
        cb(null, true);
    }
});

// Video Gift uploads: one form submits both the MP4 and its thumbnail image
// together, so the two files need to land in two different folders based on
// which field they came in on (multer's default diskStorage only sees one
// `destination` per instance, so we branch on file.fieldname here).
const videoGiftStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === "thumbnail" ? VIDEO_GIFT_THUMB_FOLDER : VIDEO_GIFT_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname)) // Phase 10: path-traversal-safe filename
});
const uploadVideoGift = multer({
    storage: videoGiftStorage,
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB — gifts are only 6-8s clips
    fileFilter: (req, file, cb) => {
        if (file.fieldname === "video" && file.mimetype !== "video/mp4") return cb(new Error("Only MP4 videos can be uploaded"));
        cb(null, true);
    }
});

// Gift Manager uploads: one form submits both the PNG image and the MP3
// sound together, so branch on file.fieldname the same way the Video Gift
// uploader does above. A gift can be created/edited without replacing
// either file (existing asset is kept).
const giftAssetStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, file.fieldname === "sound" ? GIFT_SOUND_FOLDER : GIFT_IMAGE_FOLDER),
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname)) // Phase 10: path-traversal-safe filename
});
const uploadGiftAssets = multer({
    storage: giftAssetStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — plenty for a gift icon + a short chime
    fileFilter: (req, file, cb) => {
        if (file.fieldname === "image" && file.mimetype !== "image/png") return cb(new Error("Gift Image must be PNG"));
        if (file.fieldname === "sound" && file.mimetype !== "audio/mpeg" && file.mimetype !== "audio/mp3") return cb(new Error("Gift Sound must be MP3"));
        cb(null, true);
    }
});

// Vehicle Entry System uploads: one form submits up to four files
// (thumbnail image, entry video, optional background music, optional
// entry sound effect) — branch on file.fieldname the same way Video
// Gift / Gift Manager uploads do above.
const vehicleStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === "thumbnail") return cb(null, VEHICLE_THUMB_FOLDER);
        if (file.fieldname === "video") return cb(null, VEHICLE_VIDEO_FOLDER);
        return cb(null, VEHICLE_AUDIO_FOLDER); // music or sound
    },
    filename: (req, file, cb) => cb(null, Date.now() + "-" + safeFilename(file.originalname))
});
const uploadVehicle = multer({
    storage: vehicleStorage,
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB — same cap as Video Gifts, plenty for a short entry clip
    fileFilter: (req, file, cb) => {
        if (file.fieldname === "thumbnail" && !/^image\//.test(file.mimetype)) return cb(new Error("Thumbnail must be an image"));
        if (file.fieldname === "video" && file.mimetype !== "video/mp4" && file.mimetype !== "video/webm") return cb(new Error("Entry Video must be MP4 or WebM"));
        if ((file.fieldname === "music" || file.fieldname === "sound") && !/^audio\//.test(file.mimetype)) return cb(new Error("Background Music / Sound Effect must be an audio file"));
        cb(null, true);
    }
});

// ---------- Data Files ----------
const USERS_FILE = path.join(DATA_FOLDER, "users.json");
const ROOMS_FILE = path.join(DATA_FOLDER, "rooms.json");
const MESSAGES_FILE = path.join(DATA_FOLDER, "messages.json");
const TRANSACTIONS_FILE = path.join(DATA_FOLDER, "transactions.json");
// AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): see logTransaction()
// below — entries trimmed off the live file to keep it small are appended
// here instead of being discarded, so the audit trail is never permanently
// lost, just moved off the "hot" file.
const TRANSACTIONS_ARCHIVE_FILE = path.join(DATA_FOLDER, "transactions_archive.json");
const EXCHANGES_FILE = path.join(DATA_FOLDER, "exchanges.json");
const GIFTLOG_FILE = path.join(DATA_FOLDER, "gift_log.json");
const FRAME_CATALOG_FILE = path.join(DATA_FOLDER, "frame_catalog.json");
// Admin-curated Theme Library — background images admins upload once from
// the panel; users pick one for their room from Room Settings → Room Theme
// instead of (or alongside) uploading their own custom background.
const THEME_LIBRARY_FILE = path.join(DATA_FOLDER, "theme_library.json");
const VIDEO_GIFTS_FILE = path.join(DATA_FOLDER, "video_gifts.json");
// Gift Manager — admin-controlled catalog for the regular Gift Box tabs
// (Normal/VIP/Legend). Separate file from VIDEO_GIFTS_FILE (the "Custom" tab).
const GIFTS_FILE = path.join(DATA_FOLDER, "gifts_catalog.json");
const AGENCIES_FILE = path.join(DATA_FOLDER, "agencies.json");
const ANNOUNCEMENTS_FILE = path.join(DATA_FOLDER, "announcements.json");
// YouTube Room Player — each room's video playlist is persisted separately
// from room meta (ROOMS_FILE) so it survives a server restart just like
// everything else here, without touching how rooms.json itself is shaped.
const VIDEO_PLAYLISTS_FILE = path.join(DATA_FOLDER, "video_playlists.json");
// Groups — Home screen "Groups" tab. Simple persisted store, same pattern as ROOMS_FILE.
const GROUPS_FILE = path.join(DATA_FOLDER, "groups.json");
const CS101_CONFIG_FILE = path.join(DATA_FOLDER, "cs101_config.json");
// Gift History — permanent, structured record of every successful gift
// (regular + video gifts), separate from giftLog (which is a capped
// display feed used for other things). This is the source of truth for
// Room Ranking and, later, Agency/Host Center stats. Never pruned.
const GIFT_HISTORY_FILE = path.join(DATA_FOLDER, "gift_history.json");

// Fix (data corruption on crash mid-write): writing straight to the target
// file means a crash/power-loss while the write is in flight can leave
// users.json/rooms.json as truncated, corrupt JSON — which fails to parse
// on the next startup and silently falls back to an empty dataset (i.e.
// "all users disappeared"). Writing to a temp file then renaming into place
// is atomic on POSIX filesystems: the file is always either the old
// complete version or the new complete version, never a half-written one.
//
// Phase 11: the actual disk write is now debounced (perf/writeQueue.js) —
// same atomic temp-file-then-rename, but coalesces rapid repeated saves of
// the same file (e.g. saveUsers() firing dozens of times per second in a
// busy room) into one write instead of blocking the event loop on every
// single mutation. Function name/signature is unchanged (opts is new but
// optional), so every module that receives `safeWrite` via dependency
// injection (svip.js, banManagement.js, diamondSeller.js, vipApproval.js,
// agencyHost.js, coinCenter.js) benefits automatically with no changes on
// their end. See perf/writeQueue.js for the crash-window tradeoff this
// introduces and why it's safe.
function safeWrite(file, data, opts) {
    writeQueue.queueWrite(file, data, opts);
}
function safeRead(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        console.error(`❌ Failed to read ${file}, attempting backup recovery:`, err.message);
        // AUDIT FIX (2026-07-27, "data resets to zero" / "user data resets"):
        // this used to just fall through to `fallback` here — for
        // users.json/rooms.json/etc. that fallback is `{}`, so a single
        // corrupt or truncated file (crash mid-write, disk issue, bad manual
        // edit, or corruption from before the atomic-write fix existed) made
        // every user/room/wallet appear to vanish on the next boot, even
        // though the data was fine an hour earlier. Try the rolling .bak
        // copy (written just before every successful save in writeQueue.js)
        // before ever giving up and returning empty.
        const backupFile = file + ".bak";
        try {
            if (fs.existsSync(backupFile)) {
                const recovered = JSON.parse(fs.readFileSync(backupFile, "utf8"));
                console.error(`✅ Recovered ${file} from backup ${backupFile}`);
                // Preserve the corrupt original for forensics instead of
                // silently discarding it, then restore the good copy into
                // place so future reads/writes use it directly.
                try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch (_) {}
                try { fs.copyFileSync(backupFile, file); } catch (_) {}
                return recovered;
            }
        } catch (backupErr) {
            console.error(`❌ Backup ${backupFile} is also unreadable:`, backupErr.message);
        }
        console.error(`🚨 CRITICAL: ${file} is corrupt and no usable backup exists — starting from empty/default data. Manual recovery may be needed; check for ${file}.corrupt-* files.`);
    }
    return fallback;
}

function saveUsers(opts) { safeWrite(USERS_FILE, users, opts); }
function saveMessages() { safeWrite(MESSAGES_FILE, privateMessages); }
function saveRoomsToDisk() {
    const persistable = {};
    Object.values(rooms).forEach((r) => {
        persistable[r.roomId] = {
            roomId: r.roomId,
            roomNumber: r.roomNumber || r.hostId,
            roomName: r.roomName,
            hostId: r.hostId,
            hostName: r.hostName,
            official: !!r.official,
            aiCustomerService: !!r.aiCustomerService,
            aiAgentId: r.aiAgentId || null,
            adminIds: r.adminIds || [],
            lockedSeats: r.lockedSeats || [],
            background: r.background || null,
            logo: r.logo || null,
            agencyId: r.agencyId || null,
            gameEnabled: r.gameEnabled !== false,
            // Room Lock (owner-set password) — persisted so a locked room
            // stays locked across a server restart. Only the hash is ever
            // written to disk, never the plain password.
            roomLocked: !!r.roomLocked,
            roomPasswordHash: r.roomPasswordHash || null,
            countryId: r.countryId || "OTHERS"
        };
    });
    safeWrite(ROOMS_FILE, persistable);
}
function hashRoomPassword(pw) {
    return crypto.createHash("sha256").update(String(pw)).digest("hex");
}
// YouTube Room Player — persistence for playlists only. Playback state
// (currently playing / paused / position) is intentionally NOT persisted,
// same as room.music: it's live room state, not saved room configuration,
// so it simply starts fresh (video mode off) on server restart while the
// playlist itself survives.
function saveVideoPlaylists() {
    const persistable = {};
    Object.values(rooms).forEach((r) => {
        if (r.videoPlaylist && r.videoPlaylist.length) persistable[r.roomId] = r.videoPlaylist;
    });
    safeWrite(VIDEO_PLAYLISTS_FILE, persistable);
}
function deleteVideoPlaylist(roomId) {
    const all = safeRead(VIDEO_PLAYLISTS_FILE, {});
    if (all[roomId]) { delete all[roomId]; safeWrite(VIDEO_PLAYLISTS_FILE, all); }
}
function freshVideoPlayerState() {
    return { mode: false, currentIndex: -1, isPlaying: false, position: 0, updatedAt: Date.now() };
}
// Computes "where playback actually is right now" from the last known
// state + how much time has elapsed since it was last updated, so a user
// joining mid-playback (or just sitting on room-state refreshes) lands on
// the correct timestamp instead of everyone drifting back to 0 each sync.
function currentYtPosition(player) {
    if (!player || player.currentIndex < 0) return 0;
    if (!player.isPlaying) return player.position || 0;
    const elapsed = (Date.now() - (player.updatedAt || Date.now())) / 1000;
    return (player.position || 0) + Math.max(0, elapsed);
}
function publicVideoPlayer(room) {
    const p = room.videoPlayer || freshVideoPlayerState();
    return { ...p, position: currentYtPosition(p) };
}
// Accepts youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/ links
// (with or without extra query params) and pulls out the 11-char video id.
function extractYouTubeId(url) {
    if (!url || typeof url !== "string") return null;
    const re = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
    const m = url.match(re);
    if (m) return m[1];
    try {
        const u = new URL(url);
        const v = u.searchParams.get("v");
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    } catch (_) { /* not a valid absolute URL */ }
    return null;
}
// Best-effort title lookup via YouTube's public oEmbed endpoint — no API
// key required. Never blocks the add itself; the playlist item is created
// with a placeholder title immediately and patched once/if this resolves.
async function fetchYouTubeTitle(videoId, sourceUrl) {
    try {
        const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(sourceUrl)}&format=json`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.title) return data.title;
        }
    } catch (err) {
        console.warn("⚠️  YouTube oEmbed title fetch failed:", err.message);
    }
    return "YouTube Video";
}

// SELF-HOSTED OTP (2026-08-16, replaces Firebase Phone Auth + the old
// insecure Math.random()/console.log OTP store). All OTP generation,
// hashing, expiry, attempt-limiting and resend-cooldown logic now lives in
// security/otpService.js — this just wires it up with this process's
// existing atomic-write persistence helpers, same as initSvip() below.
const otpService = initOtpService({ DATA_FOLDER, safeRead, safeWrite });

let users = safeRead(USERS_FILE, {});
console.log(`📂 Loaded ${Object.keys(users).length} user(s) from ${USERS_FILE}`);
Object.values(users).forEach((u) => {
    if (!Array.isArray(u.followersList)) u.followersList = [];
    if (!Array.isArray(u.followingList)) u.followingList = [];
    if (typeof u.diamonds !== "number") u.diamonds = 0;
    if (typeof u.banned !== "boolean") u.banned = false;
    if (typeof u.verified !== "boolean") u.verified = false;
    if (typeof u.visitors !== "number") u.visitors = 0;
    if (typeof u.vipLevel !== "number") u.vipLevel = 0;
    if (typeof u.agencyId !== "string" && u.agencyId !== null) u.agencyId = null;
    if (typeof u.isHost !== "boolean") u.isHost = false;
    if (!u.activeFrame) u.activeFrame = null; // { frameId, name, imageUrl, expiresAt }
    // Per-user Frame ownership (mirrors u.vehicleInventory below) — only a
    // frame present in THIS array belongs to this user; activeFrame may only
    // ever be set to one of these. Safe on old accounts via this default,
    // same pattern as every other per-user inventory field here.
    if (!Array.isArray(u.frameInventory)) u.frameInventory = []; // [{ frameId, assignedAt, expiresAt, permanent, assignedBy }]
    if (u.customTag === undefined) u.customTag = null; // { text, color } — admin-assigned coloured tag (e.g. VIP), shown next to the username
    if (u.nameEffect === undefined) u.nameEffect = null; // Admin-assigned Profile Name Color style key (e.g. "gold_glow") — glow/animation shown ONLY on the Room Seat name, nowhere else.
    if (u.customId === undefined) u.customId = null; // Admin-assigned Custom ID Number (Golden Light style) — display-only, shown instead of the permanent userId wherever the ID is shown. The real userId keeps working everywhere internally (lookups, sockets, wallet, rooms) unchanged.
    if (!u.lastDailyRewardAt) u.lastDailyRewardAt = null;
    if (!u.lastWeeklyRewardAt) u.lastWeeklyRewardAt = null;
    // SVIP Privilege System (svip.js) — separate wealth-level fields, added
    // here so existing accounts get sane defaults the same way other fields
    // above do. See svip.js for what these mean.
    if (typeof u.svipWealth !== "number") u.svipWealth = 0;
    if (typeof u.svipLevel !== "number") u.svipLevel = 0;
    if (u.svipMembershipType === undefined) u.svipMembershipType = "permanent";
    if (u.svipExpireAt === undefined) u.svipExpireAt = null;
    if (u.svipExpiryWarned === undefined) u.svipExpiryWarned = false;
    // Admin Coin Center (Agency-style operator) — see coinCenter.js
    if (typeof u.isCoinCenter !== "boolean") u.isCoinCenter = false;
    // Home screen "Recently" tab — [{roomId, roomNumber, roomName, hostId, hostName, hostPhoto, lastVisitAt}],
    // newest-first, capped at 50, one entry per room (re-visits just bump lastVisitAt).
    if (!Array.isArray(u.recentRooms)) u.recentRooms = [];
    // Home screen "Groups" tab — group membership. No group-creation system exists yet,
    // so this is a stable empty shape the tab can read until that's built.
    if (!Array.isArray(u.groups)) u.groups = [];
    // Country Data Isolation (RBAC Phase 2, item 2) — every user belongs to
    // exactly one country bucket for admin-panel scoping. Mobile numbers are
    // normalized to bare 10 digits (see normalizeMobile) with no dialing
    // code kept, so it can't be auto-detected from the number; existing
    // accounts (and any account created without an explicit country) land
    // in the "OTHERS" bucket rather than being hidden from every
    // country-scoped admin. Owner/Global Super Admin always see everyone
    // regardless of this value (see rbac.inScope). An Owner/Global Super
    // Admin can move a user into the correct country via
    // POST /api/admin/users/:mobile/country.
    if (u.countryId === undefined || !rbac.COUNTRY_IDS.includes(u.countryId)) u.countryId = "OTHERS";
    // First Time Profile Setup — every account that existed BEFORE this
    // feature shipped is grandfathered straight past the new setup screen
    // (profile_completed defaults to true for them). Only genuinely new
    // signups get profile_completed: false at creation time below, so the
    // screen only ever appears once, on a brand-new account's first login.
    if (u.profile_completed === undefined) u.profile_completed = true;
    if (u.gender === undefined) u.gender = null;
    if (u.country === undefined) u.country = null; // real ISO country ("BD","SA",...) — separate from the RBAC region in u.countryId
    if (u.language === undefined) u.language = "bn";
    // Vehicle Entry System (add-on) — see vehicles.js. Mirrors the
    // activeFrame default pattern above so existing accounts are safe.
    if (u.activeVehicleId === undefined) u.activeVehicleId = null;
    if (!Array.isArray(u.vehicleInventory)) u.vehicleInventory = []; // [{ vehicleId, assignedAt, expiresAt, permanent, assignedBy }]
});

// Production Hotfix (Firebase build) — Mobile Account Migration Fix.
// Runs once at boot, mutates `users` IN PLACE before any other module
// captures a reference to it (svip/coinCenter/banManagement/etc. are all
// require()'d further below) and before the userId index is built just
// after this. Only ever touches phone-shaped keys; "google:<uid>" keys
// (Firebase-linked accounts) are never read or modified here. Idempotent:
// safe to run on every boot.
const { runMobileMigration } = require("./mobileMigration.js");
{
    const migrationSummary = runMobileMigration(users, { normalizeMobile, DATA_FOLDER, safeRead, safeWrite, path });
    if (migrationSummary.renamed || migrationSummary.merged) {
        console.log(`🔧 Mobile migration: ${migrationSummary.renamed} key(s) normalized, ${migrationSummary.merged} duplicate account(s) merged, ${migrationSummary.archivedCount} old record(s) archived to archived_duplicate_accounts.json.`);
        saveUsers({ immediate: true });
    } else {
        console.log("🔧 Mobile migration: nothing to migrate (all accounts already canonical).");
    }
}

function generateUniqueUserId() {
    let id;
    const existingIds = new Set(Object.values(users).map((u) => u.userId));
    do {
        id = String(Math.floor(10000000 + Math.random() * 90000000)); // random 8-digit
    } while (existingIds.has(id));
    return id;
}

// Phase 11: was a full Object.keys(users).find() linear scan — now backed
// by perf/userIndex.js's O(1) Map lookup (self-healing fallback baked in,
// see that file). Function name/signature unchanged, so all 100+ existing
// call sites across server.js and every dependent module keep working
// with no changes on their end.
const userIndex = attachIndex(users);
function findUserByUserId(userId) {
    return userIndex.findUserByUserId(userId);
}

// Custom ID Number must be unique across all users (excludes the user it's
// already assigned to, so re-saving the same value for the same user is fine).
function isCustomIdTaken(customId, excludeMobile) {
    return Object.entries(users).some(([m, u]) => u.customId === customId && m !== excludeMobile);
}

// ---------- SVIP Privilege System (additive module, see svip.js) ----------
const { initSvip } = require("./svip.js");
const svip = initSvip({ DATA_FOLDER, safeRead, safeWrite, io, socketsByUserId, findUserByUserId, saveUsers, users });

// ---------- ID Level System 1-100 (additive module, see idLevel.js) ----------
// Increases only from coins sent as Gift/Video Gift in a room. Does not
// touch the existing wealth-based `user.level` (levelFromCoins) anywhere.
const { initIdLevel } = require("./idLevel.js");
const idLevel = initIdLevel({ io, socketsByUserId, emitToUser, findUserByUserId, DATA_FOLDER, safeRead, safeWrite });

// ---------- Private Inbox Audio/Video Calling (additive, see callSignaling.js) ----------
const callSignaling = initCallSignaling({
    app, io, DATA_FOLDER, safeRead, safeWrite, findUserByUserId, users, socketsByUserId,
    callSocketsByUserId, sanitizeText, isRateLimited: aiSecurity.isRateLimited, userAuth
});

// ---------- Paid Call Hosting (additive, see callHosting.js) ----------
// Separate feature/namespace from the free private-inbox calling above —
// "hostcall:*" events, its own data files, its own in-memory call maps.
// requireAdmin/requirePermission/rbac/actorCanAccessCountry/
// countryDeniedResponse/reqUserAgent are function declarations defined
// later in this file but hoisted, same as every other module below that
// closes over them at init time (see country_permission's attach() call).
const callHosting = initCallHosting({
    app, io, DATA_FOLDER, safeRead, safeWrite, findUserByUserId, socketsByUserId,
    saveUsers, clampCoinBalance, logTransaction, pushWalletUpdate,
    rbac, requireAdmin, requirePermission, actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

// ---------- Voice Health Monitor (Phase 1 / Tier A, see voice-health.js) ----------
// Was previously shipped as a file but never wired in — this is that
// wiring, not a rewrite. Registers the "voice-stats" socket handler below
// and feeds health-check.js's admin snapshot.
const { initVoiceHealth } = require("./voice-health.js");
const voiceHealth = initVoiceHealth({ io, aiSecurity });

// ---------- Smart Auto Reconnect, server-side complement (Phase 1 / Tier A, see voice-reconnect.js) ----------
const { initVoiceReconnect } = require("./voice-reconnect.js");
const voiceReconnect = initVoiceReconnect({ io });



// Room Recovery Manager and Health Check Service are wired further down,
// right after `rooms` (let rooms = {}) and publicRoom() are declared —
// both modules read those by reference and `let` bindings aren't
// available before their declaration line runs.

// ---------- Private Messages ----------
let privateMessages = safeRead(MESSAGES_FILE, {});
function conversationKey(a, b) { return [a, b].sort().join("_"); }

// ---------- Friendship + CP relationship system (additive) ----------
// Persisted pair relationships, coin-priced requests, private-message
// accept/decline cards, and room-seat visual links. Existing room/seat
// structures remain unchanged; relationshipLinks is derived presentation
// state only.
const { initFriendshipCp } = require("./friendshipCp.js");
const friendshipCp = initFriendshipCp({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, users, userAuth,
    clampCoinBalance, logTransaction, pushWalletUpdate,
    emitToUser, io, privateMessages, saveMessages, conversationKey,
    getRooms: () => rooms,
    // Admin Panel (2026-08-11): CP/Friendship size/opacity/animation/position
    // config + custom PNG upload. requireAdmin/requirePermission/rbac/
    // reqUserAgent are defined further down this file — safe because
    // initFriendshipCp only registers routes at call time via closures over
    // these bindings, and all app.* registration happens after server
    // startup begins listening, well after these functions are defined.
    requireAdmin, requirePermission,
    uploadRelationshipAsset, RELATIONSHIP_ASSET_FOLDER,
    rbac, reqUserAgent
});

// ---------- Gift Catalog (Gift Manager — admin controlled) ----------
// Replaces the old hardcoded emoji gift list. Gifts now live in
// data/gifts_catalog.json and are fully managed from the Admin Panel's
// Gift Manager screen: add/edit/delete/enable-disable, PNG image + MP3
// sound upload, coin price, effect type (small / full_screen), and tier
// (normal / vip / legend — keeps the existing Gift Box tabs working
// exactly as before, just populated from the panel instead of hardcoded).
//
// Effect type drives the client-side animation:
//   - "small": animation plays only around the receiving host's seat.
//   - "full_screen": animation covers the entire room (particles, flash,
//     light effects, plus the gift's own sound).
const GIFT_CATALOG_FILE_DEFAULT = [
    { id: "gift_teddy_heart", name: "Teddy Heart", image: null, sound: null, price: 10, effectType: "small", tier: "normal" },
    { id: "gift_galaxy_heart", name: "Galaxy Heart", image: null, sound: null, price: 50, effectType: "small", tier: "normal" },
    { id: "gift_magic_wand", name: "Magic Wand", image: null, sound: null, price: 30, effectType: "small", tier: "normal" },
    { id: "gift_diamond_crown", name: "Diamond Crown", image: null, sound: null, price: 100, effectType: "small", tier: "vip" },
    { id: "gift_unicorn", name: "Unicorn", image: null, sound: null, price: 150, effectType: "small", tier: "vip" },
    { id: "gift_baby_dragon", name: "Baby Dragon", image: null, sound: null, price: 200, effectType: "small", tier: "vip" },
    { id: "gift_treasure_chest", name: "Treasure Chest", image: null, sound: null, price: 500, effectType: "full_screen", tier: "vip" },
    { id: "gift_neon_rocket", name: "Neon Rocket", image: null, sound: null, price: 1000, effectType: "full_screen", tier: "legend" },
    { id: "gift_golden_car", name: "Golden Car", image: null, sound: null, price: 2000, effectType: "full_screen", tier: "legend" },
    { id: "gift_phoenix", name: "Phoenix", image: null, sound: null, price: 5000, effectType: "full_screen", tier: "legend" }
].map((g) => ({ ...g, enabled: true, createdAt: new Date().toISOString() }));

let giftCatalog = safeRead(GIFTS_FILE, null);
if (!Array.isArray(giftCatalog)) {
    giftCatalog = GIFT_CATALOG_FILE_DEFAULT;
    safeWrite(GIFTS_FILE, giftCatalog);
}
function saveGiftCatalog() { safeWrite(GIFTS_FILE, giftCatalog); }
// Public: what the app's Gift Box (Normal/VIP/Legend tabs) loads — enabled only.
function publicGiftCatalog() { return giftCatalog.filter((g) => g.enabled !== false); }
// Any admin Add/Edit/Delete/Toggle updates every connected client's Gift Box live.
function broadcastGiftCatalog() { io.emit("gift-catalog", publicGiftCatalog()); }

// DEPRECATED (LEVEL SYSTEM UPGRADE, 2026-08-04): this wealth-tier formula
// used to be recomputed onto `user.level` at every coin-changing call site
// in the app (admin edit, chest reward, gift receive, fruit-wheel payout,
// game-wheel-sync, instant exchange, coin center, diamond seller, recharge
// approval — 15+ sites) — which is exactly the "level increases
// automatically [from anything, not just gift sending]" behavior the
// customer's Level System Upgrade spec asked to remove. Per that spec,
// `user.level` is now driven ENTIRELY by idLevel.js's gift-send-only
// progression (see idLevel.js's mirrorToLegacyLevelField). This function
// is kept only so nothing throws if some other unforeseen code path still
// references it — it is deliberately no longer called from anywhere, and
// levelFromCoins is no longer passed into coinCenter.js/diamondSeller.js/
// rechargeWithdrawApproval.js (search those files for the same date-tagged
// comment).
function levelFromCoins(coins) {
    return Math.min(100, Math.max(1, Math.floor(coins / 200) + 1));
}

// ==================================================
// ID LEVEL SYSTEM (1-100) — separate from the wealth `level` above.
// AUDIT FIX (2026-07-27): this file used to contain its OWN copy of the
// ID Level threshold table and its own addLifetimeCoinsSentAndUpdateIdLevel()
// helper, called at every gift-send site *in addition to* idLevel.js's
// recordCoinsSent() a few lines later. Both functions incremented the same
// user.lifetimeCoinsSent field, so every gift was counted TWICE — this was
// the root cause of the reported "level jumps to 50/100/500" bug (a user
// could cross several level thresholds off a single normal-sized gift
// because their lifetime total was silently doubled). The duplicate table/
// helper has been removed; idLevel.js's recordCoinsSent() (see call sites
// below) is now the single source of truth for ID Level / lifetimeCoinsSent.
// RENAME (2026-07-29, Level System rewrite): lifetimeCoinsSent is now
// lifetimeGiftSent and recordCoinsSent() is now recordGiftSent() — same
// field/function, new names per the current spec. See idLevel.js for the
// full current rules (fixed 5x progression, room-gating, etc).
function vipLevelFromDiamonds(diamonds) {
    if (diamonds >= 5000) return 5;
    if (diamonds >= 2000) return 4;
    if (diamonds >= 800) return 3;
    if (diamonds >= 300) return 2;
    if (diamonds >= 50) return 1;
    return 0;
}
// Every brand-new account starts with this many diamonds as a welcome bonus.
const NEW_USER_STARTING_DIAMONDS = 100000;

// ---------- Gift Log ----------
let giftLog = safeRead(GIFTLOG_FILE, []);
function logGift(entry) {
    giftLog.push(entry);
    if (giftLog.length > 5000) giftLog = giftLog.slice(-5000);
    safeWrite(GIFTLOG_FILE, giftLog);
}

// AUDIT FIX (Wallet/Gift/Level integrity pass, 2026-07-29): a gift send moves
// real coins and, inside a room, real ID-Level progress — but unlike chat and
// emoji reactions (which already use aiSecurity.isRateLimited), none of the
// three gift-send paths (send-gift, send-video-gift, POST /api/gifts/send)
// had ANY protection against the same user action being processed twice —
// e.g. a double-tap that fires two socket emits before the UI disables the
// button, or a flaky connection causing the client to retry a REST request
// that actually succeeded server-side. Each individual send was already
// atomic (see the snapshot/rollback try/catch at every call site) — the gap
// was purely "the exact same tap processed as two separate real charges".
// In-memory only (matches every other short-lived per-process cache in this
// file, e.g. pendingDisconnects/otpStore) — same idempotency-cache shape
// coinCenter.js already uses (requestId -> {result, time}), reused here
// rather than inventing a second pattern. A requestId is OPTIONAL and
// additive: an old/updated client that never sends one behaves exactly as
// before (every send is processed) — this only closes the gap once the
// client (updated below, in public/app.js) starts sending one per tap.
// Swept periodically so this can never grow unbounded.
const giftRequestCache = {}; // requestId -> { time }
const GIFT_REQUEST_TTL_MS = 5 * 60 * 1000; // 5 minutes — comfortably longer than any retry window
function isDuplicateGiftRequest(requestId) {
    if (!requestId) return false; // no requestId supplied — nothing to dedupe against, process normally
    if (giftRequestCache[requestId]) return true;
    giftRequestCache[requestId] = { time: Date.now() };
    return false;
}

// Persistent gift transaction key used by gift history/rankings. A client
// requestId is only an idempotency seed; target/gift details make each
// recipient charge a distinct transaction in a multi-recipient send.
function makeGiftTransactionId(requestId, senderId, targetId, giftId, quantity) {
    const seed = requestId || ("auto_" + Date.now().toString(36) + "_" + crypto.randomBytes(8).toString("hex"));
    return "gift_" + crypto.createHash("sha256")
        .update([seed, senderId || "", targetId || "", giftId || "", quantity || 1].join("|"))
        .digest("hex");
}
setInterval(() => {
    const cutoff = Date.now() - GIFT_REQUEST_TTL_MS;
    for (const id in giftRequestCache) {
        if (giftRequestCache[id].time <= cutoff) delete giftRequestCache[id];
    }
}, 60 * 1000).unref();

// ---------- Gift History (permanent) + Room Ranking ----------
// Additive, read-only-to-the-rest-of-the-app system: nothing above writes
// to it, nothing about how gifts are sent/priced/deducted changes because
// of it. It only ever gets appended to, right after a gift already
// succeeded (coins deducted, recipient credited) — so it can never contain
// a failed, cancelled, or refunded gift.
let giftHistory = safeRead(GIFT_HISTORY_FILE, []);
// In-memory index for fast per-room ranking lookups without scanning the
// entire (permanent, ever-growing) history on every request.
const giftHistoryByRoom = {};
giftHistory.forEach((entry) => {
    if (!entry.roomId) return;
    (giftHistoryByRoom[entry.roomId] = giftHistoryByRoom[entry.roomId] || []).push(entry);
});
function saveGiftHistory() { safeWrite(GIFT_HISTORY_FILE, giftHistory); }

// Phase 3 (Agency & Host System) hooks into gift recording here instead of
// at every call site that records a gift — recordGiftHistory() is the one
// place a gift is guaranteed to have already succeeded, so it's the single
// safe place to notify Host Center / Agency Center listeners without
// touching wallet/gift-send logic at all. See agencyHost.js.
let onGiftRecordedHooks = [];
function registerGiftRecordedHook(fn) { onGiftRecordedHooks.push(fn); }

// entry: { senderId, receiverId, roomId, hostId, agencyId, giftName, diamondAmount }
function recordGiftHistory(entry) {
    if (!entry.senderId || !entry.diamondAmount || entry.diamondAmount <= 0) return null;

    // Persistent idempotency: a transaction already present in the permanent
    // history can never be counted a second time after a restart/retry.
    const transactionId = entry.transactionId || ("gift_" + Date.now().toString(36) + "_" + crypto.randomBytes(8).toString("hex"));
    const existing = giftHistory.find((g) => g.transactionId === transactionId);
    if (existing) return existing;

    const record = {
        giftHistoryId: "gh_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex"),
        transactionId,
        status: "confirmed",
        senderId: entry.senderId,
        receiverId: entry.receiverId || null,
        roomId: entry.roomId || null,
        hostId: entry.hostId || null,
        agencyId: entry.agencyId || null,
        giftName: entry.giftName || "",
        giftId: entry.giftId || null,
        quantity: Math.max(1, Number(entry.quantity) || 1),
        diamondAmount: Number(entry.diamondAmount),
        timestamp: new Date().toISOString()
    };
    giftHistory.push(record);
    if (record.roomId) (giftHistoryByRoom[record.roomId] = giftHistoryByRoom[record.roomId] || []).push(record);
    saveGiftHistory();
    onGiftRecordedHooks.forEach((fn) => { try { fn(record); } catch (err) { console.error("gift-recorded hook error:", err.message); } });
    return record;
}

// Period windows are computed fresh on every call — nothing about "today"
// or "this week" is stored anywhere, so there's nothing that needs an
// explicit reset job; a new day/week/month simply produces a new window
// the next time someone asks.
function periodStart(period) {
    const now = new Date();
    if (period === "daily") {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    }
    if (period === "weekly") {
        // Rolling 7-day window anchored to the Unix epoch, so it resets at
        // the same moment for every room every 7 days.
        const msInWeek = 7 * 24 * 60 * 60 * 1000;
        return Math.floor(now.getTime() / msInWeek) * msInWeek;
    }
    if (period === "monthly") {
        return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    }
    return 0;
}

// Ranks by top gifters (senders) in a room for a period — the standard
// "Room Ranking" / rich-list leaderboard used across live-room apps.
//
// FIX (Room Ranking completeness, 2026-07-29): this used to hard-cap the
// list at 50 (`limit || 50`) and only tracked diamonds/count, so anyone
// past the top 50 — and every bit of "last gift time" info — silently
// disappeared from the popup. Every sender in the period is now included
// (no slice unless a caller explicitly asks for one via `limit`), and each
// row also carries `lastGiftTime` for the tiebreak and optional display.
function computeRoomRanking(roomId, period, limit) {
    const entries = giftHistoryByRoom[roomId] || [];
    const since = periodStart(period);
    const totals = {}; // senderId -> { diamonds, count, lastGiftTime }
    entries.forEach((e) => {
        const ts = new Date(e.timestamp).getTime();
        if (ts < since) return;
        if (!totals[e.senderId]) totals[e.senderId] = { diamonds: 0, count: 0, lastGiftTime: 0 };
        const t = totals[e.senderId];
        t.diamonds += e.diamondAmount;
        t.count += 1;
        if (ts > t.lastGiftTime) t.lastGiftTime = ts;
    });
    let list = Object.entries(totals)
        .map(([senderId, t]) => {
            const found = findUserByUserId(senderId);
            return {
                userId: senderId,
                name: found ? found.user.name : "User",
                photo: found ? (found.user.photo || "") : "",
                totalDiamonds: t.diamonds,
                giftCount: t.count,
                lastGiftTime: new Date(t.lastGiftTime).toISOString()
            };
        })
        // Sort: highest diamonds, then highest gift count, then most recent gift.
        .sort((a, b) =>
            b.totalDiamonds - a.totalDiamonds ||
            b.giftCount - a.giftCount ||
            new Date(b.lastGiftTime).getTime() - new Date(a.lastGiftTime).getTime()
        );
    // No artificial Top-N cap by default — the full ranking is returned.
    // `limit` stays supported (unused by the client today) purely for any
    // future caller that explicitly wants a bounded slice.
    if (limit) list = list.slice(0, limit);
    list.forEach((row, i) => { row.rank = i + 1; });
    return list;
}

function buildRoomRankingPayload(roomId) {
    return {
        roomId,
        daily: computeRoomRanking(roomId, "daily"),
        weekly: computeRoomRanking(roomId, "weekly"),
        monthly: computeRoomRanking(roomId, "monthly")
    };
}

// ---------- Wallet Transactions ----------
let transactions = safeRead(TRANSACTIONS_FILE, []);
// AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): this record used
// to be just {userId, currency, amount, note, time} — no transaction ID
// (nothing to look a specific entry up by / dedupe against), no
// balance-before/after (impossible to reconstruct "was this account ever
// negative" or spot a desync after the fact from the log alone), and no
// status field. Every call site across the codebase always calls this
// AFTER the balance mutation has already happened, so the user's current
// live balance for that currency *is* balanceAfter — no call site needs to
// change to supply it. balanceBefore is then just balanceAfter - amount,
// which is exact because `amount` is already the signed delta everywhere
// this is called. Fully additive: existing fields/shape are unchanged, so
// nothing that reads {userId, currency, amount, note, time} breaks.
//
// Also fixes silent audit-log loss: this used to hard-delete anything past
// the newest 10,000 entries (`.slice(-10000)`), which is a real problem for
// a system meant to keep a permanent financial audit trail (Step 10).
// Trimmed entries are now appended to TRANSACTIONS_ARCHIVE_FILE first, so
// old history is relocated, not destroyed. getTransactions() still returns
// only the live (recent) set by default to keep normal reads fast; a
// separate accessor covers the archive for admin/audit lookups.
let transactionArchive = safeRead(TRANSACTIONS_ARCHIVE_FILE, []);
const TRANSACTIONS_LIVE_CAP = 10000;
function logTransaction(userId, currency, amount, note) {
    const found = findUserByUserId(userId);
    const balanceAfter = found ? (currency === "diamonds" ? found.user.diamonds : found.user.coins) : null;
    const balanceBefore = typeof balanceAfter === "number" ? balanceAfter - amount : null;
    const id = "txn_" + Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
    transactions.push({ id, userId, currency, amount, balanceBefore, balanceAfter, note, status: "completed", time: new Date().toISOString() });
    if (transactions.length > TRANSACTIONS_LIVE_CAP) {
        const overflow = transactions.length - TRANSACTIONS_LIVE_CAP;
        // AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): splice()
        // mutates the existing array in place instead of `transactions =
        // transactions.slice(...)` creating a brand-new array. analyticsHub.js
        // is handed a direct reference to this array once at startup
        // (`initAnalyticsHub({ transactions, ... })`) — reassigning the
        // variable here would leave that module holding a reference to the
        // old array forever, silently frozen from the first trim onward,
        // while every other consumer (which re-reads the module-level
        // `transactions` variable by name) kept working fine. In-place
        // mutation keeps every holder of the reference in sync.
        transactionArchive.push(...transactions.splice(0, overflow));
        safeWrite(TRANSACTIONS_ARCHIVE_FILE, transactionArchive);
    }
    safeWrite(TRANSACTIONS_FILE, transactions);
}
function getTransactions() { return transactions; }
function getTransactionArchive() { return transactionArchive; }

// ---------- Wallet — Coin Seller List. Replaces the Wallet page's old
// "Diamond → Coin Exchange (Admin Approval)" request card. Separate,
// simpler module from Diamond Seller (diamondSeller.js) — no KYC/approval
// workflow; Admin just attaches a real existing user by User ID
// (coin_sellers.json stores only that curated list + display order), and
// every seller-card field is read live from the real user database on
// each request. See coinSellers.js for details.
//
// IMPORTANT — registration order: this MUST be initialized here, before
// the generic `GET /api/wallet/:userId` route below. Express matches
// routes in the order app.get()/app.post() were called, and `:userId` is
// a wildcard that matches ANY single path segment — including the literal
// word "coin-sellers". Registering this module later (as originally done)
// meant every request to GET /api/wallet/coin-sellers was being silently
// swallowed by `/api/wallet/:userId` first (treating "coin-sellers" as a
// literal user ID, which obviously doesn't exist, so it always responded
// with {success:false, message:"User not found"} before this route
// ever got a chance to run). That was the root cause of the Wallet page
// always showing an empty Coin Seller List even after a successful
// Admin-panel add (the Admin routes live under /api/admin/coin-sellers/*,
// a completely different path, which is why adding always appeared to
// work fine). Keep this block above the /api/wallet/:userId route.
const { initCoinSellers } = require("./coinSellers.js");
initCoinSellers({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, getTransactions,
    io, socketsByUserId,
    rbac, requireAdmin, requirePermission, reqUserAgent
});

// ---------- Real winner feed (Food Wheel / Teen Patti) ----------
// In-memory only (not persisted) — a rolling list of real coin wins so the
// in-game ticker/top-list can show actual players instead of the old
// hardcoded demo names. Populated from game-wheel-sync below.
let recentGameWins = [];
function recordGameWin(name, coins, game) {
    const entry = { name, coins, game, time: new Date().toISOString() };
    recentGameWins.unshift(entry);
    if (recentGameWins.length > 30) recentGameWins = recentGameWins.slice(0, 30);
    io.emit("real-win", entry);
}

// ---------- Diamond -> Coin Exchange Requests ----------
let exchanges = safeRead(EXCHANGES_FILE, []);

// ---------- Frame Catalog ----------
let frameCatalog = safeRead(FRAME_CATALOG_FILE, [
    { id: "gold-classic", name: "Gold Classic", vipOnly: false, imageUrl: null },
    { id: "royal-flame", name: "Royal Flame", vipOnly: true, imageUrl: null }
]);
function saveFrameCatalog() { safeWrite(FRAME_CATALOG_FILE, frameCatalog); }
let themeLibrary = safeRead(THEME_LIBRARY_FILE, []); // [{ id, name, url }]
function saveThemeLibrary() { safeWrite(THEME_LIBRARY_FILE, themeLibrary); }

// ---------- Video Gift Catalog (admin-controlled, global, real-time) ----------
const MIN_VIDEO_GIFT_PRICE = 100000; // coins
let videoGiftCatalog = safeRead(VIDEO_GIFTS_FILE, []);
function saveVideoGiftCatalog() { safeWrite(VIDEO_GIFTS_FILE, videoGiftCatalog); }
// Only what regular users' Gift Box should ever see — never the disabled ones.
function publicVideoGiftCatalog() { return videoGiftCatalog.filter((g) => g.enabled !== false); }
// Broadcast to every connected socket app-wide (not just one room) so every
// user's Gift Box "Custom" tab updates instantly without a refresh.
function broadcastVideoGiftCatalog() { io.emit("video-gift-catalog", publicVideoGiftCatalog()); }

// ---------- Agencies ----------
let agencies = safeRead(AGENCIES_FILE, {});
function saveAgencies() { safeWrite(AGENCIES_FILE, agencies); }
// Country Data Isolation (RBAC Phase 2) — backfill legacy agencies (created
// before this field existed) into the "OTHERS" bucket, same fallback used
// for users/rooms above, so they stay visible to Owner/Global Super Admin
// and to whichever country an Owner later reassigns them to.
Object.values(agencies).forEach((a) => {
    if (!a.countryId || !rbac.COUNTRY_IDS.includes(a.countryId)) a.countryId = "OTHERS";
});

// ---------- Announcements ----------
let announcements = safeRead(ANNOUNCEMENTS_FILE, []);

// ==================================================
// LIVE ROOM TREASURE CHEST
// ==================================================
const CHEST_CONFIG_FILE = path.join(DATA_FOLDER, "chest_config.json");

let chestLevels = safeRead(CHEST_CONFIG_FILE, [
    { level: 1, target: 100000, rewardPool: [ { type: "coins", amount: 500 }, { type: "coins", amount: 1000 }, { type: "diamonds", amount: 200 } ] },
    { level: 2, target: 300000, rewardPool: [ { type: "coins", amount: 2000 }, { type: "diamonds", amount: 500 }, { type: "diamonds", amount: 800 } ] },
    { level: 3, target: 800000, rewardPool: [ { type: "diamonds", amount: 1500 }, { type: "diamonds", amount: 3000 }, { type: "coins", amount: 5000 } ] }
]);
function saveChestLevels() { safeWrite(CHEST_CONFIG_FILE, chestLevels); }

const CHEST_DAY_MS = 24 * 60 * 60 * 1000;

function freshChestState() {
    return { level: 1, contributed: 0, openedLevels: [], contributors: {}, resetAt: new Date(Date.now() + CHEST_DAY_MS).toISOString() };
}

function ensureChestFresh(room) {
    if (!room.treasureChest) room.treasureChest = freshChestState();
    if (new Date(room.treasureChest.resetAt).getTime() <= Date.now()) {
        room.treasureChest = freshChestState();
    }
    return room.treasureChest;
}

function contributeToChest(room, userId, userName, diamondAmount) {
    if (!room || diamondAmount <= 0) return null;
    const chest = ensureChestFresh(room);
    chest.contributed += diamondAmount;
    chest.contributors[userId] = (chest.contributors[userId] || 0) + diamondAmount;

    const openedNow = [];
    while (chest.level <= chestLevels.length) {
        const cfg = chestLevels[chest.level - 1];
        if (!cfg || chest.contributed < cfg.target) break;
        const reward = cfg.rewardPool[crypto.randomInt(0, cfg.rewardPool.length)];
        chest.openedLevels.push(cfg.level);
        openedNow.push({ level: cfg.level, reward });
        chest.level += 1;
    }
    return openedNow.length ? openedNow : null;
}

function topChestContributors(chest, n) {
    return Object.entries(chest.contributors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([userId, amount]) => {
            const found = findUserByUserId(userId);
            return { userId, name: found ? found.user.name : "User", amount };
        });
}

function applyChestReward(userId, reward) {
    const found = findUserByUserId(userId);
    if (!found) return;
    if (reward.type === "coins") {
        // AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): this credit
        // path had no ceiling — every other coin-increasing path (admin
        // edit, game-wheel-sync, fruit-wheel-payout) now clamps, so this one
        // is brought in line for consistency (rewards are small and
        // server-rolled here, so this is defense-in-depth, not a fix for an
        // observed exploit).
        found.user.coins = clampCoinBalance(userId, found.user.coins + reward.amount, "chest-reward");
        // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
        logTransaction(userId, "coins", reward.amount, "Treasure Chest reward");
    } else if (reward.type === "diamonds") {
        found.user.diamonds = clampDiamondBalance(userId, found.user.diamonds + reward.amount, "chest-reward");
        found.user.vipLevel = vipLevelFromDiamonds(found.user.diamonds);
        logTransaction(userId, "diamonds", reward.amount, "Treasure Chest reward");
    }
    saveUsers();
}

// Push the user's current coins/diamonds/level/vipLevel to their own socket
// only (never broadcast to the room) — this is what makes every wallet-
// touching action (gifts, chest rewards, admin edits, exchanges) show up
// instantly everywhere the balance is displayed, with no refresh needed.
function pushWalletUpdate(userId) {
    const found = findUserByUserId(userId);
    if (!found) return;
    emitToUser(userId, "wallet-update", { // GAP #1 — cross-instance-safe
        coins: found.user.coins,
        diamonds: found.user.diamonds,
        level: found.user.level,
        vipLevel: found.user.vipLevel
    });
}

// ---------- Admin Coin Center (additive module, see coinCenter.js) ----------
const { initCoinCenter } = require("./coinCenter.js");
const coinCenter = initCoinCenter({ DATA_FOLDER, safeRead, safeWrite, io, socketsByUserId, emitToUser, findUserByUserId, saveUsers, users, logTransaction, pushWalletUpdate, levelFromCoins, clampCoinBalance, normalizeMobile });

// ---------- Home Banner System (additive) ----------
const { initBannerManagement } = require("./bannerManagement.js");
const bannerManagement = initBannerManagement({ DATA_FOLDER, safeRead, safeWrite });

app.get("/api/chest/config", (req, res) => {
    res.json({ success: true, levels: chestLevels });
});

app.post("/api/admin/chest/config", requireAdmin, requirePermission("chest:manage"), (req, res) => {
    const { levels } = req.body;
    if (!Array.isArray(levels) || !levels.length) {
        return res.json({ success: false, message: "Provide a valid levels array" });
    }
    const before = chestLevels;
    chestLevels = levels;
    saveChestLevels();
    console.log(`🎁 Chest levels updated by admin: ${levels.map((l) => l.target).join(", ")}`);
    rbac.logAction({ admin: req.adminAccount, action: "chest-config-update", module: "chest", targetType: "chestConfig", before, after: chestLevels, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, levels: chestLevels });
});

// ---------- Room role helpers ----------
function roleForUser(room, userId) {
    if (!room || !userId) return "member";
    if (room.hostId === userId) return "owner";
    if ((room.adminIds || []).includes(userId)) return "admin";
    return "member";
}
// MODULE 5.2: safe :roomId / :groupId lookups — see isSafeObjectKey() in
// security/validation.js for why this guard exists. Read-only stores
// (rooms, groupsStore) so this only ever prevents a bad/format-invalid id
// from resolving to something unexpected; it changes no other behavior
// for any real roomId/groupId, which are always server-generated.
function safeRoomLookup(roomId) {
    return isSafeObjectKey(roomId) ? rooms[roomId] : undefined;
}
function safeGroupLookup(groupId) {
    return isSafeObjectKey(groupId) ? groupsStore[groupId] : undefined;
}

function isOwnerOrAdmin(room, userId) {
    if (isGodPowerHolder(userId)) return true;
    return !!room && (room.hostId === userId || (room.adminIds || []).includes(userId));
}

// MODULE 5.2: lightweight abuse guard for host/admin moderation socket
// events (kick-user, set-admin, mod-*). These were already fully
// authorization-gated (isOwnerOrAdmin above), but had no rate limit at
// all — a compromised/scripted host or admin token could fire an
// unbounded number of room-wide broadcasts per second. Reuses the same
// aiSecurity.isRateLimited() infra already used for chat/emoji-reaction
// (no new/duplicate rate-limit system). One shared key per user across
// all moderation actions, not per-event, so legitimate rapid moderation
// (e.g. muting 10 people one after another, then banning one from chat)
// isn't artificially split into separate small buckets. Limit is
// deliberately generous — 20 actions per 5s is far beyond normal human
// moderation pace but well below spam/DoS territory.
function isModActionRateLimited(userId) {
    return aiSecurity.isRateLimited(`mod-action:${userId}`, { windowMs: 5000, max: 20 });
}

// ==================================================
// GOD POWER SYSTEM (Super Admin panel feature)
// ==================================================
// Three flags on a user record:
//   is_immune      — can't be Kicked/Muted/Blocked/Removed/Force-Moved by anyone
//   can_manage_all — full moderation override in every room (bypasses owner/admin checks)
//   is_invisible   — permission to Hide/Unhide from member & room lists (actual
//                    hidden state is the separate `invisibleActive` toggle)
const GOD_POWER_MAX = 10;
function godPowerHolders() {
    return Object.entries(users)
        .filter(([, u]) => u.is_immune)
        .map(([mobile, u]) => ({ mobile, userId: u.userId, name: u.name, photo: u.photo || "" }));
}
function isGodPowerHolder(userId) {
    const found = findUserByUserId(userId);
    return !!(found && found.user.can_manage_all);
}
function isImmuneUser(userId) {
    const found = findUserByUserId(userId);
    return !!(found && found.user.is_immune);
}
function isHiddenUser(userId) {
    const found = findUserByUserId(userId);
    return !!(found && found.user.is_invisible && found.user.invisibleActive);
}
function rejectImmune(socket) {
    io.to(socket.id).emit("room-error", { message: "Request Rejected — Target User is Immune" });
}

function syncProfileToRoom(userId) {
    const sid = socketsByUserId[userId];
    if (!sid) return;
    const s = io.sockets.sockets.get(sid);
    if (!s || !s.currentRoom) return;
    const room = rooms[s.currentRoom];
    if (!room) return;
    const found = findUserByUserId(userId);
    if (!found) return;
    const { name, photo } = found.user;
    room.onlineUsers.forEach((u) => { if (u.userId === userId) { u.userName = name; u.userPhoto = photo; } });
    room.seats.forEach((seat) => { if (seat && seat.userId === userId) { seat.userName = name; seat.userPhoto = photo; } });
    io.to(s.currentRoom).emit("room-profile-style-update", {
        userId,
        customTag: found.user.customTag || null,
        nameEffect: found.user.nameEffect || null,
        activeFrame: found.user.activeFrame || null,
        vipLevel: found.user.vipLevel || 0,
        activeBadges: found.user.activeBadges || []
    });
    io.to(s.currentRoom).emit("room-state", publicRoom(room));
}

// ==================================================
// AUTH: Mobile + OTP
// ==================================================
// Fix (one phone number should always open exactly one account): mobile
// numbers were used as the raw, un-normalized object key everywhere. If the
// same person ever typed their number slightly differently between logins
// (leading "+91", a stray space, a dash from copy-pasting) they'd land on a
// *different* key in `users`, which looks exactly like "my account keeps
// getting logged out / replaced" even though nothing was actually deleted —
// they'd just quietly created a second account. Normalizing to the last 10
// digits before every lookup/store guarantees one number = one account.
function normalizeMobile(mobile) {
    const digits = String(mobile || "").replace(/\D/g, "");
    return digits.slice(-10);
}

// ==================================================
// CANONICAL USER KEY RESOLUTION (2026-08-03 full auth audit)
// ==================================================
// Single source of truth for "which account is this request about",
// used by every endpoint that looks up an EXISTING account. This is what
// fixed the complete-profile "User not found" bug and is now applied
// project-wide so the same class of bug (re-normalizing an already-
// canonical key) can't recur in any other endpoint, present or future.
//
// A canonical key is issued exactly once, at the moment an account is
// created (verify-otp / set-password / firebase-login), and is NEVER
// transformed again anywhere else in the codebase:
//   Phone users:  users["9876543210"]   (bare 10 digits — see normalizeMobile)
//   Google users: users["google:<firebaseUid>"]
// The client always holds and echoes back the exact string the server
// itself returned as `user.mobile` at login, so every later lookup only
// needs to read it verbatim — never re-derive, trim, or "clean" it.
// normalizeMobile() is reserved for turning RAW, user-typed phone input
// into a key at the initial authentication boundaries. Authenticated
// profile/password endpoints use req.authedMobile instead of re-normalizing
// client-supplied identity values.
// /api/auth/send-otp, /api/auth/verify-otp, /api/auth/login-password,
// plus the phone branch inside
// /api/auth/firebase-login (which normalizes Firebase's own
// decoded.phone_number — also raw input from Firebase's perspective).
// No other endpoint may call normalizeMobile() on a mobile/key value.
//
// Priority order:
//   1. req.authedMobile — set by userAuth.requireUserAuth after verifying
//      the session token; cannot be spoofed by the client and is already
//      the exact key resolved once at login. Strongest source.
//   2. req.body.mobile   — client-echoed canonical key (POST endpoints not
//      yet migrated to token auth, per the incremental plan in
//      security/userAuth.js).
//   3. req.params.mobile — canonical key embedded in the URL (GET routes).
//   4. req.query.mobile  — rare, same principle, for completeness.
// Public/API response projection. User records may contain credentials or
// other server-only fields (for example passwordHash). Never serialize those
// fields to a browser, even on an endpoint that otherwise needs to return the
// full application profile object.
function publicUserView(user) {
    if (!user || typeof user !== "object") return user;
    const copy = { ...user };
    delete copy.passwordHash;
    delete copy.password;
    delete copy.authToken;
    delete copy.otp;
    delete copy.otpExpiresAt;
    delete copy.resetToken;
    return copy;
}

function resolveUserKey(req) {
    if (req.authedMobile) return req.authedMobile;
    if (req.body && typeof req.body.mobile === "string" && req.body.mobile) return req.body.mobile;
    if (req.params && typeof req.params.mobile === "string" && req.params.mobile) return req.params.mobile;
    if (req.query && typeof req.query.mobile === "string" && req.query.mobile) return req.query.mobile;
    return "";
}

// SELF-HOSTED OTP + LOCAL SMS GATEWAY (2026-08-16)
// ---------------------------------------------------------------
// This is now the ONLY phone-login path: no Firebase, no third-party SMS
// API. OTP is generated/hashed/stored/verified entirely by this server
// (security/otpService.js) and delivered exclusively through this
// device's own Android/Termux SIM (sms/gateway.js -> sms/localGateway.js).
// See docs/LOCAL_SMS_GATEWAY.md for the Termux:API setup this depends on.
app.post("/api/auth/send-otp", otpLimiter, async (req, res) => {
    const OTP_TEST_MODE = String(process.env.OTP_TEST_MODE || "").trim().toLowerCase() === "true";
    const OTP_TEST_CODE = String(process.env.OTP_TEST_CODE || "123456").trim();

    try {
        const mobile = normalizeMobile(req.body.mobile);
        if (!mobile || mobile.length !== 10) {
            return res.json({ success: false, message: "Enter a 10 digit mobile number" });
        }
        const existing = otpService.getActiveOtp ? otpService.getActiveOtp(mobile) : null;
        const issued = existing || otpService.issueOtp(mobile);
        if (issued.error) {
            // Resend cooldown — a previous OTP for this number was issued
            // less than OTP_RESEND_COOLDOWN_SECONDS ago and is still valid.
            return res.json({
                success: false,
                code: issued.error.code,
                retryAfterSec: issued.error.retryAfterSec,
                message: `আবার OTP চাওয়ার আগে ${issued.error.retryAfterSec} সেকেন্ড অপেক্ষা করুন`
            });
        }
        if (OTP_TEST_MODE || process.env.NODE_ENV === "production") {
            console.log(`[otp-test] Test OTP ready for ${otpService.maskMobile(mobile)}`);
            return res.json({ success: true, message: "OTP sent.", testMode: true });
        }

        const ttlMin = Math.max(1, Math.round(otpService.OTP_TTL_MS / 60000));
        const smsText = `${APP_NAME} verification code: ${issued.otp}\nValid for ${ttlMin} minutes.\nDo not share this code.`;
        const smsResult = await smsGateway.sendSms({ to: "+91" + mobile, message: smsText });
        if (!smsResult.success) {
            // Never mark an OTP as delivered if the local SMS gateway did
            // not actually accept the send — invalidate it immediately so
            // it can't be silently reused, and let the client retry once
            // the gateway (Termux:API / SIM / permissions) is working.
            otpService.revokeOtp(mobile, issued.requestId);
            console.error(`[otp] SMS gateway send failed for ${otpService.maskMobile(mobile)}: ${smsResult.error}`);
            return res.json({
                success: false,
                code: "sms-gateway-unavailable",
                message: "SMS gateway এই মুহূর্তে উপলব্ধ নেই — কিছুক্ষণ পরে আবার চেষ্টা করুন।"
            });
        }
        console.log(`[otp] SMS gateway requested for ${otpService.maskMobile(mobile)}`);
        console.log(`[otp] SMS gateway accepted`);
        res.json({ success: true, message: "OTP sent." });
    } catch (err) {
        console.error("send-otp error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post("/api/auth/verify-otp", authLimiter, (req, res) => {
    try {
        const OTP_TEST_MODE = String(process.env.OTP_TEST_MODE || "").trim().toLowerCase() === "true";
        const OTP_TEST_CODE = String(process.env.OTP_TEST_CODE || "123456").trim();
        const mobile = normalizeMobile(req.body.mobile);
        // Phase 10: brute-force lockout — 6-digit OTP is guessable if
        // someone can hammer this endpoint unlimited times for one mobile.
        // This is on top of otpService's own per-OTP attempt cap.
        const lock = bruteForce.checkLocked("otp:" + mobile);
        if (lock.locked) {
            return res.json({ success: false, message: `Too many wrong OTP attempts — try again in ${lock.retryAfterSec}s` });
        }
        const { otp } = req.body;
        const result = OTP_TEST_MODE && String(otp || "").trim() === OTP_TEST_CODE
            ? { success: true }
            : otpService.verifyOtp(mobile, otp);
        if (!result.success) {
            bruteForce.recordFailure("otp:" + mobile);
            if (result.code === "expired") {
                return res.json({ success: false, code: "expired", message: "OTP-এর মেয়াদ শেষ — নতুন OTP চান" });
            }
            if (result.code === "too-many-attempts") {
                return res.json({ success: false, code: "too-many-attempts", message: "অনেকবার ভুল OTP দেওয়া হয়েছে — নতুন OTP চান" });
            }
            if (result.code === "not-found") {
                return res.json({ success: false, code: "not-found", message: "কোনো OTP পাওয়া যায়নি — আগে OTP চান" });
            }
            return res.json({ success: false, code: "wrong-otp", message: "ভুল OTP — আবার চেষ্টা করুন" });
        }
        bruteForce.recordSuccess("otp:" + mobile);
        if (users[mobile]) {
            if (users[mobile].banned) {
                console.log(`⛔ Login blocked (banned): ${users[mobile].name} (ID: ${users[mobile].userId})`);
                return res.json({ success: false, message: "Your account has been banned" });
            }
            console.log(`✅ Login: ${users[mobile].name} (ID: ${users[mobile].userId}), mobile ${mobile}`);
            svip.onUserLoaded(users[mobile]);
            // Phase 14: issue a session token alongside the existing response shape.
            // Purely additive — old client builds that don't read `authToken`
            // keep working exactly as before; no endpoint requires it yet.
            const authToken = userAuth.issueToken(mobile);
            return res.json({ success: true, user: publicUserView(users[mobile]), authToken });
        }
        const userId = generateUniqueUserId();
        const newUser = {
            userId,
            name: `User_${userId}`,
            mobile,
            photo: "",
            followers: 0,
            following: 0,
            followersList: [],
            followingList: [],
            visitors: 0,
            coins: 100,
            diamonds: NEW_USER_STARTING_DIAMONDS,
            level: 1,
            // FIX (Level System rewrite, 2026-07-29): this used to grant a
            // free idLevel of 1 to every new signup even though they've
            // sent zero gifts — a direct violation of "level increases
            // ONLY from a successful room gift send". A brand-new user now
            // starts unranked (idLevel 0) and only reaches Level 1 the
            // moment their first room gift crosses the 5,000 threshold.
            idLevel: 0,
            lifetimeGiftSent: 0,
            vipLevel: vipLevelFromDiamonds(NEW_USER_STARTING_DIAMONDS),
            banned: false,
            verified: false,
            agencyId: null,
            isHost: false,
            isCoinCenter: false,
            activeFrame: null,
            customTag: null,
            nameEffect: null,
            lastDailyRewardAt: null,
            lastWeeklyRewardAt: null,
            recentRooms: [],
            groups: [],
            countryId: "OTHERS", // see country-isolation note near the users-load migration loop above
            // First Time Profile Setup (new user only) — client shows the
            // Create Your Profile screen right after this OTP login as long
            // as this is false, then never again once it's true.
            profile_completed: false,
            gender: null,
            country: null,
            language: "bn"
        };
        users[mobile] = newUser;
        userIndex.indexUser(mobile, newUser); // Phase 11: keep O(1) lookup index in sync
        svip.ensureUserSvipFields(newUser);
        // BUG FIX (login-lost-on-restart / "refresh sends me back to login"):
        // a brand-new account used to go through the same 250ms-debounced
        // save as every other users.json write. That's fine for
        // high-frequency changes (coin updates, follows, etc.) but a
        // freshly created account is low-frequency and high-value — and on
        // this deployment the server and the browser run on the same
        // phone, where Android can and does kill a background Termux
        // process outright (battery saver / Doze / low-memory) with no
        // graceful SIGTERM. If that happens inside the debounce window, the
        // brand-new account never lands on disk even though login just
        // succeeded — so the very next refresh finds no matching user and
        // bounces back to the login screen. Writing synchronously here
        // closes that window, mirroring the same fix already applied to
        // token issuance in security/userAuth.js.
        saveUsers({ immediate: true });
        console.log(`✅ New User Created: ${newUser.name} (ID: ${newUser.userId}), Mobile: ${mobile}`);
        const authToken = userAuth.issueToken(mobile);
        res.json({ success: true, user: publicUserView(newUser), authToken });
    } catch (err) {
        console.error("verify-otp error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ---------- Firebase Login (Phone OTP / Google) — Migration Phase B ----------
// Purely additive, sits next to /api/auth/send-otp + /api/auth/verify-otp
// above, which are UNCHANGED and still fully functional. This endpoint is
// an alternate front door into the exact same `users` store and the exact
// same session layer (userAuth.issueToken) — a user who logs in here gets
// an identical { success, user, authToken } response shape to the old OTP
// flow, so no downstream code (coins, rooms, sockets, admin) needs to know
// or care which door a user came through.
//
// Identity resolution:
//   - Phone-based Firebase login (Phone Auth) -> normalizeMobile() the
//     verified phone_number, exactly like the OTP flow. This means a user
//     who previously signed up via the OLD OTP system and now logs in via
//     Firebase Phone Auth with the SAME number lands on their SAME
//     existing account (same coins/diamonds/profile) — nothing is
//     duplicated or lost.
//   - Google Sign-In with no phone number on the Firebase account -> no
//     natural mobile-shaped key exists, so we use a synthetic, stable key
//     derived from the Firebase UID (`google:<uid>`) and remember the
//     mapping in data/firebaseLinks.json purely for auditability (the key
//     is already deterministic from the uid, so lookups don't strictly
//     need the file, but it gives admins a readable trail).
const FIREBASE_LINKS_FILE = path.join(DATA_FOLDER, "firebaseLinks.json");
let firebaseLinks = {}; // firebaseUid -> mobile-shaped key we created for them
try {
    if (fs.existsSync(FIREBASE_LINKS_FILE)) {
        firebaseLinks = JSON.parse(fs.readFileSync(FIREBASE_LINKS_FILE, "utf8"));
    }
} catch (err) {
    console.error("❌ Failed to load firebaseLinks.json — starting empty:", err.message);
}
function saveFirebaseLinks() {
    try {
        safeWrite(FIREBASE_LINKS_FILE, firebaseLinks, { immediate: true });
    } catch (err) {
        console.error("❌ Failed to persist firebaseLinks.json:", err.message);
    }
}

// ROOT CAUSE FIX (2026-08-12, "duplicate account on concurrent Firebase
// login"): two requests carrying an ID token for the same Firebase UID can
// both be awaiting verifyFirebaseToken() at once. Each resumes independently
// afterward, so without serialization both could run the
// CHECK(users[mobile]) -> CREATE(users[mobile] = newUser) -> SAVE sequence
// concurrently. This in-process keyed mutex forces every firebase-login
// request for the same resolved identity to run one at a time, so the
// second one always observes the first one's write in the CHECK step.
// NOTE (scope): `users` is this process's own in-memory object (loaded via
// safeRead(USERS_FILE, {})), not a shared/Redis-backed store, so this lock
// covers the real-world race (concurrent requests within one running
// server). If this deployment is ever scaled to multiple Node processes/
// containers sharing nothing but the users JSON file, this in-process lock
// cannot serialize across processes — that would need the users store
// migrated to a shared backend (e.g. the Postgres/Redis already present in
// docker-compose.production.yml) with an atomic upsert. Flagged here rather
// than silently assumed away.
const firebaseLoginLocks = new Map(); // key -> Promise chain tail

function withFirebaseLoginLock(key, fn) {
    const prior = firebaseLoginLocks.get(key) || Promise.resolve();
    const run = prior.then(fn, fn);
    // Keep the chain alive for this key regardless of success/failure, and
    // clear it once this is the last queued call so the map doesn't leak.
    const settled = run.then(() => {}, () => {});
    firebaseLoginLocks.set(key, settled);
    settled.finally(() => {
        if (firebaseLoginLocks.get(key) === settled) firebaseLoginLocks.delete(key);
    });
    return run;
}

app.post("/api/auth/firebase-login", authLimiter, async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) return res.json({ success: false, message: "Missing Firebase ID token" });

        let decoded;
        try {
            decoded = await firebaseAuth.verifyFirebaseToken(idToken);
        } catch (err) {
            // ROOT-CAUSE FIX (2026-08-04): this used to return the exact same
            // generic "Invalid or expired Firebase session" message no matter
            // WHY verification failed — including when the server simply had
            // no Firebase Admin credentials configured yet, which meant the
            // message could appear on 100% of login attempts, permanently,
            // not just on a genuinely stale token. Requirement #12: always
            // log the real code server-side. Requirement #3/#5: give the
            // client a machine-readable `code` so it can silently retry once
            // with a force-refreshed token on a real expiry (see
            // finishFirebaseLogin() in public/app.js) instead of showing an
            // error the very first time.
            console.log(`🔍 [FIREBASE-AUTH] token verification failed: code=${err.code || "unknown"} message=${err.message}`);
            if (err.code === "server/not-configured") {
                // Not the user's fault at all — nothing to "sign in again"
                // for. Distinct message so this is never confused with an
                // actual expired-session case during support/debugging.
                return res.json({ success: false, code: "server-not-configured", message: "Server-এ Firebase configure করা নেই — Admin-কে জানান (FIREBASE_SERVICE_ACCOUNT_BASE64 .env-এ সেট করা হয়নি)।" });
            }
            if (err.code === "auth/id-token-expired") {
                return res.json({ success: false, code: "token-expired", message: "সেশনের মেয়াদ শেষ — আবার সাইন ইন করুন" });
            }
            if (err.code === "auth/id-token-revoked") {
                return res.json({ success: false, code: "token-revoked", message: "আপনার সেশন অন্য কোথাও থেকে লগ-আউট করা হয়েছে — আবার সাইন ইন করুন" });
            }
            if (err.code === "auth/argument-error" || err.code === "auth/invalid-id-token") {
                return res.json({ success: false, code: "token-malformed", message: "সেশন সঠিক নয় — আবার সাইন ইন করুন" });
            }
            return res.json({ success: false, code: "token-invalid", message: "Invalid or expired Firebase session — please sign in again" });
        }

        const uid = decoded.uid;
        // Serialize everything from identity resolution through
        // create+save for this UID — see withFirebaseLoginLock above.
        await withFirebaseLoginLock(uid, async () => {
        // ROOT CAUSE FIX (2026-08-03, "Google Sign-In succeeds but shows
        // User not found"): identity resolution used to be inferred purely
        // from the PRESENCE of decoded.phone_number, with no check of which
        // provider actually authenticated this token. Branch explicitly on
        // decoded.firebase.sign_in_provider (the real source of truth for
        // which flow authenticated this token) per spec — phone-provider
        // tokens match/create by normalized phone number (req. #5), every
        // other provider (google.com, etc.) matches/creates by Firebase UID
        // (req. #6) — with phone_number kept only as a same-provider
        // fallback, never used to override an explicit non-phone provider.
        const signInProvider = decoded.firebase && decoded.firebase.sign_in_provider;
        let mobile;
        if (signInProvider === "phone" || (!signInProvider && decoded.phone_number)) {
            mobile = normalizeMobile(decoded.phone_number);
        } else if (firebaseLinks[uid]) {
            mobile = firebaseLinks[uid];
        } else {
            mobile = `google:${uid}`;
            firebaseLinks[uid] = mobile;
            saveFirebaseLinks();
        }
        console.log(`🔍 [FIREBASE-AUTH] verified token: uid=${uid}, provider=${signInProvider || "unknown"}, resolved key=${mobile}, existingUser=${!!users[mobile]}`);

        if (users[mobile]) {
            if (users[mobile].banned) {
                console.log(`⛔ Firebase login blocked (banned): ${users[mobile].name} (ID: ${users[mobile].userId})`);
                return res.json({ success: false, message: "Your account has been banned" });
            }
            console.log(`✅ Firebase Login: ${users[mobile].name} (ID: ${users[mobile].userId}), key ${mobile}`);
            svip.onUserLoaded(users[mobile]);
            const authToken = userAuth.issueToken(mobile);
            return res.json({ success: true, user: publicUserView(users[mobile]), authToken });
        }

        // New user via Firebase — mirrors the new-user block in
        // /api/auth/verify-otp exactly (same starting coins/diamonds/level
        // defaults), so accounts created via either door start identically.
        const userId = generateUniqueUserId();
        const newUser = {
            userId,
            name: decoded.name || `User_${userId}`,
            mobile,
            photo: decoded.picture || "",
            followers: 0,
            following: 0,
            followersList: [],
            followingList: [],
            visitors: 0,
            coins: 100,
            diamonds: NEW_USER_STARTING_DIAMONDS,
            level: 1,
            idLevel: 0,
            lifetimeGiftSent: 0,
            vipLevel: vipLevelFromDiamonds(NEW_USER_STARTING_DIAMONDS),
            banned: false,
            verified: false,
            agencyId: null,
            isHost: false,
            isCoinCenter: false,
            activeFrame: null,
            customTag: null,
            nameEffect: null,
            lastDailyRewardAt: null,
            lastWeeklyRewardAt: null,
            recentRooms: [],
            groups: [],
            countryId: "OTHERS",
            profile_completed: false,
            gender: null,
            country: null,
            language: "bn"
        };
        users[mobile] = newUser;
        userIndex.indexUser(mobile, newUser);
        svip.ensureUserSvipFields(newUser);
        saveUsers({ immediate: true });
        console.log(`✅ New User Created (Firebase): ${newUser.name} (ID: ${newUser.userId}), key ${mobile}`);
        const authToken = userAuth.issueToken(mobile);
        res.json({ success: true, user: publicUserView(newUser), authToken });
        }); // end withFirebaseLoginLock
    } catch (err) {
        console.error("firebase-login error:", err);
        if (!res.headersSent) res.status(500).json({ success: false, message: "Server error" });
    }
});

// ---------- Password login (alternative to OTP) ----------
// Hashing uses Node's built-in crypto.scrypt (no new dependency). Stored as
// "salt:hash" hex in users[mobile].passwordHash.
function hashPassword(password, salt) {
    salt = salt || crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
    if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
    const [salt, hash] = stored.split(":");
    const check = crypto.scryptSync(String(password), salt, 64).toString("hex");
    try { return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex")); }
    catch (err) { return false; }
}

// Set/create a password for an already authenticated account. Registration
// is deliberately NOT performed here; OTP/Firebase authentication must have
// happened first and must have issued the user session token.
app.post("/api/auth/set-password", userAuth.requireUserAuth, authLimiter, (req, res) => {
    try {
        // A password can only be created by an already authenticated account.
        // This endpoint is not an account-registration endpoint: registration
        // must first pass OTP or Firebase authentication, which issues the
        // session token consumed here. This closes account takeover by
        // claiming an arbitrary phone number and setting its first password.
        const mobile = req.authedMobile;
        const { password } = req.body;
        if (!mobile || !users[mobile]) return res.status(401).json({ success: false, message: "Authenticated user not found" });
        if (!password || String(password).length < 8) {
            return res.json({ success: false, message: "Enter a password with at least 8 characters" });
        }
        if (users[mobile].banned) return res.json({ success: false, message: "Your account has been banned" });
        if (users[mobile].passwordHash) {
            return res.json({ success: false, message: "A password is already set for this account — log in with your password" });
        }

        users[mobile].passwordHash = hashPassword(password);
        saveUsers({ immediate: true });
        const authToken = userAuth.issueToken(mobile);
        res.json({ success: true, user: publicUserView(users[mobile]), authToken });
    } catch (err) {
        console.error("set-password error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// Log in with mobile number + password (the permanent ID). Falls back to
// OTP login (existing endpoints) if no password has been set yet.
app.post("/api/auth/login-password", authLimiter, (req, res) => {
    try {
        const mobile = normalizeMobile(req.body.mobile);
        const lock = bruteForce.checkLocked("pwlogin:" + mobile);
        if (lock.locked) {
            return res.json({ success: false, message: `Too many wrong password attempts — try again in ${lock.retryAfterSec}s` });
        }
        const { password } = req.body;
        const user = users[mobile];
        if (!user || !user.passwordHash) return res.json({ success: false, message: "No password is set for this number — log in with OTP or create a password" });
        if (user.banned) return res.json({ success: false, message: "Your account has been banned" });
        if (!verifyPassword(password, user.passwordHash)) {
            bruteForce.recordFailure("pwlogin:" + mobile);
            return res.json({ success: false, message: "Wrong password" });
        }
        bruteForce.recordSuccess("pwlogin:" + mobile);
        console.log(`✅ Login (password): ${user.name} (ID: ${user.userId}), mobile ${mobile}`);
        svip.onUserLoaded(user);
        const authToken = userAuth.issueToken(mobile);
        res.json({ success: true, user: publicUserView(user), authToken });
    } catch (err) {
        console.error("login-password error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// Phase 14: user logout — revokes the session token server-side so a
// stolen/leaked token can't keep being used after the user logs out. Purely
// additive: not calling this endpoint has no effect on anything else (the
// token just sits unused until its own idle/absolute expiry).
app.post("/api/auth/logout", (req, res) => {
    const header = req.headers["authorization"] || "";
    const bearerToken = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const token = bearerToken || req.body?.authToken;
    if (token) userAuth.revokeToken(token);
    res.json({ success: true });
});

// ---------- First Time Profile Setup (New User Only) ----------
// Feeds the client's Country/Language dropdowns from the single shared
// list in countries.js, so the picker can never drift out of sync with
// what the server will actually accept in /api/user/complete-profile.
app.get("/api/meta/countries", (req, res) => {
    res.json({ success: true, countries: countries.publicCountries() });
});

// Username rules straight from the guideline: 3–20 characters, Bengali,
// English and emoji all allowed (so length is checked in *characters*,
// via Array.from, not UTF-16 code units — otherwise a single emoji could
// silently count as 2 and reject a valid 20-character name), duplicates
// not allowed.
function usernameError(username) {
    if (typeof username !== "string") return "Enter a username";
    const chars = Array.from(username.trim());
    if (chars.length < 3) return "Username must be at least 3 characters";
    if (chars.length > 20) return "Username can be at most 20 characters";
    return null;
}
function isUsernameTaken(username, exceptMobile) {
    const target = username.trim().toLowerCase();
    return Object.entries(users).some(([mobile, u]) => mobile !== exceptMobile && (u.name || "").trim().toLowerCase() === target);
}

// ROOT CAUSE NOTE (2026-08-03, "Google Login succeeds, then Profile Setup
// says User not found"): normalizeMobile() strips every non-digit
// character and keeps only the last 10 digits — correct for a *raw,
// user-typed phone number* at signup, which is the only case it was
// originally written for (see the comment above normalizeMobile()).
// check-username and complete-profile are NOT that case: by the time
// either is called, the account already exists (created at
// /api/auth/firebase-login) and the client is echoing back the exact
// canonical key the server itself issued in `user.mobile` at login —
// which for a Google-authenticated account is the non-phone-shaped
// `google:<firebaseUid>`. Running that through normalizeMobile() strips
// the "google:" prefix and every letter in the UID, leaving an unrelated
// 10-digit fragment that matches no key in `users` — a silent lookup
// failure that surfaces as "User not found" even though the account is
// right there. Fix: every endpoint here now resolves the account through
// the single project-wide resolveUserKey(req) helper (defined next to
// normalizeMobile above) instead of ad hoc req.body.mobile reads.

app.post("/api/user/check-username", userAuth.requireUserAuth, (req, res) => {
    const { username } = req.body;
    const mobile = resolveUserKey(req);
    const err = usernameError(username);
    if (err) return res.json({ success: true, available: false, message: err });
    if (isUsernameTaken(username, mobile)) {
        return res.json({ success: true, available: false, message: "This username is already taken" });
    }
    res.json({ success: true, available: true });
});

// Saves the whole "Create Your Profile" screen in one call — used both for
// the mandatory first-time setup (sets profile_completed = true so the
// screen never shows again) and later from Settings → Edit Profile (which
// resends the same fields after they're already true). Photo/avatar goes
// through the existing /api/user/upload-photo endpoint separately, exactly
// like the rest of the app already does it.
app.post("/api/user/complete-profile", userAuth.requireUserAuth, authLimiter, (req, res) => {
    try {
        const mobile = resolveUserKey(req);
        const u = users[mobile];
        if (!u) return res.json({ success: false, message: "User not found" });
        if (u.banned) return res.json({ success: false, message: "Your account has been banned" });

        const { username, gender, country, language } = req.body;

        const unameErr = usernameError(username);
        if (unameErr) return res.json({ success: false, message: unameErr });
        if (isUsernameTaken(username, mobile)) return res.json({ success: false, message: "This username is already taken" });

        if (!["Male", "Female", "Not Specified"].includes(gender)) {
            return res.json({ success: false, message: "Select a Gender" });
        }

        const countryDef = countries.COUNTRY_BY_ID[country];
        if (!countryDef) return res.json({ success: false, message: "Select a valid Country" });

        const langOk = countryDef.languages.some((l) => l.code === language);
        if (!langOk) return res.json({ success: false, message: "Select a valid Language" });

        u.name = String(username).trim();
        u.gender = gender;
        u.country = country;
        u.language = language;
        // Real country -> the existing 5-bucket RBAC region, so every
        // country-scoped admin account keeps seeing exactly the users it
        // should without any change to rbac.js / the admin panel itself.
        u.countryId = countries.regionForCountry(country);
        u.profile_completed = true;
        saveUsers();
        userIndex.indexUser(mobile, u); // keep the O(1) lookup index's cached copy in sync (name changed)
        syncProfileToRoom(u.userId); // live-update name on any seat they're currently on
        console.log(`✅ Profile setup complete: ${u.name} (ID: ${u.userId}), country: ${country}`);
        res.json({ success: true, user: publicUserView(u) });
    } catch (err) {
        console.error("complete-profile error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post("/api/user/upload-photo", userAuth.requireUserAuth, uploadPhoto.single("photo"), (req, res) => {
    try {
        const mobile = resolveUserKey(req);
        if (!req.file) return res.json({ success: false, message: "No image found" });
        if (!mobile || !users[mobile]) return res.json({ success: false, message: "User not found" });
        const url = "/photos/" + req.file.filename;
        users[mobile].photo = url;
        saveUsers();
        console.log(`✅ Photo updated for ${users[mobile].name}`);
        syncProfileToRoom(users[mobile].userId);
        res.json({ success: true, url });
    } catch (err) {
        console.error("upload-photo error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post("/api/user/update-profile", userAuth.requireUserAuth, (req, res) => {
    try {
        const { name, bio } = req.body;
        const mobile = resolveUserKey(req);
        if (!mobile || !users[mobile]) return res.json({ success: false, message: "User not found" });
        // Phase 10: strip control chars + cap length before this gets stored
        // and later rendered for every viewer of this profile/room.
        if (name && name.trim()) users[mobile].name = sanitizeText(name.trim(), 40);
        if (bio !== undefined) users[mobile].bio = sanitizeText(bio, 300);
        saveUsers();
        syncProfileToRoom(users[mobile].userId);
        res.json({ success: true, user: publicUserView(users[mobile]) });
    } catch (err) {
        console.error("update-profile error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.get("/api/user/:mobile", userAuth.requireUserAuth, (req, res) => {
    const mobile = req.authedMobile;
    if (!mobile || req.params.mobile !== mobile) {
        return res.status(403).json({ success: false, message: "You can only access your own profile" });
    }
    const u = users[mobile];
    // TEMP DIAGNOSTIC (refresh-logout trace, 2026-07-29) — this endpoint is
    // exactly what bootstrap() calls on every page load/refresh to decide
    // whether to restore the cached session. Logging here shows definitively
    // whether the server itself is reporting the account missing (real
    // server-side cause) or the account IS found here (meaning any logout
    // seen by the user is happening client-side, not from this check).
    console.log(`🔍 [SESSION-CHECK] GET /api/user/${mobile} -> ${u ? `FOUND (userId ${u.userId}, banned=${!!u.banned})` : "NOT FOUND"}`);
    if (!u) return res.json({ success: false, message: "User not found" });
    res.json({ success: true, user: publicUserView(u) });
});

app.get("/api/user/by-id/:userId", (req, res) => {
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "User not found" });
    const viewerId = req.query.viewerId;
    if (viewerId && viewerId !== found.user.userId) {
        found.user.visitors = (found.user.visitors || 0) + 1;
        saveUsers();
    }
    res.json({ success: true, user: publicUserView(found.user) });
});

// ==================================================
// FOLLOW SYSTEM
// ==================================================
app.post("/api/user/follow", userAuth.requireUserAuth, (req, res) => {
    try {
        const { targetUserId } = req.body;
        const me = users[resolveUserKey(req)];
        if (!me) return res.json({ success: false, message: "Login info not found" });
        const target = findUserByUserId(targetUserId);
        if (!target) return res.json({ success: false, message: "User not found" });
        if (target.user.userId === me.userId) {
            return res.json({ success: false, message: "You cannot follow yourself" });
        }
        if (!me.followingList.includes(targetUserId)) {
            me.followingList.push(targetUserId);
            me.following = me.followingList.length;
        }
        if (!target.user.followersList.includes(me.userId)) {
            target.user.followersList.push(me.userId);
            target.user.followers = target.user.followersList.length;
        }
        saveUsers();
        res.json({ success: true, user: publicUserView(me) });
    } catch (err) {
        console.error("follow error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.post("/api/user/unfollow", userAuth.requireUserAuth, (req, res) => {
    try {
        const { targetUserId } = req.body;
        const me = users[resolveUserKey(req)];
        if (!me) return res.json({ success: false, message: "Login info not found" });
        const target = findUserByUserId(targetUserId);
        me.followingList = me.followingList.filter((id) => id !== targetUserId);
        me.following = me.followingList.length;
        if (target) {
            target.user.followersList = target.user.followersList.filter((id) => id !== me.userId);
            target.user.followers = target.user.followersList.length;
        }
        saveUsers();
        res.json({ success: true, user: publicUserView(me) });
    } catch (err) {
        console.error("unfollow error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

app.get("/api/user/:mobile/following", userAuth.requireUserAuth, (req, res) => {
    if (!req.authedMobile || req.params.mobile !== req.authedMobile) {
        return res.status(403).json({ success: false, message: "You can only access your own following list" });
    }
    const me = users[req.authedMobile];
    if (!me) return res.json({ success: false, message: "User not found" });
    const list = me.followingList.map((id) => findUserByUserId(id)).filter(Boolean)
        .map((f) => ({ userId: f.user.userId, name: f.user.name, photo: f.user.photo }));
    res.json({ success: true, following: list });
});

app.get("/api/user/:mobile/followers", userAuth.requireUserAuth, (req, res) => {
    if (!req.authedMobile || req.params.mobile !== req.authedMobile) {
        return res.status(403).json({ success: false, message: "You can only access your own followers list" });
    }
    const me = users[req.authedMobile];
    if (!me) return res.json({ success: false, message: "User not found" });
    const list = me.followersList.map((id) => findUserByUserId(id)).filter(Boolean)
        .map((f) => ({ userId: f.user.userId, name: f.user.name, photo: f.user.photo }));
    res.json({ success: true, followers: list });
});

// ==================================================
// HOME SCREEN — Recently / Following / Groups tabs
// ==================================================

// "Recently" tab — rooms this user has visited, newest first.
app.get("/api/recent-rooms/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: "You can only access your own recent rooms" });
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "User not found" });
    const list = (found.user.recentRooms || []).map((e) => {
        const liveRoom = rooms[e.roomId];
        return {
            ...e,
            isLive: !!liveRoom,
            onlineCount: liveRoom ? liveRoom.onlineUsers.filter((u) => !isHiddenUser(u.userId)).length : 0
        };
    });
    res.json({ success: true, recentRooms: list });
});

app.delete("/api/recent-rooms/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: "You can only clear your own recent rooms" });
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "User not found" });
    found.user.recentRooms = [];
    saveUsers();
    res.json({ success: true });
});

// "Following" tab — live/online/offline status of everyone this user follows.
app.get("/api/following-live/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: "You can only access your own following feed" });
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "User not found" });
    const list = (found.user.followingList || []).map((id) => {
        const f = findUserByUserId(id);
        if (!f) return null;
        const liveRoom = Object.values(rooms).find((r) => r.onlineUsers.some((u) => u.userId === id && !isHiddenUser(u.userId)));
        return {
            userId: f.user.userId,
            name: f.user.name,
            photo: f.user.photo || "",
            online: !!socketsByUserId[id],
            live: !!liveRoom,
            roomId: liveRoom ? liveRoom.roomId : null,
            roomNumber: liveRoom ? (liveRoom.roomNumber || liveRoom.hostId) : null,
            roomName: liveRoom ? liveRoom.roomName : null
        };
    }).filter(Boolean);
    res.json({ success: true, following: list });
});

// "Groups" tab — groups this user has joined, with live member/online counts.
app.get("/api/my-groups/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: "You can only access your own groups" });
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "User not found" });
    const list = Object.values(groupsStore)
        .filter((g) => g.memberIds.includes(req.params.userId))
        .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt))
        .map(publicGroup);
    res.json({ success: true, groups: list });
});

// ==================================================
// GIFT SYSTEM
// ==================================================
app.get("/api/gifts/catalog", (req, res) => {
    res.json({ success: true, gifts: publicGiftCatalog() });
});

app.get("/api/gifts/history", (req, res) => {
    const { roomId } = req.query;
    let list = giftLog.slice().reverse();
    if (roomId) list = list.filter((g) => g.roomId === roomId);
    res.json({ success: true, gifts: list });
});

// Phase 15: identity now comes from the verified session token, not the
// client-supplied `mobile` in the body — a gift send moves real coins, so
// this was the highest-priority endpoint to migrate first.
app.post("/api/gifts/send", userAuth.requireUserAuth, (req, res) => {
    try {
        const { targetUserId, giftId, roomId, requestId } = req.body;
        // See isDuplicateGiftRequest() above — same tap/request replayed
        // (client retry, double network send) is ignored before touching
        // any balance, rather than being processed as a second real gift.
        if (isDuplicateGiftRequest(requestId)) {
            return res.json({ success: false, message: "Already processed", duplicate: true });
        }
        const mobile = resolveUserKey(req);
        const sender = users[mobile];
        if (!sender) return res.json({ success: false, message: "Login info not found" });
        const gift = giftCatalog.find((g) => g.id === giftId && g.enabled !== false);
        if (!gift) return res.json({ success: false, message: "Gift not found" });
        if (sender.coins < gift.price) {
            return res.json({ success: false, message: "Not enough coins" });
        }
        const target = findUserByUserId(targetUserId);
        if (!target) return res.json({ success: false, message: "User not found" });
        // AUDIT FIX (2026-07-27, cross-file transaction safety): a gift touches
        // several things in sequence (sender coins, receiver coins, level,
        // lifetime-sent/ID-level, gift log, gift history, chest). Previously
        // saveUsers() ran right after the coin move, so if anything later in
        // this sequence threw, the coin move was already persisted while the
        // rest of the gift's side effects silently never happened — sender
        // loses coins, receiver may or may not have gotten theirs, no gift
        // history row, no XP. Fix: snapshot the two balances up front, defer
        // the actual disk save until the whole sequence has completed without
        // throwing, and restore the in-memory snapshot (so nothing is left
        // half-applied) if any step fails before that point.
        const senderSnapshot = { coins: sender.coins, level: sender.level, lifetimeGiftSent: sender.lifetimeGiftSent, idLevel: sender.idLevel };
        const targetSnapshot = { diamonds: target.user.diamonds, vipLevel: target.user.vipLevel };
        try {
            sender.coins -= gift.price;
            // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
            // Restored on request (2026-08-04): gift recipients earn Diamonds,
            // not Coins — matches recordGiftHistory()'s diamondAmount field
            // and vipLevelFromDiamonds(), both of which already assumed this.
            target.user.diamonds = clampDiamondBalance(target.user.userId, (target.user.diamonds || 0) + gift.price, "gift-receive");
            target.user.vipLevel = vipLevelFromDiamonds(target.user.diamonds);
            logTransaction(sender.userId, "coins", -gift.price, `Sent ${gift.name} to ${target.user.name}`);
            logTransaction(target.user.userId, "diamonds", gift.price, `Received ${gift.name} from ${sender.name}`);
            logGift({ fromUserId: sender.userId, fromName: sender.name, toUserId: target.user.userId, toName: target.user.name, gift, roomId: roomId || null, time: new Date().toISOString() });
            svip.addWealth(sender.userId, gift.price, `gift:${gift.id}:${Date.now()}`, "gift_sent");
            // FIX (Level System rewrite, 2026-07-29): this call used to run
            // unconditionally, so a gift sent through this REST route with
            // no roomId (or a stale/invalid one) still counted toward ID
            // Level — this is the one gift-send path in the whole app that
            // doesn't already require an active room to reach this line
            // (the socket send-gift/send-video-gift handlers both bail out
            // before this point if `rooms[roomId]` doesn't exist). Gated on
            // the exact same "real, currently active room" check the rest
            // of this handler's room-only side effects already use, so
            // this path now matches the spec exactly: level moves only for
            // a gift that actually happened inside a room.
            if (roomId && rooms[roomId]) {
                idLevel.recordGiftSent(sender.userId, gift.price);
            }
            if (roomId && rooms[roomId]) {
                const hostId = rooms[roomId].hostId;
                const hostFound = hostId ? findUserByUserId(hostId) : null;
                recordGiftHistory({
                    senderId: sender.userId, receiverId: target.user.userId, roomId, hostId,
                    agencyId: hostFound ? hostFound.user.agencyId : null, giftName: gift.name, giftId: gift.id, quantity: 1, diamondAmount: gift.price,
                    transactionId: makeGiftTransactionId(requestId, sender.userId, target.user.userId, gift.id, 1)
                });
            }
        } catch (giftErr) {
            console.error(`🚨 Gift send transaction failed mid-way, rolling back sender ${sender.userId} / target ${target.user.userId}:`, giftErr.message);
            Object.assign(sender, senderSnapshot);
            Object.assign(target.user, targetSnapshot);
            return res.status(500).json({ success: false, message: "Problem sending gift, please try again" });
        }
        saveUsers();
        // Bug fix: this REST route only ever returned the sender's fresh coin
        // total in the HTTP response. The recipient (and, below, any chest
        // reward winners) never got a "wallet-update" push, so their coin
        // balance sat stale everywhere on screen until their next manual
        // reload — unlike the socket-based send-gift handler, which already
        // pushes both sides in real time. Mirror that here.
        pushWalletUpdate(sender.userId);
        pushWalletUpdate(target.user.userId);

        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            io.to(roomId).emit("gift-received", { fromUserId: sender.userId, fromName: sender.name, toUserId: target.user.userId, toName: target.user.name, gift, quantity: 1 });
            io.to(roomId).emit("room-ranking-update", buildRoomRankingPayload(roomId));
            const opened = contributeToChest(room, sender.userId, sender.name, gift.price);
            io.to(roomId).emit("room-state", publicRoom(room));
            if (opened) {
                opened.forEach((o) => {
                    const top = topChestContributors(room.treasureChest, 3);
                    const recipients = new Set([room.hostId, ...top.map((c) => c.userId)]);
                    recipients.forEach((uid) => applyChestReward(uid, o.reward));
                    recipients.forEach((uid) => pushWalletUpdate(uid));
                    io.to(roomId).emit("chest-opened", { level: o.level, reward: o.reward, topContributors: top });
                });
            }
        }
        res.json({ success: true, sender, targetDiamonds: target.user.diamonds });
    } catch (err) {
        console.error("gift send error:", err);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// ==================================================
// OFFICIAL AI CUSTOMER SERVICE — ROOM 101
// Additive feature: keeps the existing 8 user seats untouched and exposes
// one dedicated AI seat above them. The AI is a virtual agent, not a real
// user account, so it never consumes a normal room seat.
// ==================================================
const CS101_ROOM_ID = "101";
const CS101_ROOM_NUMBER = "101";
const CS101_AGENT_ID = "CS-AI-101";
const CS101_AI_USER_ID = "pingpong_ai_help";
// Vapi customer-support voice integration. Only the public key is ever exposed
// to the browser; private Vapi API keys remain server-side in .env.
const VAPI_ASSISTANT_ID = String(process.env.VAPI_ASSISTANT_ID || "3ec88d92-7146-4531-a26d-b790edf51f70").trim();
const VAPI_PUBLIC_KEY = String(process.env.VAPI_PUBLIC_KEY || "").trim();
const VAPI_DEMO_URL = String(process.env.VAPI_DEMO_URL || "").trim();

const { generateReply: generateAIReply } = require("./ai/ai-service.js");

const DEFAULT_CS101_CONFIG = {
    enabled: true,
    agentName: "Robin",
    roomAdminName: "Robin",
    roomAdminId: CS101_AGENT_ID,
    roomBackgroundUrl: "/images/room-default-theme.jpg",
    avatarUrl: "/photos/cs101-female.svg",
    greeting: "হ্যালো {name}, আমি রবিন। আমি PingPong-এর অফিসিয়াল Customer Service AI। আমি কীভাবে আপনাকে সাহায্য করতে পারি? আপনি অ্যাপ্লিকেশন সম্পর্কে কী জানতে চান?",
    instruction: "Handle customers like a professional company customer-service representative. Explain the whole PingPong application, agency/host/admin responsibilities, account/login/OTP, rooms/seats/voice, gifts, coins/diamonds, VIP, frames, wallet/exchange, games and support procedures. Ask a useful follow-up question. Give smart, natural, concise answers. If the issue requires a human or official decision, direct the customer to Official Labib or Official Rakesh using the configured official contact number.",
    voiceEnabled: true,
    voiceRate: 0.96,
    voicePitch: 1.08,
    vapiDemoUrl: VAPI_DEMO_URL,
    openSeatCount: 2,
    officialUserIds: [],
    officialContacts: {
        labibName: "Official Labib",
        rakeshName: "Official Rakesh",
        phone: "8101221193"
    }
};
// In-memory ring buffer of recent Robin voice-call failures reported by
// clients (public/vapi-support.js -> "cs101:voice-error"). Admin-only visibility
// (item requested: "if Robin has a technical problem, the admin panel should
// show it"). Deliberately in-memory, not persisted to disk: this is an
// operational signal for "is Robin healthy right now", not an audit log, and
// it must never grow unbounded, so it's capped and process-lifetime only.
const CS101_VOICE_ERROR_LIMIT = 50;
let cs101VoiceErrors = [];
function cs101RecordVoiceError(entry) {
    cs101VoiceErrors.push(entry);
    if (cs101VoiceErrors.length > CS101_VOICE_ERROR_LIMIT) {
        cs101VoiceErrors = cs101VoiceErrors.slice(-CS101_VOICE_ERROR_LIMIT);
    }
}
let cs101Config = { ...DEFAULT_CS101_CONFIG, ...(safeRead(CS101_CONFIG_FILE, {}) || {}) };
// One-time migration from the previous Room 101 configuration. Older builds
// used the display name "AI Customer Service" and did not have the room-admin,
// seat-policy, room-image or official-contact fields. Keep existing custom
// admin instructions/voice settings, but fill the new production defaults.
if (!cs101Config.agentName || cs101Config.agentName === "AI Customer Service") cs101Config.agentName = "Robin";
if (!cs101Config.roomAdminName) cs101Config.roomAdminName = cs101Config.agentName || "Robin";
if (!cs101Config.roomAdminId) cs101Config.roomAdminId = CS101_AGENT_ID;
if (!cs101Config.roomBackgroundUrl) cs101Config.roomBackgroundUrl = DEFAULT_CS101_CONFIG.roomBackgroundUrl;
if (!Array.isArray(cs101Config.officialUserIds)) cs101Config.officialUserIds = [];
if (!cs101Config.officialContacts || typeof cs101Config.officialContacts !== "object") cs101Config.officialContacts = { ...DEFAULT_CS101_CONFIG.officialContacts };
if (!cs101Config.officialContacts.labibName) cs101Config.officialContacts.labibName = "Official Labib";
if (!cs101Config.officialContacts.rakeshName) cs101Config.officialContacts.rakeshName = "Official Rakesh";
if (!cs101Config.officialContacts.phone) cs101Config.officialContacts.phone = "8101221193";
if (!Number.isFinite(Number(cs101Config.openSeatCount))) cs101Config.openSeatCount = 2;
// One-time migration (2026-08-12): production default for Room 101 changed
// from 1 open seat to 2. Only bump an existing installation's persisted
// value if it still equals the OLD default (1) and this migration hasn't
// already run — so an admin who deliberately set/kept 1 seat (before or
// after this migration) is never silently overwritten again on restart.
if (!cs101Config._seatCountMigratedV2) {
    if (Number(cs101Config.openSeatCount) === 1) cs101Config.openSeatCount = 2;
    cs101Config._seatCountMigratedV2 = true;
}
function saveCs101Config() { safeWrite(CS101_CONFIG_FILE, cs101Config); }
saveCs101Config();

const CS101_SYSTEM_PROMPT = [
    "You are Robin, PingPong's official AI Customer Service agent.",
    "You are permanently assigned as the AI room administrator of Company Customer Service Room 101.",
    "Your agent ID is CS-AI-101.",
    "Always introduce yourself as Robin when appropriate.",
    "Respond in the same language the customer uses (Bengali, Hindi, English, or another language when possible).",
    "Be warm, respectful, professional, natural and conversational. Use the customer's display name in greetings when it is available.",
    "Explain the entire PingPong application: login/OTP, profiles, rooms, seats, microphone/voice, gifts, coins, diamonds, VIP, frames, wallet/exchange, agency/host, games, customer support and general app usage.",
    "Explain clearly what an Agency does, what a Host does, and what Admin/official support does.",
    "If the customer needs an account-specific action or an official decision, explain that Official Labib or Official Rakesh can handle it and use the configured official contact number.",
    "Protect privacy. Never reveal a user's mobile number, email, password, OTP, payment secret, private profile fields or hidden data. When discussing another user's identity, expose only their public User ID unless an authorized server action explicitly provides more public information.",
    "Never invent account balances, transactions, refunds, user records or completed actions.",
    "If you do not know the answer, say so and offer official support instead of guessing.",
    "The customer is speaking to a consistent female voice persona, but the assistant's name is Robin.",
    "You are also the operational room administrator for Room 101. When the customer explicitly asks you to open/unlock/lock a seat, move a seated customer, move someone to the audience, mute/unmute a customer, remove a customer from Room 101, or clear Room 101 chat, use the room_control tool. Do not claim an action happened until the tool result confirms it. Never use room_control for money, wallet, passwords, login, account deletion, bans, assigning permanent admins, or closing Room 101."
].join("\n");

function cs101SystemPrompt() {
    return CS101_SYSTEM_PROMPT + "\nAdministrator instruction: " + String(cs101Config.instruction || "").slice(0, 4000);
}

function cs101PublicState() {
    const contacts = cs101Config.officialContacts || DEFAULT_CS101_CONFIG.officialContacts;
    return {
        enabled: cs101Config.enabled !== false,
        roomId: CS101_ROOM_ID,
        roomNumber: CS101_ROOM_NUMBER,
        roomName: "AI Customer Service",
        agentId: CS101_AGENT_ID,
        agentName: cs101Config.agentName || DEFAULT_CS101_CONFIG.agentName,
        roomAdminName: cs101Config.roomAdminName || cs101Config.agentName || "Robin",
        roomAdminId: CS101_AGENT_ID,
        aiUserId: CS101_AI_USER_ID,
        avatarUrl: cs101Config.avatarUrl || DEFAULT_CS101_CONFIG.avatarUrl,
        roomBackgroundUrl: cs101Config.roomBackgroundUrl || DEFAULT_CS101_CONFIG.roomBackgroundUrl,
        greeting: cs101Config.greeting || DEFAULT_CS101_CONFIG.greeting,
        openSeatCount: Math.max(1, Math.min(8, Number(cs101Config.openSeatCount) || 1)),
        officialUserIds: Array.isArray(cs101Config.officialUserIds) ? cs101Config.officialUserIds : [],
        officialContacts: {
            labibName: contacts.labibName || "Official Labib",
            rakeshName: contacts.rakeshName || "Official Rakesh",
            phone: contacts.phone || "8101221193"
        },
        seat: "special-top-seat",
        normalSeats: 8,
        vapi: {
            assistantId: VAPI_ASSISTANT_ID,
            demoUrl: cs101Config.vapiDemoUrl || VAPI_DEMO_URL || ""
        },
        voice: {
            enabled: cs101Config.voiceEnabled !== false,
            persona: "fixed-female",
            browserSpeechFallback: true
        }
    };
}

function cs101PersonalizedGreeting(userId) {
    const found = findUserByUserId(userId);
    const name = found && found.user ? String(found.user.name || "").trim() : "";
    const contacts = cs101Config.officialContacts || DEFAULT_CS101_CONFIG.officialContacts;
    const template = String(cs101Config.greeting || DEFAULT_CS101_CONFIG.greeting);
    return template
        .replace(/\{name\}/gi, name || "আপনি")
        .replace(/\{id\}/gi, String(userId || ""))
        .slice(0, 1400);
}

function cs101ApplySeatPolicy(room) {
    if (!room || !room.aiCustomerService) return;
    const count = Math.max(1, Math.min(8, Number(cs101Config.openSeatCount) || 1));
    room.lockedSeats = room.lockedSeats || [];
    const desiredLocked = [];
    for (let n = count + 1; n <= 8; n++) {
        if (!room.seats[n - 1]) desiredLocked.push(n);
    }
    // Never lock an occupied seat; lock every empty seat above the configured open count.
    room.lockedSeats = desiredLocked;
}

function cs101OpenNextSeat(room) {
    if (!room || !room.aiCustomerService) return { ok: false, message: "Room 101 is unavailable" };
    const count = Math.max(1, Math.min(8, Number(cs101Config.openSeatCount) || 1));
    if (count >= 8) return { ok: false, message: "All 8 customer seats are already open." };
    cs101Config.openSeatCount = count + 1;
    cs101ApplySeatPolicy(room);
    saveCs101Config();
    saveRoomsToDisk();
    io.to(CS101_ROOM_ID).emit("seat-lock-state", { lockedSeats: room.lockedSeats, openSeatCount: cs101Config.openSeatCount });
    io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
    return { ok: true, seatNumber: count + 1, openSeatCount: cs101Config.openSeatCount };
}

function cs101RunRoomCommand(room, text) {
    const value = String(text || "").trim();
    if (!room || !room.aiCustomerService || !value) return null;
    const openAnother = /(another|next|one more|আরেকটা|আরও একটা|আরেকটি|পরের).*(seat|সিট)|(?:open|unlock|খুলে|খোলা).*(another|next|seat|সিট)/i.test(value);
    if (openAnother) return cs101OpenNextSeat(room);
    const seatMatch = value.match(/(?:open|unlock|খুলে|খোলা)\s*(?:seat|সিট)\s*([1-8])/i);
    if (seatMatch) {
        const n = Number(seatMatch[1]);
        if (n < 1 || n > 8) return { ok: false, message: "Seat number must be between 1 and 8." };
        if (room.seats[n - 1]) return { ok: false, message: `Seat ${n} is occupied.` };
        if (n > Number(cs101Config.openSeatCount || 1)) {
            cs101Config.openSeatCount = n;
            cs101ApplySeatPolicy(room);
            saveCs101Config(); saveRoomsToDisk();
            io.to(CS101_ROOM_ID).emit("seat-lock-state", { lockedSeats: room.lockedSeats, openSeatCount: cs101Config.openSeatCount });
            io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
            return { ok: true, seatNumber: n, openSeatCount: n };
        }
        return { ok: true, seatNumber: n, openSeatCount: cs101Config.openSeatCount };
    }
    return null;
}


function cs101ResolveRoomUser(room, targetUserId, targetName) {
    if (!room) return null;
    const id = String(targetUserId || "").trim();
    if (id) {
        const found = findUserByUserId(id);
        if (found && found.user && room.onlineUsers.some((u) => String(u.userId) === id)) return found.user;
    }
    const name = String(targetName || "").trim().toLowerCase();
    if (!name) return null;
    const matches = room.onlineUsers
        .filter((u) => String(u.userName || "").trim().toLowerCase() === name)
        .map((u) => findUserByUserId(u.userId)?.user)
        .filter(Boolean);
    return matches.length === 1 ? matches[0] : null;
}

function cs101MoveSeat(room, targetUserId, seatNumber) {
    const dest = Number(seatNumber);
    if (!room || !room.aiCustomerService) return { ok: false, message: "Room 101 is unavailable." };
    if (!Number.isInteger(dest) || dest < 1 || dest > 8) return { ok: false, message: "Seat number must be between 1 and 8." };
    if (room.seats[dest - 1]) return { ok: false, message: `Seat ${dest} is occupied.` };
    if ((room.lockedSeats || []).includes(dest)) return { ok: false, message: `Seat ${dest} is locked.` };
    const from = room.seats.findIndex((s) => s && String(s.userId) === String(targetUserId));
    if (from < 0) return { ok: false, message: "That customer is not currently seated." };
    const seatData = room.seats[from];
    room.seats[from] = null;
    room.seats[dest - 1] = seatData;
    io.to(room.roomId).emit("seat-update", {
        action: "move",
        fromSeatNumber: from + 1,
        seatNumber: dest,
        userId: targetUserId,
        socketId: seatData.socketId,
        userName: seatData.userName,
        userPhoto: seatData.userPhoto,
        activeFrame: seatData.activeFrame || null,
        vipLevel: seatData.vipLevel || 0,
        customTag: seatData.customTag || null,
        nameEffect: seatData.nameEffect || null,
        role: roleForUser(room, targetUserId)
    });
    voiceSfu.sync.onSeatChanged(room.roomId, targetUserId, {
        seatNumber: dest,
        isHost: room.hostId === targetUserId,
        isModerator: (room.adminIds || []).includes(targetUserId),
        canPublish: true
    });
    io.to(room.roomId).emit("room-state", publicRoom(room));
    friendshipCp.emitToRoomRelationshipState(room);
    return { ok: true, message: `${seatData.userName || "The customer"} was moved to seat ${dest}.`, seatNumber: dest };
}

function cs101RunAdminCommand(room, requesterId, payload) {
    if (!room || !room.aiCustomerService) return { ok: false, message: "Room 101 is unavailable." };
    if (!room.seats.some((s) => s && String(s.userId) === String(requesterId))) {
        return { ok: false, message: "You must be seated in Room 101 to ask the AI room administrator to perform a room action." };
    }
    const action = String(payload?.action || "").trim().toLowerCase();
    const seatNumber = Number(payload?.seatNumber);
    if (["open_seat", "unlock_seat", "lock_seat"].includes(action)) {
        if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > 8) return { ok: false, message: "Seat number must be between 1 and 8." };
        if (action === "open_seat") {
            if (room.seats[seatNumber - 1]) return { ok: false, message: `Seat ${seatNumber} is occupied.` };
            if (seatNumber > Number(cs101Config.openSeatCount || 1)) cs101Config.openSeatCount = seatNumber;
            room.lockedSeats = (room.lockedSeats || []).filter((n) => Number(n) !== seatNumber);
            cs101ApplySeatPolicy(room);
            saveCs101Config(); saveRoomsToDisk();
            io.to(CS101_ROOM_ID).emit("seat-lock-state", { lockedSeats: room.lockedSeats, openSeatCount: cs101Config.openSeatCount });
            io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
            return { ok: true, message: `Seat ${seatNumber} is now open.` };
        }
        if (action === "unlock_seat") {
            room.lockedSeats = (room.lockedSeats || []).filter((n) => Number(n) !== seatNumber);
            if (seatNumber > Number(cs101Config.openSeatCount || 1)) cs101Config.openSeatCount = seatNumber;
            saveCs101Config(); saveRoomsToDisk();
            io.to(CS101_ROOM_ID).emit("seat-lock-state", { lockedSeats: room.lockedSeats, openSeatCount: cs101Config.openSeatCount });
            io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
            return { ok: true, message: `Seat ${seatNumber} is unlocked and available.` };
        }
        if (room.seats[seatNumber - 1]) return { ok: false, message: `Seat ${seatNumber} is occupied, so I will not lock it.` };
        if (!room.lockedSeats.includes(seatNumber)) room.lockedSeats.push(seatNumber);
        saveRoomsToDisk();
        io.to(CS101_ROOM_ID).emit("seat-lock-state", { lockedSeats: room.lockedSeats, openSeatCount: cs101Config.openSeatCount });
        io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
        return { ok: true, message: `Seat ${seatNumber} is locked.` };
    }

    if (action === "clear_chat") {
        room.messages = [];
        io.to(CS101_ROOM_ID).emit("chat-cleared", { by: cs101Config.agentName || "Robin" });
        io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
        return { ok: true, message: "Room 101 chat has been cleared." };
    }

    const target = cs101ResolveRoomUser(room, payload?.targetUserId, payload?.targetName);
    if (!target) return { ok: false, message: "I could not uniquely identify that customer in Room 101. Please give the exact public User ID or exact display name." };
    if (target.userId === room.hostId || target.userId === CS101_AI_USER_ID) return { ok: false, message: "The AI room administrator cannot be removed or moderated." };
    if (isImmuneUser(target.userId)) return { ok: false, message: "That official account is protected and cannot be moderated by the AI." };

    if (action === "move_user") return cs101MoveSeat(room, target.userId, seatNumber);
    if (action === "move_to_audience") {
        const result = performLeaveSeat(room, { userId: target.userId });
        if (!result.seatNumber) return { ok: false, message: `${target.name || "That customer"} is not currently seated.` };
        io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
        return { ok: true, message: `${target.name || "The customer"} was moved to the audience.` };
    }
    if (action === "mute_user" || action === "unmute_user") {
        room.mutedUntil = room.mutedUntil || {};
        const mins = action === "unmute_user" ? 0 : Math.max(1, Math.min(1440, parseInt(payload?.minutes, 10) || 10));
        if (mins > 0) room.mutedUntil[target.userId] = Date.now() + mins * 60000;
        else delete room.mutedUntil[target.userId];
        io.to(CS101_ROOM_ID).emit("mod-mute-update", { targetUserIds: [target.userId], mutedUntil: mins > 0 ? room.mutedUntil[target.userId] : null });
        io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
        return { ok: true, message: mins > 0 ? `${target.name || "The customer"} was muted for ${mins} minutes.` : `${target.name || "The customer"} was unmuted.` };
    }
    if (action === "kick_user") {
        handleUserLeaveRoom(CS101_ROOM_ID, target.userId, null);
        emitToUser(target.userId, "kicked", { message: "You have been removed from Room 101 by Robin, the AI Room Administrator." });
        io.in(`user:${target.userId}`).socketsLeave(CS101_ROOM_ID);
        return { ok: true, message: `${target.name || "The customer"} was removed from Room 101.` };
    }
    return { ok: false, message: "That room control is not available." };
}

function cs101IsRoom(roomId) {
    return String(roomId) === CS101_ROOM_ID;
}

async function cs101GenerateReply(text, history) {
    const messages = Array.isArray(history) ? history.slice(-12) : [];
    messages.push({ role: "user", content: String(text).slice(0, 4000) });
    return generateAIReply(messages, cs101SystemPrompt());
}

// ==================================================
// ROOMS (in-memory, with lightweight meta persistence)
// ==================================================
let rooms = {};
(function loadRooms() {
    const meta = safeRead(ROOMS_FILE, {});
    const videoPlaylists = safeRead(VIDEO_PLAYLISTS_FILE, {});
    Object.values(meta).forEach((m) => {
        rooms[m.roomId] = {
            roomId: m.roomId,
            roomNumber: m.roomNumber || m.hostId,
            roomName: m.roomName,
            hostId: m.hostId,
            official: !!m.official,
            aiCustomerService: !!m.aiCustomerService,
            aiAgentId: m.aiAgentId || null,
            hostName: m.hostName,
            adminIds: m.adminIds || [],
            lockedSeats: Array.isArray(m.lockedSeats) ? m.lockedSeats : [],
            background: m.background || null,
            logo: m.logo || null,
            agencyId: m.agencyId || null,
            seats: Array(8).fill(null),
            onlineUsers: [],
            messages: [],
            music: { url: null, name: null, playing: false },
            lockedSeats: [],
            roomLocked: !!m.roomLocked,
            roomPasswordHash: m.roomPasswordHash || null,
            gameEnabled: m.gameEnabled !== false,
            countryId: (m.countryId && rbac.COUNTRY_IDS.includes(m.countryId)) ? m.countryId : "OTHERS",
            treasureChest: freshChestState(),
            mutedUntil: {},
            seatLabels: {},
            chatBannedIds: [],
            videoPlaylist: videoPlaylists[m.roomId] || [],
            videoPlayer: freshVideoPlayerState(),
            createdAt: new Date().toISOString()
        };
    });
})();

function ensureOfficialCustomerServiceRoom() {
    const existing = rooms[CS101_ROOM_ID];
    const room = existing || {
        roomId: CS101_ROOM_ID,
        roomNumber: CS101_ROOM_NUMBER,
        roomName: "AI Customer Service",
        hostId: CS101_AI_USER_ID,
        hostName: cs101Config.agentName || DEFAULT_CS101_CONFIG.agentName,
        adminIds: [],
        seats: Array(8).fill(null),
        onlineUsers: [],
        messages: [],
        music: { url: null, name: null, playing: false },
        background: null,
        logo: null,
        lockedSeats: [],
        agencyId: null,
        roomLocked: false,
        roomPasswordHash: null,
        gameEnabled: true,
        treasureChest: freshChestState(),
        mutedUntil: {},
        seatLabels: {},
        chatBannedIds: [],
        videoPlaylist: [],
        videoPlayer: freshVideoPlayerState(),
        createdAt: new Date().toISOString()
    };
    room.official = true;
    room.aiCustomerService = true;
    room.aiAgentId = CS101_AGENT_ID;
    room.roomNumber = CS101_ROOM_NUMBER;
    room.roomName = "AI Customer Service";
    room.hostId = CS101_AI_USER_ID;
    room.hostName = cs101Config.agentName || DEFAULT_CS101_CONFIG.agentName;
    room.background = cs101Config.roomBackgroundUrl || room.background || DEFAULT_CS101_CONFIG.roomBackgroundUrl;
    room.seats = Array.isArray(room.seats) && room.seats.length === 8 ? room.seats : Array(8).fill(null);
    room.onlineUsers = Array.isArray(room.onlineUsers) ? room.onlineUsers : [];
    cs101ApplySeatPolicy(room);
    rooms[CS101_ROOM_ID] = room;
    saveRoomsToDisk();
    return room;
}

ensureOfficialCustomerServiceRoom();

function publicRoom(room) {
    room.mutedUntil = room.mutedUntil || {};
    room.seatLabels = room.seatLabels || {};
    const now = Date.now();
    const seats = room.seats.map((seat) => {
        if (!seat) return null;
        const found = findUserByUserId(seat.userId);
        const mutedUntil = room.mutedUntil[seat.userId] || 0;
        return {
            ...seat,
            role: roleForUser(room, seat.userId),
            // Always read live from the user record so a frame/VIP change
            // shows up on the seat instantly, without needing a manual sync call.
            activeFrame: found ? found.user.activeFrame || null : (seat.activeFrame || null),
            vipLevel: found ? (found.user.vipLevel || 0) : (seat.vipLevel || 0),
            customTag: found ? (found.user.customTag || null) : (seat.customTag || null),
            nameEffect: found ? (found.user.nameEffect || null) : (seat.nameEffect || null),
            // Premium badges (Blue Diamond V etc., see badges.js) — read live
            // from the user record same as frame/tag/nameEffect above, so a
            // badge grant/removal shows on the seat instantly.
            activeBadges: found ? (found.user.activeBadges || []) : (seat.activeBadges || []),
            // Room-local moderation label (e.g. "Speaker"/"Guest"), separate
            // from the paid/admin-panel customTag above — set by host/admin
            // for this room only, cleared on leave.
            modLabel: room.seatLabels[seat.userId] || null,
            micMuted: mutedUntil > now,
            mutedUntil: mutedUntil > now ? mutedUntil : null
        };
    });
    const { roomPasswordHash, emptyCleanupTimer, ...safeRoom } = room;
    // God Power "Invisible Mode": a hidden holder stays connected (voice +
    // socket unaffected, and still visible if seated) but disappears from
    // the room's member/online-user roster.
    const onlineUsers = (room.onlineUsers || []).filter((u) => !isHiddenUser(u.userId));
    const aiSeat = room.aiCustomerService ? {
        id: CS101_AGENT_ID,
        agentId: CS101_AGENT_ID,
        userId: CS101_AI_USER_ID,
        userName: cs101Config.agentName || DEFAULT_CS101_CONFIG.agentName,
        role: "ai-customer-service",
        seatPosition: "top",
        avatarUrl: cs101Config.avatarUrl || DEFAULT_CS101_CONFIG.avatarUrl,
        fixedVoice: "female",
        online: true,
        voiceEnabled: true
    } : null;
    return { ...safeRoom, seats, onlineUsers, aiSeat, relationshipLinks: friendshipCp.getSeatRelationshipLinks(room), videoPlaylist: room.videoPlaylist || [], videoPlayer: publicVideoPlayer(room) };
}

// GAP #1 (Redis Authoritative Runtime State) — REMAINING ITEM 2: shared
// join-mutation function. Extracted from the join-room socket handler
// below with NO behavior change to the local-join path — it's the exact
// same statements, just callable from two places. This is what lets
// redis/roomJoinRpc.js's cross-instance join reuse the real join logic
// (password check, seat/onlineUsers bookkeeping, room-wide broadcast)
// instead of a second, divergent implementation. Only ever called with
// a `room` object that already exists (both call sites check that
// first) — never mutates socketsByUserId/rooms[roomId] existence itself,
// only the room's own fields.
function performRoomJoin(room, { userId, userName, userPhoto, socketId, passwordHash }) {
    if (room.roomLocked && room.hostId !== userId && !(room.adminIds || []).includes(userId)) {
        if (!room.roomPasswordHash || !passwordHash || passwordHash !== room.roomPasswordHash) {
            return { ok: false, needPassword: true, error: passwordHash ? "wrong-password" : "password-required" };
        }
    }
    const existingIdx = room.onlineUsers.findIndex((u) => u.userId === userId);
    const entry = { userId, userName, userPhoto, socketId };
    if (existingIdx >= 0) room.onlineUsers[existingIdx] = entry; else room.onlineUsers.push(entry);
    room.seats.forEach((seat) => { if (seat && seat.userId === userId) seat.socketId = socketId; });
    if (room.emptyCleanupTimer) { clearTimeout(room.emptyCleanupTimer); room.emptyCleanupTimer = null; }

    io.to(room.roomId).emit("room-state", publicRoom(room));
    io.to(room.roomId).emit("user-count", { count: room.onlineUsers.length });
    return { ok: true };
}

// GAP #2 (Cross-Instance Room Operation Forwarding) — shared mutation
// functions for take-seat / leave-seat / send-message. Same extraction
// pattern as performRoomJoin() just above: the exact same statements the
// local socket handlers already ran, now callable from two places (the
// local handler below, and redis/roomOpRpc.js's owning-side dispatch
// when a different instance forwards the op here). No behavior change
// to the local path. Each function takes a `room` object that already
// exists (every call site checks that first) plus a plain-data payload
// (userId/socketId/message — never a socket object), the same boundary
// performRoomJoin() already established, so these run identically
// whether invoked in-process or from the pub/sub RPC handler.
function performTakeSeat(room, { userId, socketId, seatNumber }) {
    if (seatNumber < 1 || seatNumber > 8) return { ok: false, error: "bad-seat" };
    if (room.seats[seatNumber - 1]) return { ok: false, error: "occupied", message: "Seat is already occupied" };
    if ((room.lockedSeats || []).includes(seatNumber) && !isOwnerOrAdmin(room, userId)) {
        return { ok: false, error: "locked", message: "Seat is locked" };
    }
    const found = findUserByUserId(userId);
    if (!found) return { ok: false, error: "user-not-found" };
    let oldSeatNumber = null;
    room.seats.forEach((s, i) => { if (s && s.userId === userId) { oldSeatNumber = i + 1; room.seats[i] = null; } });
    room.seats[seatNumber - 1] = { userId: found.user.userId, socketId, userName: found.user.name, userPhoto: found.user.photo || "", activeFrame: found.user.activeFrame || null, vipLevel: found.user.vipLevel || 0, customTag: found.user.customTag || null, nameEffect: found.user.nameEffect || null };
    io.to(room.roomId).emit("seat-update", {
        action: "take", seatNumber, oldSeatNumber,
        userId: found.user.userId, socketId,
        userName: found.user.name, userPhoto: found.user.photo || "",
        activeFrame: found.user.activeFrame || null, vipLevel: found.user.vipLevel || 0,
        customTag: found.user.customTag || null,
        nameEffect: found.user.nameEffect || null,
        role: roleForUser(room, found.user.userId)
    });
    // PHASE 3, STEP 3.4 — mirrors seat/role state onto the matching
    // LiveKit participant and grants publish permission; no-op unless
    // VOICE_MODE=sfu. See sync.js's onSeatChanged. Unchanged behavior —
    // just reached from a shared function now instead of inline.
    voiceSfu.sync.onSeatChanged(room.roomId, found.user.userId, {
        seatNumber, isHost: room.hostId === found.user.userId,
        isModerator: (room.adminIds || []).includes(found.user.userId),
        canPublish: true
    });
    friendshipCp.emitToRoomRelationshipState(room);
    return { ok: true };
}

function performLeaveSeat(room, { userId }) {
    let seatNumber = null;
    room.seats.forEach((s, i) => { if (s && s.userId === userId) { seatNumber = i + 1; room.seats[i] = null; } });
    if (seatNumber) {
        io.to(room.roomId).emit("seat-update", { action: "leave", seatNumber, userId });
        voiceSfu.sync.onSeatChanged(room.roomId, userId, { seatNumber: null, canPublish: false });
        friendshipCp.emitToRoomRelationshipState(room);
    }
    return { ok: true, seatNumber };
}

function performSendMessage(room, { userId, message }) {
    if (!message || !message.trim()) return { ok: false, error: "empty" };
    if ((room.chatBannedIds || []).includes(userId)) {
        return { ok: false, error: "chat-banned", message: "You have been banned from chat" };
    }
    const found = findUserByUserId(userId);
    if (!found) return { ok: false, error: "user-not-found" };
    // AI Security + Moderator: only acts on abuse patterns (message
    // flood, repeated-character spam, link floods, duplicate spam) —
    // normal chat is completely unaffected and nothing is logged for it.
    if (aiSecurity.isRateLimited(`chat:${userId}`, { windowMs: 10000, max: 12 })) return { ok: false, error: "rate-limited" };

    const cleanMessage = sanitizeText(message.trim(), 500); // Phase 10: also strips control chars, not just length
    // ROOT CAUSE FIX (2026-08-12, "chat messages merge/duplicate"): messages
    // had no unique id, so the client had no way to tell a genuinely new
    // message from a duplicate delivery (socket reconnect/resend, forwarded
    // op retried across instances, etc.) — it could only guess by content,
    // which is exactly what caused consecutive same-user messages to look
    // like one merged item. Every message now gets a server-issued id that
    // both the initial history and every "new-message" emit carry, so the
    // client can dedupe/key strictly by id instead of guessing.
    const msg = { id: crypto.randomUUID(), userId: found.user.userId, userName: found.user.name, customTag: found.user.customTag || null, message: cleanMessage, time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }), createdAt: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > 200) room.messages.shift();
    io.to(room.roomId).emit("new-message", msg);

    // ---- AI Moderation: flag the message, then escalate (warn -> mute
    // -> kick) using the room's existing mute/kick mechanics. Never
    // touches wallet/coins/account-level bans — room-local only, and
    // the room's host/admin is never overridden (immune users skip it).
    const flags = aiModerator.evaluate(userId, cleanMessage);
    if (flags.length && !isOwnerOrAdmin(room, userId) && !isImmuneUser(userId)) {
        const { action, muteMinutes } = aiModerator.escalate(room.roomId, userId, flags);
        const botLine = (text) => {
            const m = { id: crypto.randomUUID(), userId: aiRoomAssistant.AI_BOT_ID, userName: aiRoomAssistant.AI_BOT_NAME, customTag: { text: "AI", color: "#F7CE7E" }, message: text, time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }), createdAt: Date.now() };
            room.messages.push(m);
            if (room.messages.length > 200) room.messages.shift();
            io.to(room.roomId).emit("new-message", m);
        };
        if (action === "warn") {
            botLine(`⚠️ ${found.user.name}, please avoid spam/link flooding — this is your first warning.`);
        } else if (action === "mute") {
            room.mutedUntil = room.mutedUntil || {};
            room.mutedUntil[userId] = Date.now() + muteMinutes * 60000;
            io.to(room.roomId).emit("mod-mute-update", { targetUserIds: [userId], mutedUntil: room.mutedUntil[userId] });
            io.to(room.roomId).emit("room-state", publicRoom(room));
            botLine(`🔇 ${found.user.name} was muted for ${muteMinutes} minutes by AI Moderation (repeated Spam/Abuse pattern detected).`);
        } else if (action === "kick") {
            botLine(`🚫 ${found.user.name} was removed from the room by AI Moderation (repeated Spam/Scam pattern detected).`);
            // GAP #2 FIX: the original inline version read
            // socketsByUserId[socket.userId] — only ever knows about a
            // socket connected to THIS instance — to find and .leave() the
            // target's raw socket object. That breaks the moment this
            // function runs on the room-OWNING instance for a user whose
            // actual socket is connected to a DIFFERENT (forwarding)
            // instance: socketsByUserId[userId] would be undefined here,
            // and the user's client would silently stay subscribed to the
            // room's Socket.IO room after being kicked. io.in(`user:${userId}`)
            // .socketsLeave(room.roomId) is Socket.IO's own cluster-aware
            // remote-socket API (adapter-safe, see redis/socketAdapter.js) —
            // every socket already joins `user:${userId}` on join/identify
            // (see finishJoin()/finishIdentify()), so this reaches the
            // user's actual socket wherever in the cluster it lives, and is
            // an exact no-op-if-absent equivalent for a single-instance
            // deployment too (no behavior change there).
            handleUserLeaveRoom(room.roomId, userId, null);
            emitToUser(userId, "kicked", { message: "AI Moderation: you were removed from the room for repeated rule violations" });
            io.in(`user:${userId}`).socketsLeave(room.roomId);
            aiModerator.clearUser(room.roomId, userId);
        }
    }

    // ---- AI Room Assistant: only speaks when explicitly addressed
    // ("@AI ..." / "AI, ..." / "/ai ..."), so it never talks over
    // normal room chat.
    if (aiRoomAssistant.shouldRespond(cleanMessage)) {
        aiRoomAssistant.reply(room.roomId, room.roomName, room.hostName, userId, found.user.name, cleanMessage).then((text) => {
            const reply = { id: crypto.randomUUID(), userId: aiRoomAssistant.AI_BOT_ID, userName: aiRoomAssistant.AI_BOT_NAME, customTag: "AI", message: text, time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }), createdAt: Date.now() };
            room.messages.push(reply);
            if (room.messages.length > 200) room.messages.shift();
            io.to(room.roomId).emit("new-message", reply);
        }).catch((err) => {
            // Defensive only — aiRoomAssistant.reply() already catches its
            // own errors internally and resolves with a fallback message,
            // so this should never fire. Kept so a future change to that
            // module can never turn into an unhandled rejection here.
            console.error(`⚠️ AI room assistant reply failed for room ${room.roomId}:`, err.message);
        });
    }
    return { ok: true };
}

// ---------- SFU voice provider, parallel to mesh (Phase 3 / Step 3.2, see voice_sfu/) ----------
// Purely additive — registers new /api/voice-sfu/* and
// /api/admin/voice-sfu/* routes only. Mesh (the existing room-voice
// signaling above, and public/app.js's peer-mesh client code) remains
// the default and is completely untouched; this only activates when an
// operator sets VOICE_MODE=sfu with real LiveKit env vars (see
// .env.example). requireAdmin/requirePermission are function
// declarations defined later in this file but hoisted, same as
// callHosting's init call earlier closes over them — see that call's
// own comment for why that's safe.
//
// PHASE 3, STEP 3.4: moved above the Room Recovery Manager init below
// (it used to come after) ONLY so roomRecovery's new optional
// onGhostSeatCleared hook can reference voiceSfu.sync directly at wiring
// time — no behavior of either module changed by the reordering itself.
const { initVoiceSfu } = require("./voice_sfu/index.js");
const voiceSfu = initVoiceSfu({
    app, rooms, isRateLimited: aiSecurity.isRateLimited, requireAdmin, requirePermission, voiceHealth
});

// ---------- Room Recovery Manager, scoped (Phase 1 / Tier A, see room-recovery.js) ----------
// Ghost-seat cleanup only — does NOT do host auto-transfer, see
// room-recovery.js for why that's intentionally excluded.
// PHASE 3, STEP 3.4: wires the module's new optional onGhostSeatCleared
// hook to voice_sfu/sync.js so a ghost seat's stale SFU/LiveKit
// participant connection gets force-disconnected too — see sync.js's
// onGhostSeatCleared for why that's the same effect as a normal leave,
// under a name that reflects what actually triggered it here.
const { initRoomRecovery } = require("./room-recovery.js");
const roomRecovery = initRoomRecovery({
    io, rooms, socketsByUserId, pendingDisconnects, saveRoomsToDisk, publicRoom,
    onGhostSeatCleared: (roomId, userId) => voiceSfu.sync.onGhostSeatCleared(roomId, userId)
});
roomRecovery.runBootSweep();

// ---------- Cross-instance room join (Redis Authoritative Runtime State,
// GAP #1 remaining item 2, see redis/roomJoinRpc.js) ----------
// Additive RPC layer over the existing redis/pubsub.js "room" channel.
// Only ever asked for a room this instance does NOT have locally (see
// the join-room handler below); when this instance DOES own a room
// someone else asks about, it answers using the exact same
// performRoomJoin() the local join path uses just above — one real join
// function, reached two ways.
const { initRoomJoinRpc } = require("./redis/roomJoinRpc.js");
const roomJoinRpc = initRoomJoinRpc({ rooms, performJoin: performRoomJoin, publicRoom });

// ---------- Cross-instance room OPERATION forwarding (GAP #2) ----------
// Additive RPC layer, same "room" pub/sub channel as roomJoinRpc.js just
// above, generalized to any owner-dependent room operation instead of
// just join. Closes the known limitation GAP #1 left behind: once a user
// is inside a room owned by a DIFFERENT cluster instance (joined
// locally before that instance restarted elsewhere, or joined via
// roomJoinRpc's cross-instance join above), take-seat / leave-seat /
// send-message on THIS instance used to silently no-op (`if (!room)
// return`) because `rooms` is this process's own in-memory object. See
// redis/roomOpRpc.js's header for the full design rationale.
const { initRoomOpRpc } = require("./redis/roomOpRpc.js");
const roomOpRpc = initRoomOpRpc({ rooms });
roomOpRpc.registerOp("take-seat", performTakeSeat);
roomOpRpc.registerOp("leave-seat", performLeaveSeat);
roomOpRpc.registerOp("send-message", performSendMessage);
// NOTE (scope, see delivery report): only these three ops — the ones
// named for this pass — are forwarded so far. Other owner-dependent
// room operations (lock-seat, kick-user, set-room-lock, close-room,
// mod-* actions, music/yt-* controls, game-toggle, gifts, etc.) are
// audited and listed in the delivery report as candidates for the next
// incremental pass; they are UNCHANGED by GAP #2 and keep their
// pre-existing single-instance-only behavior for a room this instance
// doesn't own locally.

// ---------- Health Check Service (Phase 1 / Tier A, see health-check.js) ----------
const { initHealthCheck } = require("./health-check.js");
initHealthCheck({ app, io, requireAdmin, rooms, socketsByUserId, voiceHealth, APP_NAME });


// ---------- Shared State Foundation / Redis layer (Phase 2A + 2B-1, see redis/) ----------
// Purely additive: mirrors `rooms`/`socketsByUserId` into Redis on an
// interval for future horizontal-scaling use, publishes lightweight
// cross-instance events (redis/pubsub.js), and mirrors cluster-wide
// voice health (redis/voiceState.js). Does not change how any existing
// route or socket handler reads/writes state, and safely no-ops
// entirely if Redis isn't configured (see redis/client.js). Wrapped
// defensively so that even an unexpected error while wiring this in can
// never take down the rest of the app. (The Socket.IO Redis Adapter
// itself is attached separately, right after `io` is created above —
// not here — see that comment for why.)
let redisLayer = null;
try {
    const { initRedisLayer } = require("./redis/index.js");
    redisLayer = initRedisLayer({ app, requireAdmin, rooms, socketsByUserId, io, voiceHealth, APP_NAME });
} catch (e) {
    console.warn(`[redis] Phase 2A/2B-1 layer failed to initialize, continuing without it: ${e.message}`);
}

function roomListPublic() {
    return Object.values(rooms)
        .map((r) => {
            const hostFound = r.hostId ? findUserByUserId(r.hostId) : null;
            const visibleOnline = r.onlineUsers.filter((u) => !isHiddenUser(u.userId));
            return {
                roomId: r.roomId,
                roomNumber: r.roomNumber || r.hostId,
                roomName: r.roomName,
                hostId: r.hostId || null,
                hostName: r.hostName,
                onlineCount: visibleOnline.length,
                roomLocked: !!r.roomLocked,
                logo: r.logo || null,
                official: !!r.official,
                aiCustomerService: !!r.aiCustomerService,
                aiAgentId: r.aiAgentId || null,
                // ---- additive fields for the redesigned Home Screen room
                // card (light theme, avatar stack, flag, host badge). Does
                // not change or remove any existing field above. ----
                countryFlag: hostFound ? countries.flagEmoji(hostFound.user.country) : null,
                hostBadge: hostFound ? (hostFound.user.customTag || null) : null,
                hostPhoto: hostFound ? (hostFound.user.photo || null) : null,
                onlineAvatars: visibleOnline.slice(0, 5).map((u) => u.userPhoto || null)
            };
        })
        .sort((a, b) => {
            if (a.official && !b.official) return -1;
            if (!a.official && b.official) return 1;
            return b.onlineCount - a.onlineCount;
        });
}

app.get("/api/room/list", async (req, res) => {
    res.json({ success: true, rooms: await roomListPublicCrossInstance() });
});

// GAP #1 (Redis Authoritative Runtime State) — cluster-wide room listing.
// Local rooms are listed exactly as roomListPublic() always has (unchanged,
// zero added latency for the common single-instance case). Additionally,
// on a genuinely multi-instance deployment with Redis enabled, this merges
// in rooms that exist on OTHER instances (visible via the existing
// redis/roomState.js mirror, Phase 2A) but not locally — without this, a
// user connected to instance B could never even SEE a room hosted on
// instance A in "browse rooms", regardless of whether joining it works.
// Falls back to exactly roomListPublic()'s output if Redis is disabled or
// errors, so this can never make the room list worse than it is today.
async function roomListPublicCrossInstance() {
    const local = roomListPublic();
    let roomState;
    try {
        roomState = require("./redis/roomState.js");
    } catch (e) {
        return local;
    }
    let remoteIds;
    try {
        remoteIds = await roomState.listRoomIds();
    } catch (e) {
        return local;
    }
    const localIds = new Set(Object.keys(rooms));
    const missingIds = remoteIds.filter((id) => !localIds.has(id));
    if (!missingIds.length) return local;
    const remoteCards = (await Promise.all(missingIds.map(async (roomId) => {
        let snap;
        try {
            snap = await roomState.getRoomState(roomId);
        } catch (e) {
            return null;
        }
        if (!snap) return null;
        const hostFound = snap.hostId ? findUserByUserId(snap.hostId) : null;
        const visibleOnlineIds = (snap.onlineUserIds || []).filter((id) => !isHiddenUser(id));
        return {
            roomId: snap.roomId,
            roomNumber: snap.roomNumber || snap.hostId,
            roomName: snap.roomName,
            hostName: snap.hostName,
            onlineCount: visibleOnlineIds.length,
            roomLocked: !!snap.roomLocked,
            logo: snap.logo || null,
            countryFlag: hostFound ? countries.flagEmoji(hostFound.user.country) : null,
            hostBadge: hostFound ? (hostFound.user.customTag || null) : null,
            hostPhoto: hostFound ? (hostFound.user.photo || null) : null,
            onlineAvatars: [], // remote-instance user photos aren't in this mirror's snapshot (see redis/roomState.js's deliberate exclusions) — omitted rather than guessed
            crossInstance: true, // additive field only — lets the client/ops distinguish a cluster-mirrored card if useful; existing clients ignoring unknown fields are unaffected
        };
    }))).filter(Boolean);
    return [...local, ...remoteCards].sort((a, b) => b.onlineCount - a.onlineCount);
}

// ==================================================
// GROUPS (in-memory, persisted to disk — same pattern as ROOMS_FILE)
// ==================================================
let groupsStore = {};
(function loadGroups() {
    const saved = safeRead(GROUPS_FILE, {});
    Object.values(saved).forEach((g) => {
        groupsStore[g.groupId] = {
            groupId: g.groupId,
            groupName: g.groupName,
            groupIcon: g.groupIcon || null,
            ownerId: g.ownerId,
            memberIds: Array.isArray(g.memberIds) ? g.memberIds : [],
            createdAt: g.createdAt || new Date().toISOString(),
            lastActivityAt: g.lastActivityAt || g.createdAt || new Date().toISOString()
        };
    });
    console.log(`📂 Loaded ${Object.keys(groupsStore).length} group(s) from ${GROUPS_FILE}`);
})();
function saveGroupsToDisk() { safeWrite(GROUPS_FILE, groupsStore); }

function publicGroup(g) {
    return {
        groupId: g.groupId,
        groupName: g.groupName,
        groupIcon: g.groupIcon || null,
        ownerId: g.ownerId,
        totalMembers: g.memberIds.length,
        onlineMembers: g.memberIds.filter((id) => !!socketsByUserId[id]).length,
        lastActivityAt: g.lastActivityAt
    };
}

// Keeps each member's user.groups (quick "my groups" list) in sync with the
// group's own memberIds — same dual-bookkeeping pattern as followers/following.
function syncUserGroupMembership(userId) {
    const found = findUserByUserId(userId);
    if (!found) return;
    found.user.groups = Object.values(groupsStore).filter((g) => g.memberIds.includes(userId)).map((g) => g.groupId);
}

function broadcastGroupUpdate(groupId) {
    const g = groupsStore[groupId];
    if (!g) return;
    const payload = publicGroup(g);
    g.memberIds.forEach((uid) => {
        emitToUser(uid, "group-update", payload); // GAP #1 — cross-instance-safe
    });
}

app.post("/api/groups/create", userAuth.requireUserAuth, (req, res) => {
    // SECURITY HARDENING (Module 5.1): userId now comes from the verified
    // token (req.authedMobile), not the request body — previously any
    // caller could create a group "owned by" an arbitrary userId.
    const { groupName, groupIcon } = req.body;
    const found = { mobile: req.authedMobile, user: users[req.authedMobile] };
    if (!found.user) return res.json({ success: false, message: "User not found" });
    const userId = found.user.userId;
    if (!groupName || !groupName.trim()) return res.json({ success: false, message: "Enter a Group name" });
    const groupId = crypto.randomBytes(5).toString("hex");
    const now = new Date().toISOString();
    const group = {
        groupId, groupName: sanitizeText(groupName.trim(), 60), groupIcon: groupIcon || null, // Phase 10: sanitized
        ownerId: userId, memberIds: [userId], createdAt: now, lastActivityAt: now
    };
    groupsStore[groupId] = group;
    syncUserGroupMembership(userId);
    saveGroupsToDisk();
    saveUsers();
    res.json({ success: true, group: publicGroup(group) });
});

app.post("/api/groups/:groupId/icon/upload", userAuth.requireUserAuth, uploadGroupIcon.single("icon"), (req, res) => {
    const g = safeGroupLookup(req.params.groupId);
    if (!g) return res.json({ success: false, message: "Group not found" });
    if (!req.file) return res.json({ success: false, message: "File not found" });
    // SECURITY HARDENING (Module 5.1): ownership check now uses the
    // verified caller (req.authedMobile -> their real userId), not a
    // client-claimed req.body.userId.
    const actor = users[req.authedMobile];
    if (!actor || g.ownerId !== actor.userId) return res.json({ success: false, message: "Only the Owner can change the Icon" });
    g.groupIcon = "/group-icons/" + req.file.filename;
    saveGroupsToDisk();
    broadcastGroupUpdate(g.groupId);
    res.json({ success: true, group: publicGroup(g) });
});

app.get("/api/groups/list", (req, res) => {
    // Simple discovery list (e.g. for a "Find Groups" search) — every group,
    // most recently active first. Optional ?q= filters by name.
    const q = (req.query.q || "").toString().trim().toLowerCase();
    let list = Object.values(groupsStore);
    if (q) list = list.filter((g) => g.groupName.toLowerCase().includes(q));
    list = list.sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt)).map(publicGroup);
    res.json({ success: true, groups: list });
});

app.get("/api/groups/:groupId", (req, res) => {
    const g = safeGroupLookup(req.params.groupId);
    if (!g) return res.json({ success: false, message: "Group not found" });
    res.json({ success: true, group: publicGroup(g) });
});

app.post("/api/groups/:groupId/join", userAuth.requireUserAuth, (req, res) => {
    // SECURITY HARDENING (Module 5.1): userId now derived from the
    // verified token — previously anyone could join a group as any userId.
    const actor = users[req.authedMobile];
    const userId = actor && actor.userId;
    const g = safeGroupLookup(req.params.groupId);
    if (!g) return res.json({ success: false, message: "Group not found" });
    if (!actor) return res.json({ success: false, message: "User not found" });
    if (!g.memberIds.includes(userId)) {
        g.memberIds.push(userId);
        g.lastActivityAt = new Date().toISOString();
        syncUserGroupMembership(userId);
        saveGroupsToDisk();
        saveUsers();
        broadcastGroupUpdate(g.groupId);
    }
    res.json({ success: true, group: publicGroup(g) });
});

app.post("/api/groups/:groupId/leave", userAuth.requireUserAuth, (req, res) => {
    // SECURITY HARDENING (Module 5.1): userId now derived from the
    // verified token — previously anyone could remove any userId from a group.
    const actor = users[req.authedMobile];
    if (!actor) return res.json({ success: false, message: "User not found" });
    const userId = actor.userId;
    const g = safeGroupLookup(req.params.groupId);
    if (!g) return res.json({ success: false, message: "Group not found" });
    if (g.ownerId === userId) return res.json({ success: false, message: "Owner cannot leave the group — delete the group instead" });
    g.memberIds = g.memberIds.filter((id) => id !== userId);
    g.lastActivityAt = new Date().toISOString();
    syncUserGroupMembership(userId);
    saveGroupsToDisk();
    saveUsers();
    broadcastGroupUpdate(g.groupId);
    res.json({ success: true });
});

app.delete("/api/groups/:groupId", userAuth.requireUserAuth, (req, res) => {
    // SECURITY HARDENING (Module 5.1): ownership now checked against the
    // verified token's userId, not a client-claimed req.body.userId —
    // previously anyone could delete any group by guessing/knowing its
    // ownerId and passing it in the body.
    const actor = users[req.authedMobile];
    const g = safeGroupLookup(req.params.groupId);
    if (!g) return res.json({ success: false, message: "Group not found" });
    if (!actor || g.ownerId !== actor.userId) return res.json({ success: false, message: "Only the Owner can delete the Group" });
    const members = g.memberIds.slice();
    if (isSafeObjectKey(req.params.groupId)) delete groupsStore[req.params.groupId];
    members.forEach((uid) => syncUserGroupMembership(uid));
    saveGroupsToDisk();
    saveUsers();
    members.forEach((uid) => {
        emitToUser(uid, "group-update", { groupId: req.params.groupId, deleted: true }); // GAP #1 — cross-instance-safe
    });
    res.json({ success: true });
});

app.post("/api/room/create", userAuth.requireUserAuth, (req, res) => {
    // SECURITY HARDENING (Module 5.1): hostId now derived from the
    // verified token, not a client-claimed req.body.userId — previously
    // anyone could create a room "hosted by" an arbitrary userId.
    const { roomName, userName } = req.body;
    const actor = users[req.authedMobile];
    if (!actor) return res.json({ success: false, message: "User not found" });
    const userId = actor.userId;
    if (!roomName || !roomName.trim()) return res.json({ success: false, message: "Enter a Room name" });
    const existing = Object.values(rooms).find((r) => r.hostId === userId);
    if (existing) return res.json({ success: false, message: "You already have a room.", existingRoomId: existing.roomId });
    const roomId = crypto.randomBytes(5).toString("hex");
    const hostFoundForCountry = findUserByUserId(userId);
    const room = {
        // roomNumber is the public-facing "Room Number" shown in the UI — always the
        // creator's permanent userId, set once here and never changed afterwards, even
        // if the host later renames their display name or the room title. roomId (below)
        // stays the internal key used for sockets/lookups and is untouched by this.
        roomId, roomNumber: userId, roomName: sanitizeText(roomName.trim(), 60), hostId: userId, hostName: userName, // Phase 10: sanitized
        adminIds: [], seats: Array(8).fill(null), onlineUsers: [], messages: [],
        music: { url: null, name: null, playing: false }, background: null, logo: null, lockedSeats: [],
        agencyId: null, roomLocked: false, roomPasswordHash: null, gameEnabled: true, treasureChest: freshChestState(),
        mutedUntil: {}, seatLabels: {}, chatBannedIds: [],
        videoPlaylist: [], videoPlayer: freshVideoPlayerState(),
        // Country Data Isolation (RBAC Phase 2) — a room inherits its host's
        // country bucket at creation time, so country-scoped admins only see
        // rooms hosted by their own country's users.
        countryId: hostFoundForCountry ? hostFoundForCountry.user.countryId : "OTHERS",
        createdAt: new Date().toISOString()
    };
    rooms[roomId] = room;
    saveRoomsToDisk();
    voiceSfu.sync.onRoomCreated(roomId); // PHASE 3, STEP 3.4 — no-op unless VOICE_MODE=sfu; see sync.js
    const found = findUserByUserId(userId);
    if (found && !found.user.isHost) { found.user.isHost = true; saveUsers(); }
    io.emit("room-list", roomListPublic());
    res.json({ success: true, room: publicRoom(room) });
});

// ---------- Official AI Customer Service Room 101 ----------
app.get("/api/customer-service/room101", (req, res) => {
    res.json({ success: true, customerService: cs101PublicState(), room: publicRoom(rooms[CS101_ROOM_ID]) });
});

// ---------- Music upload ----------
app.post("/api/music/upload", userAuth.requireUserAuth, upload.single("music"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "File not found" });
    res.json({ success: true, url: "/music/" + req.file.filename, name: req.file.originalname });
});

// ---------- Room background upload ----------
app.post("/api/room/background/upload", userAuth.requireUserAuth, uploadBg.single("background"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "File not found" });
    res.json({ success: true, url: "/backgrounds/" + req.file.filename });
});

// ---------- Theme Library (admin-curated, room-selectable) ----------
app.get("/api/theme-library/list", (req, res) => {
    res.json({ success: true, themes: themeLibrary });
});
app.post("/api/admin/theme-library/upload", requireAdmin, requirePermission("theme-library:manage"), uploadBg.single("theme"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "File not found" });
    const name = String(req.body.name || req.file.originalname || "Theme").slice(0, 40);
    const entry = { id: crypto.randomBytes(6).toString("hex"), name, url: "/backgrounds/" + req.file.filename };
    themeLibrary.push(entry);
    saveThemeLibrary();
    io.emit("theme-library-update", themeLibrary);
    rbac.logAction({ admin: req.adminAccount, action: "theme-upload", module: "theme-library", targetType: "theme", targetId: entry.id, after: entry, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, themes: themeLibrary });
});
app.delete("/api/admin/theme-library/:id", requireAdmin, requirePermission("theme-library:manage"), (req, res) => {
    themeLibrary = themeLibrary.filter((t) => t.id !== req.params.id);
    saveThemeLibrary();
    io.emit("theme-library-update", themeLibrary);
    rbac.logAction({ admin: req.adminAccount, action: "theme-delete", module: "theme-library", targetType: "theme", targetId: req.params.id, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, themes: themeLibrary });
});

// ---------- Home Banner System ----------
// Public: what the Home page banner slider fetches. Active banners only,
// already sorted by their admin-set order.
app.get("/api/banners", (req, res) => {
    res.json({ success: true, banners: bannerManagement.listActive() });
});

// Admin: full list (active + inactive) for the Banner Management panel.
app.get("/api/admin/banners", requireAdmin, requirePermission("banners:manage"), (req, res) => {
    res.json({ success: true, banners: bannerManagement.listAll() });
});

// Admin: upload a new banner image (JPG/PNG/WEBP, 5MB max — enforced by
// uploadBanner's fileFilter/limits above). Owner-only, per RBAC (see
// rbac.js NON_OWNER_ONLY).
app.post("/api/admin/banners", requireAdmin, requirePermission("banners:manage"), uploadBanner.single("image"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "Image file not found" });
    const linkUrl = (req.body && req.body.linkUrl) || "";
    const banner = bannerManagement.create({ imageUrl: "/banner-images/" + req.file.filename, linkUrl });
    rbac.logAction({ admin: req.adminAccount, action: "banner-upload", module: "banners", targetType: "banner", targetId: banner._id, after: banner, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, banner, banners: bannerManagement.listAll() });
});

// Admin: enable/disable a banner without deleting it.
app.post("/api/admin/banners/:id/toggle", requireAdmin, requirePermission("banners:manage"), (req, res) => {
    const banner = bannerManagement.toggle(req.params.id);
    if (!banner) return res.json({ success: false, message: "Banner not found" });
    rbac.logAction({ admin: req.adminAccount, action: "banner-toggle", module: "banners", targetType: "banner", targetId: banner._id, after: { isActive: banner.isActive }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, banner, banners: bannerManagement.listAll() });
});

// Admin: drag & drop reorder — body: { order: [id1, id2, ...] } in the new
// display order.
app.post("/api/admin/banners/reorder", requireAdmin, requirePermission("banners:manage"), (req, res) => {
    const ok = bannerManagement.reorder(req.body && req.body.order);
    if (!ok) return res.json({ success: false, message: "Provide a valid order array" });
    rbac.logAction({ admin: req.adminAccount, action: "banner-reorder", module: "banners", targetType: "banner", targetId: "bulk", ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, banners: bannerManagement.listAll() });
});

app.delete("/api/admin/banners/:id", requireAdmin, requirePermission("banners:manage"), (req, res) => {
    const banner = bannerManagement.remove(req.params.id);
    if (!banner) return res.json({ success: false, message: "Banner not found" });
    // Best-effort file cleanup — never block the API response on it.
    try {
        const filePath = path.join(BANNER_FOLDER, path.basename(banner.imageUrl));
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    rbac.logAction({ admin: req.adminAccount, action: "banner-delete", module: "banners", targetType: "banner", targetId: banner._id, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, banners: bannerManagement.listAll() });
});

// ==================================================
// LEVEL MANAGEMENT (ID Level System Upgrade, 2026-08-04)
// ==================================================
// Everything here reads/writes through idLevel.js's cached config/theme
// state (see that file) — no per-request disk reads, per the perf
// requirement in the spec.

app.get("/api/admin/level/config", requireAdmin, requirePermission("level:manage"), (req, res) => {
    res.json({ success: true, config: idLevel.getConfig() });
});

app.put("/api/admin/level/config", requireAdmin, requirePermission("level:manage"), (req, res) => {
    const before = idLevel.getConfig();
    const { startingValue, growthMultiplier, maxLevel } = req.body || {};
    const partial = {};
    if (startingValue !== undefined) partial.startingValue = startingValue;
    if (growthMultiplier !== undefined) partial.growthMultiplier = growthMultiplier;
    if (maxLevel !== undefined) partial.maxLevel = maxLevel;
    const after = idLevel.updateConfig(partial);
    rbac.logAction({ admin: req.adminAccount, action: "level-config-update", module: "level-management", targetType: "levelConfig", before, after, ip: req.ip, userAgent: reqUserAgent(req) });
    // Existing users keep their already-reached level (Level Lock in
    // idLevel.js) — only future gift sends are evaluated against the new
    // formula, exactly per the "Existing Users" requirement.
    res.json({ success: true, config: after });
});

app.get("/api/admin/level/themes", requireAdmin, requirePermission("level:manage"), (req, res) => {
    res.json({ success: true, themes: idLevel.getAllThemes(), config: idLevel.getConfig() });
});

// One request can update any subset of the 4 image fields (badge/icon/
// border/background) plus the color/glow fields for a single group, all
// in one save — matches the admin panel's single "Save Theme" button per
// group card.
app.post("/api/admin/level/theme/:groupIndex", requireAdmin, requirePermission("level:manage"),
    uploadLevelTheme.fields([{ name: "badge", maxCount: 1 }, { name: "icon", maxCount: 1 }, { name: "border", maxCount: 1 }, { name: "background", maxCount: 1 }]),
    (req, res) => {
        const groupIndex = parseInt(req.params.groupIndex, 10);
        if (!Number.isFinite(groupIndex) || groupIndex < 0) return res.json({ success: false, message: "Invalid group index" });

        const before = idLevel.getTheme(groupIndex);
        const fields = {};
        const files = req.files || {};
        if (files.badge && files.badge[0]) fields.badgeUrl = "/level-themes/" + files.badge[0].filename;
        if (files.icon && files.icon[0]) fields.iconUrl = "/level-themes/" + files.icon[0].filename;
        if (files.border && files.border[0]) fields.borderUrl = "/level-themes/" + files.border[0].filename;
        if (files.background && files.background[0]) fields.backgroundUrl = "/level-themes/" + files.background[0].filename;
        const body = req.body || {};
        if (body.gradientFrom) fields.gradientFrom = String(body.gradientFrom).slice(0, 20);
        if (body.gradientTo) fields.gradientTo = String(body.gradientTo).slice(0, 20);
        if (body.textColor) fields.textColor = String(body.textColor).slice(0, 20);
        if (body.glowColor) fields.glowColor = String(body.glowColor).slice(0, 20);
        if (body.glowEnabled !== undefined) fields.glowEnabled = body.glowEnabled === "true" || body.glowEnabled === true;

        const after = idLevel.setGroupTheme(groupIndex, fields);
        // GLOBAL THEME UPDATE — the spec's headline requirement: every
        // online user currently in this level group sees their badge/
        // colors change immediately, no manual per-user edit, no restart.
        idLevel.broadcastThemeUpdate(groupIndex);
        rbac.logAction({ admin: req.adminAccount, action: "level-theme-update", module: "level-management", targetType: "levelTheme", targetId: String(groupIndex), before, after, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, theme: after, themes: idLevel.getAllThemes() });
    }
);


// ---------- Room logo upload ----------
app.post("/api/room/logo/upload", userAuth.requireUserAuth, uploadLogo.single("logo"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "File not found" });
    res.json({ success: true, url: "/logos/" + req.file.filename });
});

// ==================================================
// WALLET
// ==================================================
// ---------- SVIP Privilege System — read-only endpoints (Backend Core phase) ----------
app.get("/api/svip/status/:userId", (req, res) => {
    const status = svip.statusFor(req.params.userId);
    if (!status) return res.json({ success: false, message: "User not found" });
    res.json({ success: true, ...status });
});
app.get("/api/svip/config", (req, res) => {
    res.json({ success: true, levels: svip.getConfig().levels, resources: svip.getResourceMap() });
});
app.get("/api/svip/leaderboard", (req, res) => {
    const period = ["daily", "weekly", "monthly", "all"].includes(req.query.period) ? req.query.period : "all";
    res.json({ success: true, period, leaderboard: svip.getLeaderboard(period, 20) });
});

// ---------- SVIP Tag Management (PNG upload per level, SVIP1–8) ----------
// Public: what the app/admin panel reads to show each level's tag image.
app.get("/api/svip/tags", (req, res) => {
    res.json({ success: true, tags: svip.listTags() });
});

// Admin: upload/replace the PNG tag for a given level. The file is
// auto-resized (max 256px on the longest side, aspect ratio preserved) and
// re-encoded through sharp's PNG output, which keeps the alpha/transparency
// channel intact and never touches the background — sharp just decodes and
// re-encodes the existing pixels, it doesn't flatten or recolor anything.
// Saved as a fixed uploads/svip-tags/svip{level}.png so re-uploading always
// replaces the previous tag; a tagVersion timestamp is stored separately
// for cache-busting on the client.
// Resize+save a SVIP tag PNG using whichever image engine is available.
// Tries sharp first (best quality/speed), falls back to jimp (pure JS, no
// native binary — works everywhere including Termux), and as a last
// resort just stores the original PNG unresized so the feature never
// hard-fails the request just because neither library could load.
async function saveSvipTagImage(buffer, outPath) {
    if (sharp) {
        await sharp(buffer)
            .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true })
            .png()
            .toFile(outPath);
        return "sharp";
    }
    if (jimp) {
        const Jimp = jimp.Jimp || jimp; // support both jimp v0.x (default export) and v1.x (named export)
        const image = await Jimp.read(buffer);
        if (typeof image.scaleToFit === "function") image.scaleToFit(256, 256);
        else if (typeof image.scaleToFit === "object" && Jimp.scaleToFit) await image.scaleToFit({ w: 256, h: 256 }); // v1.x fallback shape
        if (typeof image.writeAsync === "function") await image.writeAsync(outPath);
        else await image.write(outPath);
        return "jimp";
    }
    fs.writeFileSync(outPath, buffer);
    return "original-unresized";
}

app.post("/api/admin/svip-tags/:level/upload", requireAdmin, requirePermission("svip-tags:manage"), uploadSvipTag.single("tag"), async (req, res) => {
    try {
        const level = Number(req.params.level);
        if (!Number.isInteger(level) || level < 1 || level > 8) {
            return res.json({ success: false, message: "SVIP level must be between 1 and 8" });
        }
        if (!req.file) return res.json({ success: false, message: "PNG file not found" });

        const filename = `svip${level}.png`;
        const outPath = path.join(SVIP_TAG_FOLDER, filename);
        const engine = await saveSvipTagImage(req.file.buffer, outPath);

        const asset = svip.setTagAsset(level, `/svip-tags/${filename}`);
        rbac.logAction({ admin: req.adminAccount, action: "svip-tag-upload", module: "svip-tags", targetType: "svipTag", targetId: String(level), after: { tag: asset.tag }, ip: req.ip, userAgent: reqUserAgent(req) });
        res.json({ success: true, level, tag: asset.tag, tagVersion: asset.tagVersion, resizedWith: engine });
    } catch (err) {
        console.error("svip tag upload error:", err);
        res.status(500).json({ success: false, message: "Failed to process image — upload a valid PNG only" });
    }
});

// Admin: remove a level's tag (keeps the record clean; a later re-upload
// simply overwrites svip{level}.png again).
app.delete("/api/admin/svip-tags/:level", requireAdmin, requirePermission("svip-tags:manage"), (req, res) => {
    const level = Number(req.params.level);
    if (!Number.isInteger(level) || level < 1 || level > 8) {
        return res.json({ success: false, message: "SVIP level must be between 1 and 8" });
    }
    const filePath = path.join(SVIP_TAG_FOLDER, `svip${level}.png`);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
    svip.clearTagAsset(level);
    rbac.logAction({ admin: req.adminAccount, action: "svip-tag-delete", module: "svip-tags", targetType: "svipTag", targetId: String(level), ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, level });
});

// Admin: assign one of the already-uploaded SVIP tags (by level) directly to
// any specific User ID, independent of that user's actual wealth-based SVIP
// level. Shows on the user's profile in real time (socket push) and persists.
app.post("/api/admin/svip-tags/assign", requireAdmin, requirePermission("svip-tags:manage"), (req, res) => {
    const { targetUserId, level } = req.body;
    if (!targetUserId) return res.json({ success: false, message: "Enter User ID" });
    const found = findUserByUserId(String(targetUserId).trim());
    if (!found) return res.json({ success: false, message: "User not found" });
    const result = svip.assignTagToUser(found.user.userId, level);
    if (!result) return res.json({ success: false, message: "User not found" });
    if (result.error === "bad_level") return res.json({ success: false, message: "Choose an SVIP level between 1 and 8" });
    if (result.error === "no_tag") return res.json({ success: false, message: "No tag uploaded for this level — upload the tag first" });
    rbac.logAction({ admin: req.adminAccount, action: "svip-tag-assign", module: "svip-tags", targetType: "user", targetId: found.user.userId, after: { level }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, ...result });
});

// Admin: remove a manually-assigned tag from a User ID (their tag then falls
// back to whatever their actual wealth-based SVIP level normally shows).
app.post("/api/admin/svip-tags/unassign", requireAdmin, requirePermission("svip-tags:manage"), (req, res) => {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.json({ success: false, message: "Enter User ID" });
    const found = findUserByUserId(String(targetUserId).trim());
    if (!found) return res.json({ success: false, message: "User not found" });
    const result = svip.removeAssignedTag(found.user.userId);
    if (!result) return res.json({ success: false, message: "User not found" });
    rbac.logAction({ admin: req.adminAccount, action: "svip-tag-unassign", module: "svip-tags", targetType: "user", targetId: found.user.userId, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, ...result });
});

// AUDIT FIX (Phase 8 completion, wallet/economy audit, 2026-07-28): all
// four wallet read routes below used to trust the :userId URL param with
// no session check — anyone who knew (or guessed/enumerated) another
// user's userId could read their coin/diamond balance and their full
// transaction/exchange history. No money moves through a GET, but this is
// a real privacy leak of financial data. Migrated to the same
// userAuth.requireUserAuth pattern already used for gifts/exchange/
// treasure: identity comes from the verified session token, and the
// response always reflects the authenticated caller's own data — the
// :userId in the URL is no longer trusted for anything. The frontend
// already calls these with `me.userId` (its own id) on every use, so this
// is a pure server-side hardening with no client change required.
app.get("/api/wallet/:userId", userAuth.requireUserAuth, (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "User not found" });
    res.json({ success: true, coins: u.coins, diamonds: u.diamonds });
});
app.get("/api/wallet/:userId/transactions", userAuth.requireUserAuth, (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "User not found" });
    const list = transactions.filter((t) => t.userId === u.userId).slice().reverse().slice(0, 50);
    res.json({ success: true, transactions: list });
});
// req #5/#9: a real, persisted "did I win, how much, on which round" history
// instead of nothing — backed by fruitWheelAudit.js's per-round log. Same
// requireUserAuth pattern as the other wallet endpoints: the :userId in the
// URL is never trusted, the response always reflects the authenticated
// caller's own bets, never anyone else's.
app.get("/api/fruitwheel/history/:userId", userAuth.requireUserAuth, (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "User not found" });
    const history = fruitWheelAudit.readUserHistory(u.userId, 50);
    res.json({ success: true, history });
});
app.get("/api/wallet/:userId/exchanges", userAuth.requireUserAuth, (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "User not found" });
    const list = exchanges.filter((e) => e.userId === u.userId).slice().reverse();
    res.json({ success: true, exchanges: list });
});
app.get("/api/games/recent-wins", (req, res) => {
    res.json({ success: true, wins: recentGameWins });
});
// Phase 15: identity resolved from the verified session, not the
// client-supplied `userId` — this moves real diamonds out of a wallet.
app.post("/api/wallet/exchange/request", userAuth.requireUserAuth, (req, res) => {
    const { diamonds, note } = req.body;
    const sender = users[resolveUserKey(req)];
    if (!sender) return res.json({ success: false, message: "User not found" });
    const amount = Number(diamonds);
    if (!amount || amount <= 0 || sender.diamonds < amount) return res.json({ success: false, message: "Not enough Diamonds" });
    const id = crypto.randomBytes(6).toString("hex");
    exchanges.push({ id, userId: sender.userId, userName: sender.name, diamonds: amount, note: note || "", status: "pending", time: new Date().toISOString() });
    safeWrite(EXCHANGES_FILE, exchanges);
    res.json({ success: true });
});

// ---------- Instant Diamond -> Coin Exchange (fixed 30% ratio, self-service) ----------
// Separate feature from the admin-approval "exchange request" flow above —
// that flow is untouched. This one applies instantly: no admin action,
// fixed ratio, one atomic deduct+credit. Logged to its own permanent file
// so it never mixes with (or duplicates) the `exchanges` array above.
const INSTANT_EXCHANGE_RATE = 0.3; // 1000 diamonds -> 300 coins
const INSTANT_EXCHANGES_FILE = path.join(DATA_FOLDER, "instant_exchanges.json");
let instantExchanges = safeRead(INSTANT_EXCHANGES_FILE, []);
function saveInstantExchanges() { safeWrite(INSTANT_EXCHANGES_FILE, instantExchanges); }

app.get("/api/wallet/:userId/instant-exchanges", userAuth.requireUserAuth, (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "User not found" });
    const list = instantExchanges.filter((e) => e.userId === u.userId).slice().reverse().slice(0, 50);
    res.json({ success: true, exchanges: list });
});

// Phase 15: identity resolved from the verified session, not the
// client-supplied `userId` — this moves real diamonds/coins directly with
// no admin approval step, making it the highest-value target for spoofing.
app.post("/api/wallet/exchange-instant", userAuth.requireUserAuth, (req, res) => {
    const { diamonds } = req.body;
    const user = users[resolveUserKey(req)];
    if (!user) return res.json({ success: false, message: "User not found" });
    // Whole-diamond amounts only, strictly positive, no more than the
    // user actually has — this alone rules out negative-amount exchanges;
    // there is nothing "pending" here to double-submit (it's one atomic
    // deduct+credit per request), so there's no duplicate-exchange case either.
    const amount = Math.floor(Number(diamonds));
    if (!Number.isFinite(amount) || amount <= 0) return res.json({ success: false, message: "Enter a valid Diamond amount" });
    if (user.diamonds < amount) return res.json({ success: false, message: "Not enough Diamonds" });

    const coinsGained = Math.floor(amount * INSTANT_EXCHANGE_RATE);
    user.diamonds -= amount;
    user.coins = clampCoinBalance(user.userId, (user.coins || 0) + coinsGained, "instant-exchange");
    // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
    saveUsers();

    logTransaction(user.userId, "diamonds", -amount, "Instant exchange (30%)");
    logTransaction(user.userId, "coins", coinsGained, "Instant exchange (30%)");
    instantExchanges.push({ id: crypto.randomBytes(6).toString("hex"), userId: user.userId, diamondsSpent: amount, coinsReceived: coinsGained, time: new Date().toISOString() });
    saveInstantExchanges();
    pushWalletUpdate(user.userId);

    res.json({ success: true, diamondsSpent: amount, coinsReceived: coinsGained, coins: user.coins, diamonds: user.diamonds });
});

// ==================================================
// TREASURE BOX (daily/weekly)
// ==================================================
// AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): all three
// treasure-box routes previously trusted a client-supplied userId (URL
// param or body) as proof of identity, with no session check at all —
// unlike every other coin-crediting endpoint in this file (gifts, wallet
// exchange, coin center), which was already migrated to
// userAuth.requireUserAuth per the incremental plan in security/userAuth.js.
// That meant anyone could claim (or check) another account's daily/weekly
// reward just by knowing their userId, with the credit landing on the
// target account. Low direct theft risk (it only ever gives coins, never
// takes them), but it's an authentication bypass and an inconsistency with
// the rest of the wallet surface, so it's brought in line here: identity
// now comes from the verified session token, and the target user is
// resolved from that, not from anything the caller sent.
app.get("/api/treasure/status/:userId", userAuth.requireUserAuth, (req, res) => {
    const found = users[resolveUserKey(req)] ? { user: users[resolveUserKey(req)] } : null;
    if (!found) return res.json({ success: false, message: "User not found" });
    const now = Date.now();
    const dailyReady = !found.user.lastDailyRewardAt || (now - new Date(found.user.lastDailyRewardAt).getTime()) >= 24 * 60 * 60 * 1000;
    const weeklyReady = !found.user.lastWeeklyRewardAt || (now - new Date(found.user.lastWeeklyRewardAt).getTime()) >= 7 * 24 * 60 * 60 * 1000;
    res.json({ success: true, dailyReady, weeklyReady });
});
app.post("/api/treasure/claim-daily", userAuth.requireUserAuth, (req, res) => {
    const found = users[resolveUserKey(req)] ? { user: users[resolveUserKey(req)] } : null;
    if (!found) return res.json({ success: false, message: "User not found" });
    const now = Date.now();
    if (found.user.lastDailyRewardAt && (now - new Date(found.user.lastDailyRewardAt).getTime()) < 24 * 60 * 60 * 1000) {
        return res.json({ success: false, message: "Already claimed today's" });
    }
    const reward = 50 + crypto.randomInt(0, 151);
    found.user.coins = clampCoinBalance(found.user.userId, found.user.coins + reward, "daily-reward");
    // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
    found.user.lastDailyRewardAt = new Date().toISOString();
    saveUsers();
    logTransaction(found.user.userId, "coins", reward, "Daily reward");
    pushWalletUpdate(found.user.userId);
    res.json({ success: true, reward, coins: found.user.coins });
});
app.post("/api/treasure/claim-weekly", userAuth.requireUserAuth, (req, res) => {
    const found = users[resolveUserKey(req)] ? { user: users[resolveUserKey(req)] } : null;
    if (!found) return res.json({ success: false, message: "User not found" });
    const now = Date.now();
    if (found.user.lastWeeklyRewardAt && (now - new Date(found.user.lastWeeklyRewardAt).getTime()) < 7 * 24 * 60 * 60 * 1000) {
        return res.json({ success: false, message: "Already claimed this week's" });
    }
    const reward = 300 + crypto.randomInt(0, 501);
    found.user.coins = clampCoinBalance(found.user.userId, found.user.coins + reward, "weekly-reward");
    // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
    found.user.lastWeeklyRewardAt = new Date().toISOString();
    saveUsers();
    logTransaction(found.user.userId, "coins", reward, "Weekly reward");
    pushWalletUpdate(found.user.userId);
    res.json({ success: true, reward, coins: found.user.coins });
});

// ==================================================
// FRAMES
// ==================================================
// Ownership model mirrors the Vehicle Entry System (vehicles.js) exactly:
// admin assigning a frame only ever grants it into that ONE user's own
// user.frameInventory — never anything global. The user then picks ONE
// owned frame as their Active Frame themselves (below), same "select and
// use" UX as Vehicles. user.activeFrame keeps its existing snapshot shape
// ({ frameId, name, imageUrl, expiresAt }) for backward compatibility with
// every existing room-seat / profile broadcast that already reads it live —
// it just may now only ever be set to something present in frameInventory.

// Drops expired assignment entries from a user's inventory in place, and
// clears activeFrame if it no longer points at an owned frame. Returns
// true if anything changed (caller decides whether to persist).
function pruneExpiredFrameInventory(user) {
    if (!Array.isArray(user.frameInventory)) { user.frameInventory = []; return false; }
    const before = user.frameInventory.length;
    user.frameInventory = user.frameInventory.filter((entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > Date.now());
    let changed = user.frameInventory.length !== before;
    if (user.activeFrame && !user.frameInventory.some((e) => e.frameId === user.activeFrame.frameId)) {
        user.activeFrame = null;
        changed = true;
    }
    return changed;
}

app.get("/api/frames/catalog", (req, res) => {
    res.json({ success: true, frames: frameCatalog });
});
// A user's own inventory — ONLY frames assigned to this specific userId,
// same shape/intent as GET /api/vehicles/mine/:userId.
app.get("/api/frames/mine/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) {
        return res.status(403).json({ success: false, message: "You can only view your own frame inventory" });
    }
    const found = findUserByUserId(req.params.userId);
    if (!found) return res.json({ success: false, message: "User not found" });
    const user = found.user;
    if (pruneExpiredFrameInventory(user)) saveUsers();
    const inventory = (user.frameInventory || []).map((entry) => {
        const f = frameCatalog.find((x) => x.id === entry.frameId);
        if (!f) return null; // deleted from catalog since assignment — never shown with fabricated data
        return {
            id: f.id, name: f.name, imageUrl: f.imageUrl, vipOnly: !!f.vipOnly,
            assignedAt: entry.assignedAt, expiresAt: entry.expiresAt || null,
            permanent: !!entry.permanent,
            active: !!(user.activeFrame && user.activeFrame.frameId === f.id)
        };
    }).filter(Boolean);
    res.json({ success: true, activeFrame: user.activeFrame || null, inventory });
});
// User selects one of THEIR OWN frames as active. Ownership is checked
// against frameInventory — a frame not owned can never be equipped, no
// matter what frameId is passed.
app.post("/api/frames/use", userAuth.requireUserAuth, (req, res) => {
    const { frameId } = req.body;
    const actor = users[req.authedMobile];
    if (!actor) return res.status(401).json({ success: false, message: "User not found" });
    const userId = actor.userId;
    const found = findUserByUserId(userId);
    if (!found) return res.json({ success: false, message: "User not found" });
    const user = found.user;
    if (pruneExpiredFrameInventory(user)) saveUsers();
    const entry = (user.frameInventory || []).find((e) => e.frameId === frameId);
    if (!entry) return res.json({ success: false, message: "You don't own this Frame" });
    const f = frameCatalog.find((x) => x.id === frameId);
    if (!f) return res.json({ success: false, message: "This Frame is no longer available" });
    user.activeFrame = { frameId: f.id, name: f.name, imageUrl: f.imageUrl, expiresAt: entry.expiresAt || null };
    saveUsers();
    syncProfileToRoom(userId);
    emitToUser(userId, "frame-active-updated", user.activeFrame); // GAP #1 — cross-instance-safe
    res.json({ success: true, activeFrame: user.activeFrame });
});
// User removes their own active frame. Never touches other users' inventories.
app.post("/api/frames/deactivate", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor) return res.status(401).json({ success: false, message: "User not found" });
    const userId = actor.userId;
    const found = findUserByUserId(userId);
    if (!found) return res.json({ success: false, message: "User not found" });
    found.user.activeFrame = null;
    saveUsers();
    syncProfileToRoom(userId);
    emitToUser(userId, "frame-active-updated", null); // GAP #1 — cross-instance-safe
    res.json({ success: true });
});
app.post("/api/admin/frames/send", requireAdmin, requirePermission("frames:manage"), (req, res) => {
    const { targetUserId, frameId, expiryDays } = req.body;
    const found = findUserByUserId(targetUserId);
    if (!found) return res.json({ success: false, message: "User not found" });
    const frame = frameCatalog.find((f) => f.id === frameId);
    if (!frame) return res.json({ success: false, message: "Frame not found" });
    const user = found.user;
    if (!Array.isArray(user.frameInventory)) user.frameInventory = [];
    const isPermanent = !expiryDays;
    const expiresAt = isPermanent ? null : new Date(Date.now() + Number(expiryDays) * 86400000).toISOString();
    // Re-sending a frame the user already owns just refreshes the entry
    // (new expiry/permanence) instead of creating a duplicate row — same
    // convention as the Vehicle assign endpoint.
    const existingIdx = user.frameInventory.findIndex((e) => e.frameId === frameId);
    const entry = { frameId, assignedAt: new Date().toISOString(), expiresAt, permanent: isPermanent, assignedBy: { id: req.adminAccount.id, username: req.adminAccount.username } };
    if (existingIdx >= 0) user.frameInventory[existingIdx] = entry; else user.frameInventory.push(entry);
    saveUsers();
    // Private to the recipient ONLY — never a global/broadcast emit. Grants
    // ownership; does NOT auto-equip, same as Vehicle assign (the user picks
    // it as active themselves via /api/frames/use, mirroring vehicles/use).
    emitToUser(targetUserId, "frame-inventory-updated", { frameId, frameName: frame.name }); // GAP #1 — cross-instance-safe
    rbac.logAction({ admin: req.adminAccount, action: "frame-send", module: "frames", targetType: "user", targetId: targetUserId, after: entry, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, assignment: entry });
});
// Admin-assigned coloured text tag (e.g. "VIP") shown next to a user's name
// in chat, on their seat, and on their profile. Send with an empty/blank
// text to remove an existing tag from that user.
app.post("/api/admin/tags/send", requireAdmin, requirePermission("tags:manage"), (req, res) => {
    const { targetUserId, text, color } = req.body;
    const found = findUserByUserId(targetUserId);
    if (!found) return res.json({ success: false, message: "User not found" });
    const cleanText = (text || "").trim().slice(0, 12);
    found.user.customTag = cleanText ? { text: cleanText, color: (color || "#F7CE7E").slice(0, 20) } : null;
    saveUsers();
    syncProfileToRoom(targetUserId);
    emitToUser(targetUserId, "tag-updated", found.user.customTag); // GAP #1 — cross-instance-safe
    rbac.logAction({ admin: req.adminAccount, action: "tag-send", module: "tags", targetType: "user", targetId: targetUserId, after: found.user.customTag, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, customTag: found.user.customTag });
});
// Profile Name Color (Admin Panel feature) — admin picks a VIP Name Effect
// style for a user's userId; applied ONLY to that user's name on the Room
// Seat (glow/animation), nowhere else. Library of styles lives client-side
// as CSS classes (see style.css "VIP Name Effects Library"); the server
// just stores/validates the chosen key against the same allow-list.
const VIP_NAME_EFFECT_STYLES = ["gold_glow", "rainbow", "diamond", "neon", "fire", "ice", "purple_vip", "animated_gradient"];
app.get("/api/admin/name-effects/styles", requireAdmin, requirePermission("namefx:view"), (req, res) => {
    res.json({ success: true, styles: VIP_NAME_EFFECT_STYLES });
});
app.post("/api/admin/name-effects/assign", requireAdmin, requirePermission("namefx:approve"), (req, res) => {
    const { targetUserId, style } = req.body;
    const found = findUserByUserId(targetUserId);
    if (!found) return res.json({ success: false, message: "User not found" });
    if (!VIP_NAME_EFFECT_STYLES.includes(style)) return res.json({ success: false, message: "Choose a valid VIP Style" });
    found.user.nameEffect = style;
    saveUsers();
    syncProfileToRoom(targetUserId);
    emitToUser(targetUserId, "name-effect-updated", found.user.nameEffect); // GAP #1 — cross-instance-safe
    rbac.logAction({ admin: req.adminAccount, action: "namefx-assign", module: "namefx", targetType: "user", targetId: targetUserId, after: { nameEffect: found.user.nameEffect }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, nameEffect: found.user.nameEffect });
});
app.post("/api/admin/name-effects/remove", requireAdmin, requirePermission("namefx:approve"), (req, res) => {
    const { targetUserId } = req.body;
    const found = findUserByUserId(targetUserId);
    if (!found) return res.json({ success: false, message: "User not found" });
    found.user.nameEffect = null;
    saveUsers();
    syncProfileToRoom(targetUserId);
    emitToUser(targetUserId, "name-effect-updated", null); // GAP #1 — cross-instance-safe
    rbac.logAction({ admin: req.adminAccount, action: "namefx-remove", module: "namefx", targetType: "user", targetId: targetUserId, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});
app.post("/api/admin/frames/upload", requireAdmin, requirePermission("frames:manage"), uploadFrame.single("frame"), (req, res) => {
    if (!req.file) return res.json({ success: false, message: "File not found" });
    const { name, vipOnly } = req.body;
    const id = "frame_" + Date.now();
    const frame = { id, name: (name && name.trim()) || req.file.originalname, vipOnly: vipOnly === "true" || vipOnly === true, imageUrl: "/frames/" + req.file.filename };
    frameCatalog.push(frame);
    saveFrameCatalog();
    rbac.logAction({ admin: req.adminAccount, action: "frame-upload", module: "frames", targetType: "frame", targetId: id, after: frame, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, frame });
});

// ==================================================
// VIDEO GIFTS (Global Video Gift System — admin controlled)
// ==================================================
// Public: what the app's Gift Box "Custom" tab loads (enabled gifts only).
app.get("/api/video-gifts/catalog", (req, res) => {
    res.json({ success: true, gifts: publicVideoGiftCatalog() });
});
// Admin: full list including disabled ones, for the management screen.
app.get("/api/admin/video-gifts", requireAdmin, requirePermission("video-gifts:manage"), (req, res) => {
    res.json({ success: true, gifts: videoGiftCatalog });
});
app.post("/api/admin/video-gifts/upload", requireAdmin, requirePermission("video-gifts:manage"), uploadVideoGift.fields([
    { name: "video", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 }
]), (req, res) => {
    const videoFile = req.files && req.files.video && req.files.video[0];
    const thumbFile = req.files && req.files.thumbnail && req.files.thumbnail[0];
    if (!videoFile) return res.json({ success: false, message: "Provide an MP4 video" });
    const name = (req.body.name || "").trim();
    if (!name) return res.json({ success: false, message: "Enter a Gift Name" });
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < MIN_VIDEO_GIFT_PRICE) {
        return res.json({ success: false, message: `Coin Price must be at least ${MIN_VIDEO_GIFT_PRICE}` });
    }
    let duration = Number(req.body.duration);
    if (!Number.isFinite(duration)) duration = 6;
    duration = Math.min(8, Math.max(6, duration));
    const gift = {
        id: "vgift_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
        name,
        price,
        duration,
        videoUrl: "/video-gifts/" + videoFile.filename,
        thumbnail: thumbFile ? ("/video-gifts-thumbs/" + thumbFile.filename) : null,
        enabled: true,
        createdAt: new Date().toISOString()
    };
    videoGiftCatalog.push(gift);
    saveVideoGiftCatalog();
    broadcastVideoGiftCatalog();
    rbac.logAction({ admin: req.adminAccount, action: "video-gift-upload", module: "video-gifts", targetType: "videoGift", targetId: gift.id, after: gift, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, gift });
});
app.post("/api/admin/video-gifts/:id/update", requireAdmin, requirePermission("video-gifts:manage"), (req, res) => {
    const gift = videoGiftCatalog.find((g) => g.id === req.params.id);
    if (!gift) return res.json({ success: false, message: "Gift Not found" });
    const { name, price, duration, enabled } = req.body;
    if (name !== undefined && String(name).trim()) gift.name = String(name).trim();
    if (price !== undefined) {
        const p = Number(price);
        if (!Number.isFinite(p) || p < MIN_VIDEO_GIFT_PRICE) {
            return res.json({ success: false, message: `Coin Price must be at least ${MIN_VIDEO_GIFT_PRICE}` });
        }
        gift.price = p;
    }
    if (duration !== undefined) {
        let d = Number(duration);
        if (Number.isFinite(d)) gift.duration = Math.min(8, Math.max(6, d));
    }
    if (enabled !== undefined) gift.enabled = enabled === true || enabled === "true";
    saveVideoGiftCatalog();
    broadcastVideoGiftCatalog();
    rbac.logAction({ admin: req.adminAccount, action: "video-gift-update", module: "video-gifts", targetType: "videoGift", targetId: gift.id, after: gift, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, gift });
});
app.post("/api/admin/video-gifts/:id/toggle", requireAdmin, requirePermission("video-gifts:manage"), (req, res) => {
    const gift = videoGiftCatalog.find((g) => g.id === req.params.id);
    if (!gift) return res.json({ success: false, message: "Gift Not found" });
    gift.enabled = !(gift.enabled !== false);
    saveVideoGiftCatalog();
    broadcastVideoGiftCatalog();
    rbac.logAction({ admin: req.adminAccount, action: "video-gift-toggle", module: "video-gifts", targetType: "videoGift", targetId: gift.id, after: { enabled: gift.enabled }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, gift });
});
app.delete("/api/admin/video-gifts/:id", requireAdmin, requirePermission("video-gifts:manage"), (req, res) => {
    const idx = videoGiftCatalog.findIndex((g) => g.id === req.params.id);
    if (idx === -1) return res.json({ success: false, message: "Gift Not found" });
    const [removed] = videoGiftCatalog.splice(idx, 1);
    saveVideoGiftCatalog();
    broadcastVideoGiftCatalog();
    // Best-effort cleanup of the stored files — never let this block the response.
    try { if (removed.videoUrl) fs.unlinkSync(path.join(__dirname, removed.videoUrl)); } catch (_) {}
    try { if (removed.thumbnail) fs.unlinkSync(path.join(__dirname, removed.thumbnail)); } catch (_) {}
    rbac.logAction({ admin: req.adminAccount, action: "video-gift-delete", module: "video-gifts", targetType: "videoGift", targetId: removed.id, before: removed, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});
// Scoped just to these routes: turns multer errors (wrong file type, over the
// size limit) into a normal JSON response instead of an HTML crash page.
app.use("/api/admin/video-gifts", (err, req, res, next) => {
    if (err) return res.status(400).json({ success: false, message: err.message || "Upload failed" });
    next();
});

// ==================================================
// GIFT MANAGER (regular Gift Box — Normal/VIP/Legend tabs, admin controlled)
// ==================================================
// Admin: full list including disabled ones, for the management screen.
app.get("/api/admin/gifts", requireAdmin, requirePermission("gifts:manage"), (req, res) => {
    res.json({ success: true, gifts: giftCatalog });
});
app.post("/api/admin/gifts/upload", requireAdmin, requirePermission("gifts:manage"), uploadGiftAssets.fields([
    { name: "image", maxCount: 1 },
    { name: "sound", maxCount: 1 }
]), (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.json({ success: false, message: "Enter a Gift Name" });
    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price <= 0) return res.json({ success: false, message: "Enter a valid Coin Price" });
    const effectType = req.body.effectType === "full_screen" ? "full_screen" : "small";
    const tier = ["normal", "vip", "legend"].includes(req.body.tier) ? req.body.tier : "normal";
    const imageFile = req.files && req.files.image && req.files.image[0];
    const soundFile = req.files && req.files.sound && req.files.sound[0];
    const gift = {
        id: "gift_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex"),
        name,
        price,
        effectType,
        tier,
        image: imageFile ? ("/gift-images/" + imageFile.filename) : null,
        sound: soundFile ? ("/gift-sounds/" + soundFile.filename) : null,
        enabled: true,
        createdAt: new Date().toISOString()
    };
    giftCatalog.push(gift);
    saveGiftCatalog();
    broadcastGiftCatalog();
    rbac.logAction({ admin: req.adminAccount, action: "gift-upload", module: "gifts", targetType: "gift", targetId: gift.id, after: gift, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, gift });
});
app.post("/api/admin/gifts/:id/update", requireAdmin, requirePermission("gifts:manage"), uploadGiftAssets.fields([
    { name: "image", maxCount: 1 },
    { name: "sound", maxCount: 1 }
]), (req, res) => {
    const gift = giftCatalog.find((g) => g.id === req.params.id);
    if (!gift) return res.json({ success: false, message: "Gift Not found" });
    const { name, price, effectType, tier, enabled } = req.body;
    if (name !== undefined && String(name).trim()) gift.name = String(name).trim();
    if (price !== undefined) {
        const p = Number(price);
        if (!Number.isFinite(p) || p <= 0) return res.json({ success: false, message: "Enter a valid Coin Price" });
        gift.price = p;
    }
    if (effectType !== undefined && (effectType === "small" || effectType === "full_screen")) gift.effectType = effectType;
    if (tier !== undefined && ["normal", "vip", "legend"].includes(tier)) gift.tier = tier;
    if (enabled !== undefined) gift.enabled = enabled === true || enabled === "true";
    const imageFile = req.files && req.files.image && req.files.image[0];
    const soundFile = req.files && req.files.sound && req.files.sound[0];
    if (imageFile) {
        try { if (gift.image) fs.unlinkSync(path.join(__dirname, gift.image)); } catch (_) {}
        gift.image = "/gift-images/" + imageFile.filename;
    }
    if (soundFile) {
        try { if (gift.sound) fs.unlinkSync(path.join(__dirname, gift.sound)); } catch (_) {}
        gift.sound = "/gift-sounds/" + soundFile.filename;
    }
    saveGiftCatalog();
    broadcastGiftCatalog();
    rbac.logAction({ admin: req.adminAccount, action: "gift-update", module: "gifts", targetType: "gift", targetId: gift.id, after: gift, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, gift });
});
app.post("/api/admin/gifts/:id/toggle", requireAdmin, requirePermission("gifts:manage"), (req, res) => {
    const gift = giftCatalog.find((g) => g.id === req.params.id);
    if (!gift) return res.json({ success: false, message: "Gift Not found" });
    gift.enabled = !(gift.enabled !== false);
    saveGiftCatalog();
    broadcastGiftCatalog();
    rbac.logAction({ admin: req.adminAccount, action: "gift-toggle", module: "gifts", targetType: "gift", targetId: gift.id, after: { enabled: gift.enabled }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, gift });
});
app.delete("/api/admin/gifts/:id", requireAdmin, requirePermission("gifts:manage"), (req, res) => {
    const idx = giftCatalog.findIndex((g) => g.id === req.params.id);
    if (idx === -1) return res.json({ success: false, message: "Gift Not found" });
    const [removed] = giftCatalog.splice(idx, 1);
    saveGiftCatalog();
    broadcastGiftCatalog();
    // Best-effort cleanup of the stored files — never let this block the response.
    try { if (removed.image) fs.unlinkSync(path.join(__dirname, removed.image)); } catch (_) {}
    try { if (removed.sound) fs.unlinkSync(path.join(__dirname, removed.sound)); } catch (_) {}
    rbac.logAction({ admin: req.adminAccount, action: "gift-delete", module: "gifts", targetType: "gift", targetId: removed.id, before: removed, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});
// Scoped just to these routes: turns multer errors (wrong file type, over the
// size limit) into a normal JSON response instead of an HTML crash page.
app.use("/api/admin/gifts", (err, req, res, next) => {
    if (err) return res.status(400).json({ success: false, message: err.message || "Upload failed" });
    next();
});

// ==================================================
// AGENCY CENTER
// ==================================================
app.get("/api/agency/mine/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: "You can only access your own agency" });
    const uid = actor.userId;
    const owned = Object.values(agencies).find((a) => a.ownerUserId === uid);
    if (owned) {
        const hosts = owned.hostIds.map((hid) => findUserByUserId(hid)).filter(Boolean)
            .map((h) => ({ userId: h.user.userId, name: h.user.name, coins: h.user.coins, diamonds: h.user.diamonds }));
        return res.json({ success: true, agency: { ...owned, isOwner: true, hosts } });
    }
    const asHost = Object.values(agencies).find((a) => a.hostIds.includes(uid));
    if (asHost) return res.json({ success: true, agency: { ...asHost, isOwner: false } });
    res.json({ success: true, agency: null });
});
app.get("/api/admin/agency/list", requireAdmin, requirePermission("agencies:view"), (req, res) => {
    const list = Object.values(agencies).filter((a) => actorCanAccessCountry(req.adminAccount, a.countryId));
    res.json({ success: true, agencies: list });
});
app.post("/api/admin/agency/create", requireAdmin, requirePermission("agencies:manage"), (req, res) => {
    const { name, ownerUserId, commissionRate } = req.body;
    const found = findUserByUserId(ownerUserId);
    if (!name || !found) return res.json({ success: false, message: "Enter a name and a valid Owner ID" });
    // Country isolation: a country-scoped admin can't create an agency for a
    // user outside their own country (Owner/Global Super Admin unaffected).
    if (!actorCanAccessCountry(req.adminAccount, found.user.countryId)) return countryDeniedResponse(res);
    const agencyId = "ag_" + crypto.randomBytes(4).toString("hex");
    agencies[agencyId] = { agencyId, name, ownerUserId, hostIds: [], commissionRate: commissionRate ? Number(commissionRate) : 0.3, earnedDiamonds: 0, countryId: found.user.countryId };
    found.user.agencyId = agencyId;
    saveUsers();
    saveAgencies();
    rbac.logAction({ admin: req.adminAccount, action: "agency-create", module: "agency", targetType: "agency", targetId: agencyId, after: agencies[agencyId], ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, agency: agencies[agencyId] });
});
app.post("/api/admin/agency/assign-host", requireAdmin, requirePermission("agencies:manage"), (req, res) => {
    const { agencyId, hostUserId } = req.body;
    const agency = agencies[agencyId];
    const found = findUserByUserId(hostUserId);
    if (!agency || !found) return res.json({ success: false, message: "Enter a valid Agency ID and Host ID" });
    if (!actorCanAccessCountry(req.adminAccount, agency.countryId)) return countryDeniedResponse(res);
    if (!agency.hostIds.includes(hostUserId)) agency.hostIds.push(hostUserId);
    found.user.agencyId = agencyId;
    found.user.isHost = true;
    saveUsers();
    saveAgencies();
    rbac.logAction({ admin: req.adminAccount, action: "agency-assign-host", module: "agency", targetType: "agency", targetId: agencyId, after: { hostUserId }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});

// ---------- Phase 3: Agency Invite System, Host Center, Agency Center
// Dashboard. Additive module — reads/appends to the existing Gift History
// only (giftHistory / recordGiftHistory above), never a second database.
// See agencyHost.js for details.
const { initAgencyHost } = require("./agencyHost.js");
initAgencyHost({
    app, io, DATA_FOLDER, safeRead, safeWrite,
    users, findUserByUserId, saveUsers,
    agencies, saveAgencies,
    rooms, socketsByUserId, emitToUser,
    giftHistory, registerGiftRecordedHook, periodStart,
    privateMessages, saveMessages, conversationKey,
    INSTANT_EXCHANGE_RATE
});

// ---------- Phase 6: Agency Approval Workflow (Pending -> Review ->
// Approve/Reject -> Reopen). Separate module, separate data file
// (agency_requests.json) — does not touch or replace the instant
// /api/admin/agency/create above, which keeps working unchanged. See
// agencyApproval.js for the full state machine. requireAdmin/
// requirePermission/actorCanAccessCountry/countryDeniedResponse/
// reqUserAgent are function declarations defined further below in this
// file — already-hoisted at this point, same pattern the routes just
// above (agency/list, agency/create) already rely on.
const { initAgencyApproval } = require("./agencyApproval.js");
initAgencyApproval({
    app, DATA_FOLDER, safeRead, safeWrite,
    users, findUserByUserId, saveUsers,
    agencies, saveAgencies,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

// ---------- Phase 6 item 2: Recharge / Withdraw Approval Workflow
// (Submit -> Review -> Approve/Reject, Owner override). Built on the
// shared approvalEngine.js state machine. Separate data files
// (recharge_requests.json / withdraw_requests.json) — does not touch or
// replace the existing diamond<->coin Exchange system just above
// (/api/admin/exchanges), which keeps working unchanged. Wallet mutation
// (coins credited / diamonds deducted) only happens at approval time.
// See rechargeWithdrawApproval.js for details.
const { initRechargeWithdrawApproval } = require("./rechargeWithdrawApproval.js");
initRechargeWithdrawApproval({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, logTransaction, pushWalletUpdate, levelFromCoins, clampCoinBalance,
    io, socketsByUserId, emitToUser,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

// ---------- Recharge / Payment -> Coin System (2026-08-16, additive) ----------
// USER-INITIATED counterpart to rechargeWithdrawApproval.js above: a user
// picks an Admin-configured package, pays the Owner's configured UPI ID
// themselves (outside this app — no payment gateway credentials exist in
// this project), submits the UTR they got back, and an Admin with
// payment:approve verifies and approves/rejects it. See
// wallet/rechargeService.js for the full security rationale (idempotency,
// why this is manual-verification, coin ledger). Routes below are thin —
// all validation/state logic lives in that module.
const { initRechargeService } = require("./wallet/rechargeService.js");
const rechargeService = initRechargeService({
    DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, logTransaction, pushWalletUpdate, clampCoinBalance
});

// ----- User-facing: Wallet -> Recharge -----
// Package list + payment settings the Recharge screen needs. Requires
// login (not public) since packages/settings could change per rollout —
// keeps this consistent with the rest of the authenticated wallet API.
app.get("/api/wallet/recharge/config", userAuth.requireUserAuth, (req, res) => {
    res.json({ success: true, settings: rechargeService.getPublicSettings(), packages: rechargeService.listPackagesPublic() });
});

app.post("/api/wallet/recharge/create", userAuth.requireUserAuth, authLimiter, (req, res) => {
    const mobile = req.authedMobile;
    const user = users[mobile];
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const { packageId, method, utr } = req.body || {};
    const result = rechargeService.createTransaction({ mobile, userId: user.userId, packageId, method, utr });
    if (result.error) return res.json({ success: false, code: result.error, message: result.message, existingId: result.existingId });
    res.json({ success: true, transaction: result.transaction });
});

// ----- PHASE 5 — server-first order flow (2026-08-16) -----
// Replaces the client-driven "generate a random ref, then submit
// everything including UTR in one call" flow for new recharges. The old
// /create route above is left untouched (existing tests + the old
// createTransaction() code path still work exactly as before) — this is a
// purely additive set of routes the client now uses instead.
//
// Step 1: create a PENDING order BEFORE the user ever opens PhonePe/GPay/
// UPI. The returned orderId is the one and only authoritative reference —
// nothing client-generated is ever trusted for anything money-related.
app.post("/api/wallet/recharge/order/create", userAuth.requireUserAuth, authLimiter, (req, res) => {
    const mobile = req.authedMobile;
    const user = users[mobile];
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    const { packageId, method } = req.body || {};
    const result = rechargeService.createOrder({ mobile, userId: user.userId, packageId, method });
    if (result.error) return res.json({ success: false, code: result.error, message: result.message });
    res.json({ success: true, transaction: result.transaction });
});

// Step 2: UPI deep link + dynamic QR for that specific order, computed
// fresh from current settings + the order's own amount/reference every
// call. Falls back to qrDataUrl: null (client uses the static admin QR
// image instead) if the 'qrcode' package isn't installed or generation
// fails — this route never hard-fails the recharge flow over a QR image.
app.get("/api/wallet/recharge/order/:id/payment-data", userAuth.requireUserAuth, async (req, res) => {
    const result = await rechargeService.getOrderPaymentData(req.params.id, req.authedMobile);
    if (result.error) return res.json({ success: false, code: result.error, message: result.message });
    res.json({ success: true, ...result });
});

// Step 3: user reports what they actually paid with. Moves the order from
// PENDING to PAYMENT_SUBMITTED — never credits coins itself. Only
// approveTransaction() (admin-only, below) can ever do that.
app.post("/api/wallet/recharge/order/:id/submit-utr", userAuth.requireUserAuth, authLimiter, (req, res) => {
    const { utr } = req.body || {};
    const result = rechargeService.submitUtr({ mobile: req.authedMobile, id: req.params.id, utr });
    if (result.error) return res.json({ success: false, code: result.error, message: result.message, existingId: result.existingId });
    res.json({ success: true, transaction: result.transaction });
});

app.post("/api/wallet/recharge/:id/cancel", userAuth.requireUserAuth, (req, res) => {
    const result = rechargeService.cancelTransaction(req.authedMobile, req.params.id);
    if (result.error) return res.json({ success: false, code: result.error, message: result.message });
    res.json({ success: true, transaction: result.transaction });
});

app.get("/api/wallet/recharge/history", userAuth.requireUserAuth, (req, res) => {
    res.json({ success: true, history: rechargeService.getUserHistory(req.authedMobile) });
});

// ----- Admin: Payment / Recharge Settings -----
app.get("/api/admin/payment-settings", requireAdmin, requirePermission("payment:manage"), (req, res) => {
    res.json({ success: true, settings: rechargeService.getSettings() });
});
app.put("/api/admin/payment-settings", requireAdmin, requirePermission("payment:manage"), (req, res) => {
    const result = rechargeService.updateSettings(req.body || {}, req.adminAccount.id);
    if (result.error) return res.status(400).json({ success: false, message: result.message });
    rbac.logAction({ admin: req.adminAccount, action: "payment-settings-update", module: "payment", targetType: "paymentSettings", before: result.before, after: result.after, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, settings: result.after });
});

// ----- Admin: Recharge Packages -----
app.get("/api/admin/recharge-packages", requireAdmin, requirePermission("payment:manage"), (req, res) => {
    res.json({ success: true, packages: rechargeService.listPackagesAdmin() });
});
app.post("/api/admin/recharge-packages", requireAdmin, requirePermission("payment:manage"), (req, res) => {
    const result = rechargeService.createPackage(req.body || {}, req.adminAccount.id);
    if (result.error) return res.status(400).json({ success: false, message: result.message });
    rbac.logAction({ admin: req.adminAccount, action: "recharge-package-create", module: "payment", targetType: "rechargePackage", targetId: result.package.id, after: result.package, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, package: result.package });
});
app.put("/api/admin/recharge-packages/:id", requireAdmin, requirePermission("payment:manage"), (req, res) => {
    const before = rechargeService.listPackagesAdmin().find((p) => p.id === req.params.id);
    const result = rechargeService.updatePackage(req.params.id, req.body || {}, req.adminAccount.id);
    if (result.error) return res.status(400).json({ success: false, message: result.message });
    rbac.logAction({ admin: req.adminAccount, action: "recharge-package-update", module: "payment", targetType: "rechargePackage", targetId: req.params.id, before, after: result.package, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, package: result.package });
});
app.delete("/api/admin/recharge-packages/:id", requireAdmin, requirePermission("payment:manage"), (req, res) => {
    const result = rechargeService.deletePackage(req.params.id);
    if (result.error) return res.status(404).json({ success: false, message: result.message });
    rbac.logAction({ admin: req.adminAccount, action: "recharge-package-delete", module: "payment", targetType: "rechargePackage", targetId: req.params.id, before: result.package, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});
app.post("/api/admin/recharge-packages/reorder", requireAdmin, requirePermission("payment:manage"), (req, res) => {
    const result = rechargeService.reorderPackages((req.body || {}).orderedIds);
    if (result.error) return res.status(400).json({ success: false, message: "Invalid order list" });
    rbac.logAction({ admin: req.adminAccount, action: "recharge-package-reorder", module: "payment", targetType: "rechargePackage", after: result.packages, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, packages: result.packages });
});

// ----- Admin: Recharge Records (view + approve/reject) -----
app.get("/api/admin/recharge-records", requireAdmin, requirePermission("payment:view"), (req, res) => {
    res.json({ success: true, ...rechargeService.listTransactionsAdmin(req.query || {}) });
});
app.post("/api/admin/recharge-records/:id/approve", requireAdmin, requirePermission("payment:approve"), (req, res) => {
    const result = rechargeService.approveTransaction(req.params.id, req.adminAccount.id);
    if (result.error) return res.status(result.error === "not-found" ? 404 : 409).json({ success: false, code: result.error, message: result.message, transaction: result.transaction });
    rbac.logAction({ admin: req.adminAccount, action: "recharge-approve", module: "payment", targetType: "rechargeTransaction", targetId: req.params.id, after: result.transaction, meta: { ledgerEntryId: result.ledgerEntry.id }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, transaction: result.transaction });
});
app.post("/api/admin/recharge-records/:id/reject", requireAdmin, requirePermission("payment:approve"), (req, res) => {
    const result = rechargeService.rejectTransaction(req.params.id, req.adminAccount.id, (req.body || {}).reason);
    if (result.error) return res.status(result.error === "not-found" ? 404 : 409).json({ success: false, code: result.error, message: result.message, transaction: result.transaction });
    rbac.logAction({ admin: req.adminAccount, action: "recharge-reject", module: "payment", targetType: "rechargeTransaction", targetId: req.params.id, after: result.transaction, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, transaction: result.transaction });
});

// ---------- Phase 6 items 8-10: Name Effects / Frames / Gifts Approval
// Workflows. All three built on the same approvalEngine.js state machine
// as Recharge/Withdraw above. Name Effects and Frames gate the existing
// per-user "assign" action (existing instant endpoints stay as-is);
// Gifts gates PUBLISHING a new catalog item (existing instant upload
// endpoints, which handle real multipart file upload, stay as-is — this
// workflow takes an already-hosted asset URL instead). See
// namefxApproval.js / framesApproval.js / giftsApproval.js for details.
const { initNameEffectsApproval } = require("./namefxApproval.js");
initNameEffectsApproval({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, syncProfileToRoom,
    VIP_NAME_EFFECT_STYLES,
    io, socketsByUserId, emitToUser,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});
const { initFramesApproval } = require("./framesApproval.js");
initFramesApproval({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, syncProfileToRoom,
    frameCatalog,
    io, socketsByUserId, emitToUser,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});
const { initGiftsApproval } = require("./giftsApproval.js");
initGiftsApproval({
    app, DATA_FOLDER, safeRead, safeWrite,
    giftCatalog, saveGiftCatalog, broadcastGiftCatalog,
    videoGiftCatalog, saveVideoGiftCatalog, broadcastVideoGiftCatalog,
    MIN_VIDEO_GIFT_PRICE,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

// ---------- Vehicle Entry System (Add-on Module) — see vehicles.js.
// Direct admin-to-user assignment (no purchase system), own catalog +
// inventory fields, own socket event ("vehicle-entry", wired into the
// existing join-room handler below without altering it). Fully modular:
// deleting this block and vehicles.js removes the feature with zero
// impact on anything else.
const { initVehicles } = require("./vehicles.js");
const { getUserActiveVehicle } = initVehicles({
    app, fs, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, users,
    io, socketsByUserId, emitToUser,
    rbac, requireAdmin, requirePermission, reqUserAgent,
    userAuth,
    uploadVehicle,
    VEHICLE_THUMB_FOLDER, VEHICLE_VIDEO_FOLDER, VEHICLE_AUDIO_FOLDER
});

// ---------- Premium Badge System (Add-on Module) — see badges.js.
// Admin-only-grantable badges (e.g. Blue Diamond V), own data field
// (users[x].activeBadges), own audit log (data/badgeTransactions.json),
// own socket event ("user_badges_update" — deliberately NOT "badge_update",
// which svip.js already uses for a different single-badge concept). Fully
// modular: deleting this block and badges.js removes the feature with zero
// impact on anything else.
const { initBadges } = require("./badges.js");
initBadges({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers,
    io, socketsByUserId, emitToUser, syncProfileToRoom,
    rbac, requireAdmin, requirePermission, reqUserAgent
});

// ---------- Phase 6 item 11: Diamond Seller Module (Registration/KYC
// approval on the shared approvalEngine.js, plus hand-written
// suspend/restore, commission settings, commission history, and a
// wallet-integrated "sale" action on a separate seller registry —
// diamond_sellers.json). Existing wallet primitives (findUserByUserId /
// saveUsers / logTransaction / pushWalletUpdate / levelFromCoins) are
// reused as-is, not replaced. See diamondSeller.js for details.
const { initDiamondSeller } = require("./diamondSeller.js");
initDiamondSeller({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, logTransaction, pushWalletUpdate, levelFromCoins, clampCoinBalance, clampDiamondBalance,
    io, socketsByUserId, emitToUser,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

// ---------- Phase 6 item 12: VIP Module (last approval domain). Grant
// workflow (Submit -> Review -> Approve/Reject -> Reopen) on the shared
// approvalEngine.js, plus hand-written Renew/Expire and an auto-expiry
// sweep on a separate membership registry — vip_memberships.json. Adds a
// NEW `user.vipMembership` field only; does not read or modify the
// existing `vipLevel` (diamond-based display tier) or `svipLevel` (SVIP
// wealth system) fields/logic. See vipApproval.js for details.
const { initVipApproval } = require("./vipApproval.js");
initVipApproval({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, syncProfileToRoom,
    io, socketsByUserId, emitToUser,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

// ---------- Phase 8: Ban Management Module. Ban Request workflow
// (Submit -> Review -> Approve/Reject -> Reopen) on the shared
// approvalEngine.js, plus hand-written Restore/Reopen, Appeal
// (submit/review/restore/reject), Comments, and a dashboard /summary on
// a separate registry — bans.json. Approving a request sets the existing
// `user.banned` flag (same field/login-check server.js already had) —
// no new user-blocking mechanism invented. See banManagement.js for
// details, including its device/IP-ban scope note.
const { initBanManagement } = require("./banManagement.js");
initBanManagement({
    app, DATA_FOLDER, safeRead, safeWrite,
    findUserByUserId, saveUsers, syncProfileToRoom,
    io, socketsByUserId, emitToUser,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry, countryDeniedResponse, reqUserAgent
});

// ---------- Phase 9: Analytics Hub. Almost every Dashboard & Analytics
// card is served by aggregating EXISTING admin endpoints client-side
// (same pattern Phase 7's Approval Center already uses) — no backend
// change needed for those. The one genuinely missing piece (an admin-
// facing aggregate of the wallet transaction log, for Revenue Analytics)
// is added here as a single read-only route. See analyticsHub.js for the
// full honesty note on what is/isn't backed by real data.
const { initAnalyticsHub } = require("./analyticsHub.js");
initAnalyticsHub({
    app, transactions, users, findUserByUserId,
    rbac, requireAdmin, requirePermission,
    actorCanAccessCountry
});

// ==================================================
// ANNOUNCEMENTS
// ==================================================
app.get("/api/announcements", (req, res) => {
    res.json({ success: true, announcements: announcements.slice().reverse() });
});
app.post("/api/admin/announcements", requireAdmin, requirePermission("announce:send"), (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.json({ success: false, message: "Enter text" });
    const entry = { text: sanitizeText(text.trim(), 500), time: new Date().toISOString() }; // Phase 10: sanitized
    announcements.push(entry);
    safeWrite(ANNOUNCEMENTS_FILE, announcements);
    io.emit("announcement", entry);
    rbac.logAction({ admin: req.adminAccount, action: "announcement-send", module: "announce", targetType: "announcement", after: entry, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});

// ==================================================
// PRIVATE MESSAGES
// ==================================================
app.get("/api/messages/inbox/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: "You can only access your own inbox" });
    const uid = actor.userId;
    const convos = [];
    Object.keys(privateMessages).forEach((key) => {
        const parts = key.split("_");
        if (!parts.includes(uid)) return;
        const otherId = parts[0] === uid ? parts[1] : parts[0];
        const otherFound = findUserByUserId(otherId);
        const msgs = privateMessages[key];
        if (!msgs.length) return;
        const last = msgs[msgs.length - 1];
        convos.push({ otherUserId: otherId, otherName: otherFound ? otherFound.user.name : "User", otherPhoto: otherFound ? otherFound.user.photo : "", lastMessage: last.message, time: last.time });
    });
    // PingPong Help always appears in every user's inbox, even before the
    // first message is ever sent. If there's no conversation yet, it's
    // shown with the welcome text as a preview and sinks to the bottom
    // (epoch time) rather than jumping above genuinely recent chats.
    const aiKey = conversationKey(uid, aiChat.AI_USER_ID);
    const aiMsgs = privateMessages[aiKey];
    const aiLast = aiMsgs && aiMsgs.length ? aiMsgs[aiMsgs.length - 1] : null;
    convos.push({
        otherUserId: aiChat.AI_USER_ID, otherName: aiChat.AI_NAME, otherPhoto: "", isAi: true, verified: true,
        lastMessage: aiLast ? aiLast.message : aiChat.welcomeMessage(),
        time: aiLast ? aiLast.time : new Date(0).toISOString(),
    });
    convos.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json({ success: true, conversations: convos });
});
app.get("/api/messages/thread/:userId1/:userId2", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || ![req.params.userId1, req.params.userId2].includes(actor.userId)) {
        return res.status(403).json({ success: false, message: "You can only access conversations you belong to" });
    }
    const key = conversationKey(req.params.userId1, req.params.userId2);
    // Seed the AI thread with its welcome message the first time either
    // side opens it, so it never shows up empty.
    if ([req.params.userId1, req.params.userId2].includes(aiChat.AI_USER_ID) && !privateMessages[key]) {
        const otherId = req.params.userId1 === aiChat.AI_USER_ID ? req.params.userId2 : req.params.userId1;
        privateMessages[key] = [{ from: aiChat.AI_USER_ID, to: otherId, message: aiChat.welcomeMessage(), time: new Date().toISOString(), ai: true }];
        saveMessages();
    }
    res.json({ success: true, messages: privateMessages[key] || [] });
});
app.post("/api/messages/send", userAuth.requireUserAuth, async (req, res) => {
    const { toUserId, message } = req.body;
    const actor = users[req.authedMobile];
    if (!actor) return res.status(401).json({ success: false, message: "User not found" });
    const fromUserId = actor.userId;
    if (!message || !message.trim()) return res.json({ success: false, message: "Write a message" });
    // FIX (production audit, 2026-08-15): toUserId was never checked against
    // a real account. Any authenticated user could message a made-up/typo'd
    // userId (or the AI's reserved id under a different casing) and the
    // server would silently create an orphan conversation thread that no
    // real recipient — and no emitToUser() delivery — could ever reach.
    // That's wasted storage forever and a confusing "sent but nobody got it"
    // experience with no error to explain why. Reject before it's written.
    if (toUserId !== aiChat.AI_USER_ID && !findUserByUserId(toUserId)) {
        return res.json({ success: false, message: "User not found" });
    }
    const key = conversationKey(fromUserId, toUserId);
    if (!privateMessages[key]) privateMessages[key] = [];
    // PHASE 4 FIX (2026-08-16, private chat audit — §9): private messages
    // never carried a unique id, unlike room chat messages (see
    // performSendMessage()'s crypto.randomUUID() and its
    // "ROOT CAUSE FIX...messages had no unique id" comment for the identical
    // class of bug already fixed there). Without an id, the client had no
    // reliable way to dedupe a duplicate delivery (multi-device socket
    // fan-out, reconnect resend, etc.) from a genuinely new message — it
    // could only guess by content/order. Every private message now gets the
    // same server-issued id pattern room chat already uses.
    const msg = { id: crypto.randomUUID(), from: fromUserId, to: toUserId, message: sanitizeText(message.trim(), 1000), time: new Date().toISOString() }; // Phase 10: sanitized
    privateMessages[key].push(msg);
    saveMessages();
    emitToUser(toUserId, "new-private-message", msg); // GAP #1 — was socketsByUserId[toUserId]-gated (local-instance only); now cross-instance-safe, see emitToUser()'s header

    // If this message is going to PingPong Help, generate and store its
    // reply right here so the sender gets it back in the same response —
    // plus push it over their socket too, in case they've already
    // navigated away from the thread by the time it lands.
    if (toUserId === aiChat.AI_USER_ID) {
        if (aiSecurity.isRateLimited(`ai-chat:${fromUserId}`, { windowMs: 30000, max: 10 })) {
            const limitMsg = { id: crypto.randomUUID(), from: aiChat.AI_USER_ID, to: fromUserId, message: "Slow down — try again in a few seconds.", time: new Date().toISOString(), ai: true };
            privateMessages[key].push(limitMsg);
            saveMessages();
            return res.json({ success: true, message: msg, aiReply: limitMsg });
        }
        const replyText = await aiChat.reply(fromUserId, msg.message);
        const replyMsg = { id: crypto.randomUUID(), from: aiChat.AI_USER_ID, to: fromUserId, message: replyText, time: new Date().toISOString(), ai: true };
        privateMessages[key].push(replyMsg);
        saveMessages();
        emitToUser(fromUserId, "new-private-message", replyMsg); // GAP #1 — see emitToUser() header
        return res.json({ success: true, message: msg, aiReply: replyMsg });
    }

    res.json({ success: true, message: msg });
});

// ==================================================
// ADMIN AUTH + ADMIN ROUTES
// ==================================================
// rbac.ensureOwnerAccount runs once at startup (see bottom of this block)
// so ADMIN_USERNAME/ADMIN_PASSWORD always resolves to a real "owner" RBAC
// account — the legacy env-based credentials keep working unchanged.
function reqUserAgent(req) { return req.headers["user-agent"] || null; }

function requireAdmin(req, res, next) {
    const token = req.headers["x-admin-token"];
    if (!token || !adminSessions.has(token)) return res.status(401).json({ success: false, message: "Unauthorized" });
    // Phase 10: idle (30 min) + absolute (12h) session expiry. A token that
    // was never issued through the current login flow (e.g. server was
    // restarted, wiping session.js's in-memory metadata, but somehow an old
    // token string is still in adminSessions) also fails safe here.
    if (!adminSessionGuard.touch(token)) {
        adminSessions.delete(token);
        return res.status(401).json({ success: false, message: "Session expired — please log in again" });
    }
    const acc = rbac.findById(adminSessions.get(token));
    if (!acc || acc.status !== "active") return res.status(401).json({ success: false, message: "Unauthorized" });
    req.adminAccount = acc;
    next();
}
// Gate a route on a specific permission. Must run AFTER requireAdmin.
// Usage: app.post("/api/admin/users/ban", requireAdmin, requirePermission("users:ban"), (req,res)=>{...})
// Audit item 7: every 403 here (a failed authorization attempt on a
// sensitive/permission-gated endpoint) is recorded as a "failed" audit
// entry — same shape as a successful action, just result:"failed" with a
// failureReason, so Owner/Global Super Admin can see who tried what they
// weren't allowed to.
function requirePermission(permission) {
    return (req, res, next) => {
        const acc = req.adminAccount;
        if (!acc || !rbac.hasPermission(acc, permission)) {
            rbac.logAction({
                admin: acc, action: "authorization-denied", module: "security",
                targetType: "endpoint", targetId: req.originalUrl,
                meta: { method: req.method, permission },
                ip: req.ip, userAgent: reqUserAgent(req),
                result: "failed", failureReason: "missing permission: " + permission
            });
            return res.status(403).json({ success: false, message: "You don't have permission for this action (permission: " + permission + ")" });
        }
        next();
    };
}
// Optional additional gate: restricts a route to only the actor's own
// country's data. Use for endpoints that take a countryId in body/query.
function requireCountryScope(getCountryId) {
    return (req, res, next) => {
        const countryId = getCountryId(req);
        if (!rbac.inScope(req.adminAccount, countryId)) {
            rbac.logAction({
                admin: req.adminAccount, action: "authorization-denied", module: "security",
                targetType: "endpoint", targetId: req.originalUrl,
                meta: { method: req.method, countryId },
                ip: req.ip, userAgent: reqUserAgent(req),
                result: "failed", failureReason: "country scope denied"
            });
            return res.status(403).json({ success: false, message: "No permission to view/edit this country's data" });
        }
        next();
    };
}
// Moderator Room Restriction (RBAC Phase 3). Must run AFTER requireAdmin
// and expects the room id at req.params.roomId. For every role except
// Moderator this is a no-op (rbac.inRoomScope returns true immediately) —
// it only ever narrows a Moderator's access, never widens anyone else's.
// This is deliberately separate from actorCanAccessCountry: that call still
// runs too (inside each handler, after the room is looked up) so a
// Moderator is blocked by BOTH country scope and room scope, same as any
// other role would be by country scope alone.
function requireRoomScope(req, res, next) {
    if (!rbac.inRoomScope(req.adminAccount, req.params.roomId)) {
        rbac.logAction({
            admin: req.adminAccount, action: "authorization-denied", module: "security",
            targetType: "room", targetId: req.params.roomId,
            meta: { method: req.method, url: req.originalUrl },
            ip: req.ip, userAgent: reqUserAgent(req),
            result: "failed", failureReason: "room scope denied (not assigned)"
        });
        return res.status(403).json({ success: false, message: "You don't have access to this room (not an assigned room)" });
    }
    next();
}
function adminUsernameFromReq(req) {
    return req.adminAccount ? req.adminAccount.username : "admin";
}
// Country Data Isolation (RBAC Phase 2, item 2) — true if `actor` is allowed
// to view/modify a record belonging to `countryId`. Wraps rbac.inScope with
// the same "OTHERS" fallback used everywhere a record's countryId might be
// missing/legacy. Owner and Global Super Admin always return true (handled
// inside rbac.inScope). NOT a middleware by itself — call inline after the
// record is looked up, since most of these routes need a 404-vs-403
// distinction (unknown id → 404, wrong country → 403).
function actorCanAccessCountry(actor, countryId) {
    return rbac.inScope(actor, countryId || "OTHERS");
}
function countryDeniedResponse(res) {
    return res.status(403).json({ success: false, message: "No permission to view/edit this country's data" });
}

app.post("/api/admin/login", adminLoginLimiter, (req, res) => {
    const { username, password, panelType } = req.body;
    // Owner Panel / Admin Panel split (additive). panelType is sent by
    // admin/app.js based on which URL prefix served the page
    // (/owner-panel → "owner", /admin-panel → "admin"). The legacy /admin
    // path sends no panelType at all, so it stays exactly as unrestricted
    // as it always was — no existing integration or bookmark breaks.
    // This check runs BEFORE the brute-force/credential checks below so a
    // wrong-panel attempt never counts against the account's failed-login
    // lockout, and is applied uniformly to both the primary RBAC login
    // path and the legacy env-credential fallback path further down.
    function panelMismatch(acc) {
        if (panelType === "owner" && acc.role !== rbac.ROLES.OWNER) return "This is the Owner Panel — Owner account only. Please use the Admin Panel.";
        if (panelType === "admin" && acc.role === rbac.ROLES.OWNER) return "Owner accounts must log in through the Owner Panel.";
        return null;
    }
    // Phase 10: brute-force lockout on top of the rate limiter — this one
    // is keyed to the specific username being attacked, not just the IP,
    // and locks out with a growing cooldown after repeated failures.
    const lock = bruteForce.checkLocked("admin:" + username);
    if (lock.locked) {
        return res.status(429).json({ success: false, message: `Too many failed logins — try again in ${lock.retryAfterSec}s` });
    }
    // Primary path: RBAC account store (covers owner + every role created
    // through the new Role Management screen).
    const acc = rbac.verifyLogin(username, password);
    if (acc) {
        const mismatch = panelMismatch(acc);
        if (mismatch) {
            rbac.logAction({ admin: acc, action: "login-wrong-panel", module: "auth", targetType: "adminAccount", targetId: acc.id, meta: { panelType }, ip: req.ip, userAgent: reqUserAgent(req), result: "failed", failureReason: "wrong panel" });
            return res.json({ success: false, message: mismatch });
        }
        bruteForce.recordSuccess("admin:" + username);
        const token = crypto.randomBytes(24).toString("hex");
        adminSessions.set(token, acc.id);
        adminSessionGuard.start(token); // Phase 10: session now has idle/absolute expiry
        rbac.logAction({ admin: acc, action: "login", module: "auth", targetType: "adminAccount", targetId: acc.id, ip: req.ip, userAgent: reqUserAgent(req) });
        return res.json({ success: true, token });
    }
    // Legacy fallback: in case env credentials were rotated after the owner
    // account was already created (rare), still allow the env login and
    // resync the owner account's password so both stay in sync.
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        const owner = rbac.findByUsername(ADMIN_USERNAME) || rbac.ensureOwnerAccount(ADMIN_USERNAME, ADMIN_PASSWORD);
        const mismatch = panelMismatch(owner);
        if (mismatch) {
            rbac.logAction({ admin: owner, action: "login-wrong-panel", module: "auth", targetType: "adminAccount", targetId: owner.id, meta: { panelType }, ip: req.ip, userAgent: reqUserAgent(req), result: "failed", failureReason: "wrong panel" });
            return res.json({ success: false, message: mismatch });
        }
        rbac.updateAccount(owner, owner.id, { password: ADMIN_PASSWORD });
        bruteForce.recordSuccess("admin:" + username);
        const token = crypto.randomBytes(24).toString("hex");
        adminSessions.set(token, owner.id);
        adminSessionGuard.start(token); // Phase 10
        rbac.logAction({ admin: owner, action: "login (env fallback)", module: "auth", targetType: "adminAccount", targetId: owner.id, ip: req.ip, userAgent: reqUserAgent(req) });
        return res.json({ success: true, token });
    }
    bruteForce.recordFailure("admin:" + username);
    // Failed Login (mandatory audit event, item 1). `admin` is left null —
    // we deliberately don't attribute a failed attempt to whatever account
    // the *username* claims to be, since that's exactly the unverified
    // input an attacker controls; the attempted username is kept in `meta`
    // instead so Owner/Global Super Admin can still see it without the log
    // implying "this account tried to log in".
    rbac.logAction({
        admin: null, action: "login-failed", module: "auth",
        targetType: "adminAccount", targetId: null,
        meta: { attemptedUsername: String(username || "").slice(0, 100) },
        ip: req.ip, userAgent: reqUserAgent(req),
        result: "failed", failureReason: "invalid credentials"
    });
    res.json({ success: false, message: "Wrong Username or Password" });
});

// Current admin's profile — role, country, permissions, visible menu
// sections. admin/app.js calls this right after login to build the
// role-aware sidebar without changing any existing section's own logic.
app.get("/api/admin/me", requireAdmin, (req, res) => {
    const acc = req.adminAccount;
    const permissions = rbac.effectivePermissions(acc);
    const visibleSections = Object.entries(rbac.SECTION_PERMISSIONS)
        .filter(([, perm]) => acc.role === rbac.ROLES.OWNER || permissions.includes(perm))
        .map(([section]) => section);
    res.json({
        success: true,
        admin: rbac.sanitize(acc),
        permissions: acc.role === rbac.ROLES.OWNER ? rbac.PERMISSIONS : permissions,
        visibleSections
    });
});

// ---------- Role & Country Management (new) ----------
app.get("/api/admin/countries", requireAdmin, (req, res) => {
    res.json({ success: true, countries: rbac.COUNTRIES, roles: rbac.ROLES });
});
app.get("/api/admin/accounts", requireAdmin, requirePermission("role:manage"), (req, res) => {
    res.json({ success: true, accounts: rbac.listAccounts(req.adminAccount) });
});
app.post("/api/admin/accounts", requireAdmin, requirePermission("role:manage"), (req, res) => {
    const { username, password, fullName, role, countryId, assignedRoomIds, permissions } = req.body;
    if (!username || !password || !role) return res.json({ success: false, message: "username, password, role are required" });
    const result = rbac.createAccount({ creator: req.adminAccount, username, password, fullName, role, countryId, assignedRoomIds, permissions });
    rbac.logAction({
        admin: req.adminAccount, action: "create-admin-account", module: "accounts",
        targetType: "adminAccount", targetId: result.success ? result.account.id : null,
        after: result.success ? { username, role, countryId, assignedRoomIds: assignedRoomIds || [] } : null,
        ip: req.ip, userAgent: reqUserAgent(req),
        result: result.success ? "success" : "failed", failureReason: result.success ? null : result.message
    });
    res.json(result);
});
app.put("/api/admin/accounts/:id", requireAdmin, requirePermission("role:manage"), (req, res) => {
    const before = rbac.findById(req.params.id);
    const beforeState = before ? { fullName: before.fullName, status: before.status, permissions: before.permissions, assignedRoomIds: before.assignedRoomIds } : null;
    const result = rbac.updateAccount(req.adminAccount, req.params.id, req.body || {});
    rbac.logAction({
        admin: req.adminAccount, action: "update-admin-account", module: "accounts",
        targetType: "adminAccount", targetId: req.params.id,
        before: beforeState,
        after: result.success ? { fullName: result.account.fullName, status: result.account.status, permissions: result.account.permissions, assignedRoomIds: result.account.assignedRoomIds } : null,
        ip: req.ip, userAgent: reqUserAgent(req),
        result: result.success ? "success" : "failed", failureReason: result.success ? null : result.message
    });
    res.json(result);
});
app.delete("/api/admin/accounts/:id", requireAdmin, requirePermission("role:manage"), (req, res) => {
    const before = rbac.findById(req.params.id);
    const beforeState = before ? { username: before.username, role: before.role, countryId: before.countryId } : null;
    const result = rbac.deleteAccount(req.adminAccount, req.params.id);
    rbac.logAction({
        admin: req.adminAccount, action: "delete-admin-account", module: "accounts",
        targetType: "adminAccount", targetId: req.params.id,
        before: beforeState,
        ip: req.ip, userAgent: reqUserAgent(req),
        result: result.success ? "success" : "failed", failureReason: result.success ? null : result.message
    });
    res.json(result);
});
// Item 4/5/6: filters + pagination + search, scoped to the actor's country
// (Owner/Global Super Admin see everything) via rbac.listLogs. Query params
// are all optional: dateFrom, dateTo, countryId, role, module, action,
// result, adminUsername, targetId, targetType, search, page, pageSize.
app.get("/api/admin/logs", requireAdmin, requirePermission("security:view-logs"), (req, res) => {
    const q = req.query;
    // Backward-compat: the existing admin/app.js UI calls this with
    // ?limit=200 (pre-Phase-4 shape). Treat that the same as pageSize so
    // that call keeps working unchanged until the panel is wired up to the
    // new filter/pagination controls.
    const result = rbac.listLogs(req.adminAccount, {
        dateFrom: q.dateFrom, dateTo: q.dateTo, countryId: q.countryId, role: q.role,
        module: q.module, action: q.action, result: q.result, adminUsername: q.adminUsername,
        targetId: q.targetId, targetType: q.targetType, search: q.search,
        page: q.page, pageSize: q.pageSize || q.limit
    });
    res.json({ success: true, logs: result.entries, total: result.total, page: result.page, pageSize: result.pageSize });
});
// Item 3: "Only Owner can export logs." Same filters as the listing route
// (minus pagination — export returns the full filtered set), CSV output.
// Deliberately its own permission check (role === OWNER) on top of
// requirePermission("security:view-logs") — a Global Super Admin can list
// logs but still can't hit this route, matching the SRS wording exactly.
app.get("/api/admin/logs/export", requireAdmin, requirePermission("security:view-logs"), (req, res) => {
    const q = req.query;
    const entries = rbac.exportLogs(req.adminAccount, {
        dateFrom: q.dateFrom, dateTo: q.dateTo, countryId: q.countryId, role: q.role,
        module: q.module, action: q.action, result: q.result, adminUsername: q.adminUsername,
        targetId: q.targetId, targetType: q.targetType, search: q.search
    });
    if (entries === null) {
        rbac.logAction({
            admin: req.adminAccount, action: "export-audit-logs", module: "security",
            ip: req.ip, userAgent: reqUserAgent(req),
            result: "failed", failureReason: "export restricted to Owner"
        });
        return res.status(403).json({ success: false, message: "Only the Owner can export the audit log" });
    }
    const cols = ["id", "timestamp", "adminId", "adminUsername", "role", "countryId", "ip", "userAgent", "action", "module", "targetType", "targetId", "result", "failureReason"];
    const esc = (v) => { const s = v === null || v === undefined ? "" : String(v); return '"' + s.replace(/"/g, '""') + '"'; };
    const csv = [cols.join(",")].concat(entries.map((e) => cols.map((c) => esc(e[c])).join(","))).join("\n");
    rbac.logAction({
        admin: req.adminAccount, action: "export-audit-logs", module: "security",
        meta: { count: entries.length, filters: q },
        ip: req.ip, userAgent: reqUserAgent(req)
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="audit-logs-${Date.now()}.csv"`);
    res.send(csv);
});
// ---------- God Power (Super Admin) endpoints ----------
// Reuses the same Admin login (requireAdmin) — there's no separate Super
// Admin account; this is just a specially-privileged section of the panel.
app.get("/api/admin/godpower/list", requireAdmin, requirePermission("godpower:manage"), (req, res) => {
    const holders = godPowerHolders();
    res.json({ success: true, holders, count: holders.length, max: GOD_POWER_MAX });
});
app.get("/api/admin/godpower/search", requireAdmin, requirePermission("godpower:manage"), (req, res) => {
    const found = findUserByUserId(String(req.query.query || "").trim());
    if (!found) return res.json({ success: false, message: "User not found" });
    const u = found.user;
    res.json({ success: true, user: { userId: u.userId, name: u.name, mobile: found.mobile, photo: u.photo || "", isGodPower: !!u.is_immune } });
});
app.post("/api/admin/godpower/grant", requireAdmin, requirePermission("godpower:manage"), (req, res) => {
    const found = findUserByUserId(String(req.body.userId || "").trim());
    if (!found) return res.json({ success: false, message: "User not found" });
    if (found.user.is_immune) return res.json({ success: false, message: "This user is already a God Power Holder" });
    if (godPowerHolders().length >= GOD_POWER_MAX) return res.json({ success: false, message: `Limit Reached (${GOD_POWER_MAX}/${GOD_POWER_MAX})` });
    found.user.is_immune = true;
    found.user.can_manage_all = true;
    found.user.is_invisible = true;
    found.user.invisibleActive = false;
    saveUsers();
    emitToUser(found.user.userId, "god_power_granted", { message: "You are now an Official God Power Holder" }); // GAP #1 — cross-instance-safe
    const holders = godPowerHolders();
    rbac.logAction({ admin: req.adminAccount, action: "godpower-grant", module: "godpower", targetType: "user", targetId: found.user.userId, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, count: holders.length, max: GOD_POWER_MAX });
});
app.post("/api/admin/godpower/revoke", requireAdmin, requirePermission("godpower:manage"), (req, res) => {
    const found = findUserByUserId(String(req.body.userId || "").trim());
    if (!found) return res.json({ success: false, message: "User not found" });
    found.user.is_immune = false;
    found.user.can_manage_all = false;
    found.user.is_invisible = false;
    found.user.invisibleActive = false;
    saveUsers();
    // GAP #1 — cross-instance-safe via emitToUser(); the room-state
    // refresh below stays local-socket-gated since it only matters (and
    // only has data to act on) if this instance is holding that user's
    // live room membership.
    emitToUser(found.user.userId, "god_power_revoked", { message: "Your God Power has been removed" });
    const sid = socketsByUserId[found.user.userId];
    if (sid) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.currentRoom) io.to(s.currentRoom).emit("room-state", publicRoom(rooms[s.currentRoom]));
    }
    io.emit("room-list", roomListPublic());
    const holders = godPowerHolders();
    rbac.logAction({ admin: req.adminAccount, action: "godpower-revoke", module: "godpower", targetType: "user", targetId: found.user.userId, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, count: holders.length, max: GOD_POWER_MAX });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
    rbac.logAction({ admin: req.adminAccount, action: "logout", module: "auth", targetType: "adminAccount", targetId: req.adminAccount.id, ip: req.ip, userAgent: reqUserAgent(req) });
    adminSessions.delete(req.headers["x-admin-token"]);
    adminSessionGuard.end(req.headers["x-admin-token"]); // Phase 10
    res.json({ success: true });
});

// Phase 12 regression fix: this endpoint previously returned global totals
// (every user/room/online-count/banned-count across ALL countries) to
// anyone holding "dashboard:view" — which Country Manager and Country
// Super Admin both hold. That leaked cross-country numbers to a
// country-scoped role, breaking the same Country Data Isolation guarantee
// every other list endpoint in this file enforces (see
// actorCanAccessCountry above). Fixed to scope every count through the
// identical actorCanAccessCountry check used by /api/admin/rooms and
// /api/admin/users — Owner/Global Super Admin/Country Super Admin still
// see everything (actorCanAccessCountry returns true for them via
// rbac.inScope), a Country Manager/Admin now only sees their own country.
app.get("/api/admin/stats", requireAdmin, requirePermission("dashboard:view"), (req, res) => {
    const visibleUsers = Object.values(users).filter((u) => actorCanAccessCountry(req.adminAccount, u.countryId));
    const visibleRooms = Object.values(rooms).filter((r) => actorCanAccessCountry(req.adminAccount, r.countryId));
    const visibleUserIds = new Set(visibleUsers.map((u) => u.userId));
    const onlineCount = Object.keys(socketsByUserId).filter((uid) => visibleUserIds.has(uid)).length;
    res.json({
        success: true,
        stats: {
            totalUsers: visibleUsers.length,
            totalRooms: visibleRooms.length,
            onlineCount,
            bannedCount: visibleUsers.filter((u) => u.banned).length
        }
    });
});
app.get("/api/admin/live", requireAdmin, requirePermission("dashboard:view"), (req, res) => {
    const visibleUsers = Object.values(users).filter((u) => actorCanAccessCountry(req.adminAccount, u.countryId));
    const visibleUserIds = new Set(visibleUsers.map((u) => u.userId));
    const activeRooms = Object.values(rooms)
        .filter((r) => actorCanAccessCountry(req.adminAccount, r.countryId))
        .filter((r) => r.onlineUsers.length > 0)
        .map((r) => ({ roomName: r.roomName, hostName: r.hostName, onlineUsers: r.onlineUsers, onlineCount: r.onlineUsers.length }));
    const totalOnline = Object.keys(socketsByUserId).filter((uid) => visibleUserIds.has(uid)).length;
    res.json({ success: true, totalOnline, activeRooms });
});
// Phase 11: opt-in pagination, same backward-compatible pattern the
// /api/admin/logs route already established (see its own comment) — no
// ?page/?pageSize means every existing caller (admin/app.js today) keeps
// getting the full list exactly as before. Only scans/maps the full user
// base once either way (no way around that without an actual DB — see
// RBAC_MIGRATION_NOTES.md), but paginating the JSON payload itself keeps
// slow client-side rendering/network transfer bounded for a country with
// a very large user base.
app.get("/api/admin/users", requireAdmin, requirePermission("users:view"), (req, res) => {
    const list = Object.values(users)
        .filter((u) => actorCanAccessCountry(req.adminAccount, u.countryId))
        .map((u) => ({
            name: u.name, userId: u.userId, mobile: u.mobile, coins: u.coins, diamonds: u.diamonds, vipLevel: u.vipLevel, verified: !!u.verified, banned: u.banned, customTag: u.customTag || null, customId: u.customId || null, nameEffect: u.nameEffect || null, countryId: u.countryId,
            // First Time Profile Setup fields — lets the admin panel show
            // which real country (with flag) the account belongs to, not
            // just the broad IN/BD/PK/AR/OTHERS RBAC scoping bucket.
            country: u.country || null, countryFlag: u.country ? countries.flagEmoji(u.country) : null,
            countryName: u.country ? (countries.COUNTRY_BY_ID[u.country] ? countries.COUNTRY_BY_ID[u.country].name_en : null) : null,
            gender: u.gender || null, language: u.language || null, profileCompleted: !!u.profile_completed
        }));

    const { page, pageSize } = req.query;
    if (!page && !pageSize) {
        return res.json({ success: true, users: list }); // unchanged default response shape
    }
    const p = Math.max(1, parseInt(page, 10) || 1);
    const ps = Math.min(500, Math.max(1, parseInt(pageSize, 10) || 100));
    const start = (p - 1) * ps;
    res.json({ success: true, users: list.slice(start, start + ps), total: list.length, page: p, pageSize: ps });
});
// Owner / Global Super Admin only (permission: country:manage, same as the
// rest of the country-structure controls) — reassigns which country bucket
// a user belongs to. Deliberately NOT opened to Country Super
// Admin/Manager/Admin, so a country-scoped admin can never relabel a user
// out of (or into) their own scope to dodge isolation.
app.post("/api/admin/users/:mobile/country", requireAdmin, requirePermission("country:manage"), (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "Not found" });
    const { countryId } = req.body;
    if (!rbac.COUNTRY_IDS.includes(countryId)) return res.json({ success: false, message: "Provide a valid Country" });
    u.countryId = countryId;
    saveUsers();
    rbac.logAction({ admin: req.adminAccount, action: "set-user-country", module: "users", targetType: "user", targetId: u.userId, meta: { countryId }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, countryId: u.countryId });
});

// ---------- Country Permission extension (integration_update package) ----------
// Additive only — mounts GET/PUT /api/admin/country-permission[/:countryId],
// a different path from /api/admin/countries above, so nothing collides.
// Reuses the existing rbac store, requireAdmin and requirePermission
// exactly as they are; does not modify rbac.js or any route above.
const countryPermission = require("./integration_update/country_permission")
    .attach({ app, rbac, requireAdmin, requirePermission, dataFolder: path.join(__dirname, "data") });

// ---------- Merchant extension (integration_update package, next stage after country_permission) ----------
// Additive only — mounts GET/POST/PUT /api/admin/merchants[/:id[/status]],
// a path that doesn't collide with anything above. Depends on
// countryPermission (attached immediately above) for country validity and
// scoping, per integration_update/country_permission/README.md's own
// "Next stage" note. Does not modify rbac.js, country_permission, or any
// route above.
const merchant = require("./integration_update/merchant")
    .attach({ app, rbac, requireAdmin, requirePermission, countryPermission, dataFolder: path.join(__dirname, "data") });
// Admin: set (or clear, with an empty value) a unique Custom ID Number for a
// user. Golden Light styling is applied client-side wherever it's shown; this
// endpoint just validates uniqueness and stores the value.
app.post("/api/admin/users/:mobile/custom-id", requireAdmin, requirePermission("users:edit"), (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, u.countryId)) return countryDeniedResponse(res);
    const clean = String(req.body.customId || "").trim();
    if (clean) {
        if (clean.length > 20) return res.json({ success: false, message: "Custom ID is too long, keep it within 20 characters" });
        if (isCustomIdTaken(clean, req.params.mobile)) return res.json({ success: false, message: "This Custom ID is already used by another user" });
        u.customId = clean;
    } else {
        u.customId = null;
    }
    saveUsers();
    syncProfileToRoom(u.userId);
    emitToUser(u.userId, "custom-id-updated", { customId: u.customId }); // GAP #1 — cross-instance-safe
    rbac.logAction({ admin: req.adminAccount, action: "user-set-custom-id", module: "users", targetType: "user", targetId: u.userId, after: { customId: u.customId }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, customId: u.customId });
});
app.post("/api/admin/users/:mobile/ban", requireAdmin, requirePermission("users:ban"), (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, u.countryId)) return countryDeniedResponse(res);
    const wasBanned = !!u.banned;
    u.banned = !!req.body.banned;
    saveUsers();
    if (u.banned) {
        emitToUser(u.userId, "kicked", { message: "Your account has been banned", forceLogout: true }); // GAP #1 — cross-instance-safe
    }
    rbac.logAction({ admin: req.adminAccount, action: u.banned ? "user-ban" : "user-unban", module: "users", targetType: "user", targetId: u.userId, before: { banned: wasBanned }, after: { banned: u.banned }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});
app.post("/api/admin/users/:mobile/verify", requireAdmin, requirePermission("users:verify"), (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, u.countryId)) return countryDeniedResponse(res);
    const wasVerified = !!u.verified;
    u.verified = !!req.body.verified;
    saveUsers();
    rbac.logAction({ admin: req.adminAccount, action: "user-verify", module: "users", targetType: "user", targetId: u.userId, before: { verified: wasVerified }, after: { verified: u.verified }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});
app.post("/api/admin/users/:mobile/coins", requireAdmin, requirePermission("users:coin-edit"), (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, u.countryId)) return countryDeniedResponse(res);
    const coinsRaw = Number(req.body.coins);
    // AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): isNaN()/`< 0`
    // rejects NaN and negative values but NOT Infinity — Number("Infinity")
    // is a finite-looking JS value that passes both of those checks, so
    // this endpoint could previously be used (accidentally or via a crafted
    // request) to set a user's coin balance to Infinity, which then
    // poisons every downstream arithmetic use of that balance (gifts,
    // exchanges, level calc) with Infinity/NaN. Number.isFinite() rejects
    // Infinity/-Infinity/NaN in one check, and the shared clampCoinBalance()
    // ceiling (already used for game-reward paths) is applied here too so
    // an admin typo of a huge value can't push a balance past the same
    // safe-integer ceiling every other credit path respects.
    if (!Number.isFinite(coinsRaw) || coinsRaw < 0) return res.json({ success: false, message: "Enter a valid number" });
    const coins = clampCoinBalance(u.userId, coinsRaw, "admin-coin-edit");
    const diff = coins - u.coins;
    const before = u.coins;
    u.coins = coins;
    // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
    saveUsers();
    logTransaction(u.userId, "coins", diff, "Admin adjustment");
    pushWalletUpdate(u.userId);
    rbac.logAction({ admin: req.adminAccount, action: "user-coin-edit", module: "users", targetType: "user", targetId: u.userId, before: { coins: before }, after: { coins: u.coins }, meta: { diff }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});

// ---------- Admin Coin Center ----------
// A separate feature from the coin-set endpoint above: this *adds* coins
// from a tracked system pool (rather than overwriting a user's balance),
// always shows as "Coin Center" in the user's own transaction history
// (never an admin username), and is idempotent via requestId.
app.get("/api/admin/coin-center/balance", requireAdmin, requirePermission("coin-center:view"), (req, res) => {
    res.json({ success: true, systemBalance: coinCenter.getSystemBalance() });
});
app.post("/api/admin/coin-center/balance", requireAdmin, requirePermission("coin-center:send"), (req, res) => {
    const result = coinCenter.setSystemBalance(req.body.amount, adminUsernameFromReq(req));
    rbac.logAction({ admin: req.adminAccount, action: "coin-center-balance-set", module: "coin-center", targetType: "systemPool", after: { amount: req.body.amount }, ip: req.ip, userAgent: reqUserAgent(req), result: result && result.success === false ? "failed" : "success", failureReason: result && result.success === false ? result.message : null });
    res.json(result);
});
app.get("/api/admin/coin-center/search", requireAdmin, requirePermission("coin-center:view"), (req, res) => {
    const found = coinCenter.findUserByIdOrMobile(req.query.query);
    if (!found) return res.json({ success: false, message: "User not found" });
    res.json({ success: true, user: { userId: found.user.userId, name: found.user.name, mobile: found.mobile, coins: found.user.coins, photo: found.user.photo || "" } });
});
app.post("/api/admin/coin-center/send", requireAdmin, requirePermission("coin-center:send"), (req, res) => {
    const { targetUserId, amount, reason, requestId } = req.body;
    if (!targetUserId) return res.json({ success: false, message: "Enter Target User ID" });
    const result = coinCenter.sendCoins({ targetUserId, amount, reason, requestId, adminUsername: adminUsernameFromReq(req) });
    rbac.logAction({ admin: req.adminAccount, action: "coin-center-send", module: "coin-center", targetType: "user", targetId: targetUserId, meta: { amount, reason }, ip: req.ip, userAgent: reqUserAgent(req), result: result && result.success === false ? "failed" : "success", failureReason: result && result.success === false ? result.message : null });
    res.json(result);
});
app.post("/api/admin/coin-center/send-bulk", requireAdmin, requirePermission("coin-center:send"), (req, res) => {
    const { targetUserIds, amount, reason, requestId } = req.body;
    if (!Array.isArray(targetUserIds) || !targetUserIds.length) return res.json({ success: false, message: "Select at least one user" });
    const result = coinCenter.sendCoinsBulk({ targetUserIds, amount, reason, requestId, adminUsername: adminUsernameFromReq(req) });
    rbac.logAction({ admin: req.adminAccount, action: "coin-center-send-bulk", module: "coin-center", targetType: "user", targetId: targetUserIds.join(","), meta: { amount, reason, count: targetUserIds.length }, ip: req.ip, userAgent: reqUserAgent(req), result: result && result.success === false ? "failed" : "success", failureReason: result && result.success === false ? result.message : null });
    res.json(result);
});
app.get("/api/admin/coin-center/log", requireAdmin, requirePermission("coin-center:view"), (req, res) => {
    res.json({ success: true, log: coinCenter.getLog(100) });
});

// ---------- Admin Coin Center — Accounts (Agency-style operators) ----------
// Admin creates/removes/enables/disables any User ID as a "Coin Center".
// That user then gets their own send-coins panel in the app (see the
// public /api/coin-center/* routes below), fully separate from the
// direct-send feature above. Only Admin Panel can manage the accounts
// themselves — never self-service.
app.get("/api/admin/coin-center/accounts", requireAdmin, requirePermission("coin-center:view"), (req, res) => {
    res.json({ success: true, accounts: coinCenter.listAccounts() });
});
app.post("/api/admin/coin-center/accounts/create", requireAdmin, requirePermission("coin-center:send"), (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.json({ success: false, message: "Enter User ID" });
    const result = coinCenter.createAccount(String(userId).trim(), adminUsernameFromReq(req));
    rbac.logAction({ admin: req.adminAccount, action: "coin-center-account-create", module: "coin-center", targetType: "coinCenterAccount", targetId: String(userId).trim(), ip: req.ip, userAgent: reqUserAgent(req), result: result && result.success === false ? "failed" : "success", failureReason: result && result.success === false ? result.message : null });
    res.json(result);
});
app.post("/api/admin/coin-center/accounts/:userId/remove", requireAdmin, requirePermission("coin-center:send"), (req, res) => {
    const result = coinCenter.removeAccount(req.params.userId);
    rbac.logAction({ admin: req.adminAccount, action: "coin-center-account-remove", module: "coin-center", targetType: "coinCenterAccount", targetId: req.params.userId, ip: req.ip, userAgent: reqUserAgent(req), result: result && result.success === false ? "failed" : "success", failureReason: result && result.success === false ? result.message : null });
    res.json(result);
});
app.post("/api/admin/coin-center/accounts/:userId/toggle", requireAdmin, requirePermission("coin-center:send"), (req, res) => {
    const { enabled } = req.body;
    const isEnabled = enabled === true || enabled === "true";
    const result = coinCenter.setAccountEnabled(req.params.userId, isEnabled);
    rbac.logAction({ admin: req.adminAccount, action: "coin-center-account-toggle", module: "coin-center", targetType: "coinCenterAccount", targetId: req.params.userId, after: { enabled: isEnabled }, ip: req.ip, userAgent: reqUserAgent(req), result: result && result.success === false ? "failed" : "success", failureReason: result && result.success === false ? result.message : null });
    res.json(result);
});
app.post("/api/admin/coin-center/accounts/:userId/topup", requireAdmin, requirePermission("coin-center:send"), (req, res) => {
    const result = coinCenter.topUpAccount(req.params.userId, req.body.amount, adminUsernameFromReq(req));
    rbac.logAction({ admin: req.adminAccount, action: "coin-center-account-topup", module: "coin-center", targetType: "coinCenterAccount", targetId: req.params.userId, meta: { amount: req.body.amount }, ip: req.ip, userAgent: reqUserAgent(req), result: result && result.success === false ? "failed" : "success", failureReason: result && result.success === false ? result.message : null });
    res.json(result);
});
app.get("/api/admin/coin-center/accounts/:userId/log", requireAdmin, requirePermission("coin-center:view"), (req, res) => {
    res.json({ success: true, log: coinCenter.getAccountLog(req.params.userId, 200) });
});

// ---------- Coin Center operator — public routes, used by the operator's own app panel ----------
// "mine" mirrors the /api/agency/mine/:userId pattern: returns null (not an
// error) when the given userId isn't a Coin Center, so the client can just
// hide the menu entry.
app.get("/api/coin-center/mine/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: "You can only access your own Coin Center account" });
    res.json({ success: true, account: coinCenter.myAccount(actor.userId) });
});
// Phase 15: the operator's identity now comes from the verified session
// (their own userId), not a client-supplied `operatorUserId` — previously
// anyone could impersonate any coin-center operator and drain their coins
// by simply putting a different operatorUserId in the request body.
app.post("/api/coin-center/send", userAuth.requireUserAuth, (req, res) => {
    const { targetUserId, amount, reason, requestId } = req.body;
    const operator = users[resolveUserKey(req)];
    if (!operator) return res.json({ success: false, message: "User not found" });
    const operatorUserId = operator.userId;
    if (!targetUserId) return res.json({ success: false, message: "Enter Target User ID" });
    const result = coinCenter.accountSendCoins({ operatorUserId, targetUserId, amount, reason, requestId });
    res.json(result);
});
app.get("/api/coin-center/log/:userId", userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: "You can only access your own Coin Center log" });
    res.json({ success: true, log: coinCenter.getAccountLog(actor.userId, 100) });
});

app.delete("/api/admin/users/:mobile", requireAdmin, requirePermission("users:delete"), (req, res) => {
    const u = users[resolveUserKey(req)];
    if (!u) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, u.countryId)) return countryDeniedResponse(res);
    const sid = socketsByUserId[u.userId];
    if (sid) {
        const s = io.sockets.sockets.get(sid);
        if (s && s.currentRoom) handleUserLeaveRoom(s.currentRoom, u.userId, s);
    }
    emitToUser(u.userId, "kicked", { message: "Your account has been deleted", forceLogout: true }); // GAP #1 — cross-instance-safe (reaches every device/instance, not just this one's local socket)
    delete users[resolveUserKey(req)];
    userIndex.unindexUser(u.userId); // Phase 11: keep O(1) lookup index in sync
    saveUsers();
    rbac.logAction({ admin: req.adminAccount, action: "user-delete", module: "users", targetType: "user", targetId: u.userId, before: { mobile: req.params.mobile, name: u.name }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});

app.get("/api/admin/rooms", requireAdmin, requirePermission("rooms:view"), (req, res) => {
    const list = Object.values(rooms)
        .filter((r) => actorCanAccessCountry(req.adminAccount, r.countryId))
        // Moderator Room Restriction (SRS item 3): a Moderator's room list
        // is additionally narrowed to only their assignedRoomIds — this is
        // the "cannot view" half of item 3, the API-level checks below on
        // each individual room action are the "cannot manage" half.
        .filter((r) => rbac.inRoomScope(req.adminAccount, r.roomId))
        .map((r) => ({ roomId: r.roomId, roomNumber: r.roomNumber || r.hostId, roomName: r.roomName, hostName: r.hostName, onlineCount: r.onlineUsers.length, roomLocked: !!r.roomLocked, gameEnabled: r.gameEnabled !== false, countryId: r.countryId }));
    res.json({ success: true, rooms: list });
});
app.post("/api/admin/rooms/:roomId/lock", requireAdmin, requirePermission("rooms:lock"), requireRoomScope, (req, res) => {
    const room = safeRoomLookup(req.params.roomId);
    if (!room) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, room.countryId)) return countryDeniedResponse(res);
    room.roomLocked = !!req.body.locked;
    rbac.logAction({ admin: req.adminAccount, action: room.roomLocked ? "room-lock" : "room-unlock", module: "rooms", targetType: "room", targetId: room.roomId, after: { roomLocked: room.roomLocked }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});
app.post("/api/admin/rooms/:roomId/game", requireAdmin, requirePermission("rooms:seat-manage"), requireRoomScope, (req, res) => {
    const room = safeRoomLookup(req.params.roomId);
    if (!room) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, room.countryId)) return countryDeniedResponse(res);
    room.gameEnabled = !!req.body.enabled;
    saveRoomsToDisk();
    // Push the change live so anyone already in the room sees the game
    // button appear/disappear immediately, no refresh needed.
    io.to(room.roomId).emit("room-state", publicRoom(room));
    console.log(`🎮 Game ${room.gameEnabled ? "enabled" : "disabled"} for room "${room.roomName}" (by admin)`);
    rbac.logAction({ admin: req.adminAccount, action: room.gameEnabled ? "room-game-enable" : "room-game-disable", module: "rooms", targetType: "room", targetId: room.roomId, after: { gameEnabled: room.gameEnabled }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, gameEnabled: room.gameEnabled });
});
app.get("/api/admin/cs101", requireAdmin, requirePermission("ai-core:view"), (req, res) => {
    res.json({ success: true, config: cs101Config, room: cs101PublicState(), voiceErrors: cs101VoiceErrors.slice(-20).reverse() });
});

// Robin voice-health snapshot for the Admin Panel. Separate, lightweight
// endpoint (rather than folding into the config GET above) so the panel can
// poll it every few seconds for a live "is Robin currently having voice
// problems" badge without re-fetching the full config payload each time.
app.get("/api/admin/cs101/voice-health", requireAdmin, requirePermission("ai-core:view"), (req, res) => {
    const now = Date.now();
    const recentWindowMs = 15 * 60 * 1000; // last 15 minutes
    const recent = cs101VoiceErrors.filter(e => now - e.ts < recentWindowMs);
    res.json({
        success: true,
        healthy: recent.length === 0,
        recentErrorCount: recent.length,
        totalTracked: cs101VoiceErrors.length,
        errors: cs101VoiceErrors.slice(-20).reverse()
    });
});

app.put("/api/admin/cs101", requireAdmin, requirePermission("ai-core:manage"), (req, res) => {
    const body = req.body || {};
    if (body.agentName != null) cs101Config.agentName = String(body.agentName).trim().slice(0, 80) || DEFAULT_CS101_CONFIG.agentName;
    if (body.roomAdminName != null) cs101Config.roomAdminName = String(body.roomAdminName).trim().slice(0, 80) || cs101Config.agentName;
    if (body.greeting != null) cs101Config.greeting = String(body.greeting).trim().slice(0, 1400) || DEFAULT_CS101_CONFIG.greeting;
    if (body.instruction != null) cs101Config.instruction = String(body.instruction).trim().slice(0, 6000);
    if (body.enabled != null) cs101Config.enabled = !!body.enabled;
    if (body.voiceEnabled != null) cs101Config.voiceEnabled = !!body.voiceEnabled;
    if (body.voiceRate != null) cs101Config.voiceRate = Math.max(0.7, Math.min(1.2, Number(body.voiceRate) || 0.96));
    if (body.voicePitch != null) cs101Config.voicePitch = Math.max(0.7, Math.min(1.4, Number(body.voicePitch) || 1.08));
    if (body.vapiDemoUrl != null) {
        const demo = String(body.vapiDemoUrl).trim();
        if (demo && !/^https:\/\/vapi\.ai\/\?/.test(demo)) return res.status(400).json({ success: false, message: "Vapi Demo Link must be an https://vapi.ai/?... URL." });
        cs101Config.vapiDemoUrl = demo.slice(0, 2000);
    }
    if (body.openSeatCount != null) cs101Config.openSeatCount = Math.max(1, Math.min(8, Number(body.openSeatCount) || 1));
    if (body.roomBackgroundUrl != null) cs101Config.roomBackgroundUrl = String(body.roomBackgroundUrl).trim().slice(0, 500) || DEFAULT_CS101_CONFIG.roomBackgroundUrl;
    if (Array.isArray(body.officialUserIds)) cs101Config.officialUserIds = body.officialUserIds.map(v => String(v).trim()).filter(Boolean).slice(0, 50);
    if (body.officialContacts && typeof body.officialContacts === "object") {
        cs101Config.officialContacts = {
            ...(cs101Config.officialContacts || DEFAULT_CS101_CONFIG.officialContacts),
            labibName: String(body.officialContacts.labibName || "Official Labib").trim().slice(0, 80),
            rakeshName: String(body.officialContacts.rakeshName || "Official Rakesh").trim().slice(0, 80),
            phone: String(body.officialContacts.phone || "8101221193").trim().slice(0, 30)
        };
    }
    saveCs101Config();
    ensureOfficialCustomerServiceRoom();
    io.emit("room-list", roomListPublic());
    io.to(CS101_ROOM_ID).emit("room-state", publicRoom(rooms[CS101_ROOM_ID]));
    io.to(CS101_ROOM_ID).emit("cs101:config", cs101PublicState());
    rbac.logAction({ admin: req.adminAccount, action: "cs101-config-update", module: "ai-core", targetType: "room", targetId: CS101_ROOM_ID, after: { agentName: cs101Config.agentName, enabled: cs101Config.enabled, voiceEnabled: cs101Config.voiceEnabled }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, config: cs101Config, room: cs101PublicState() });
});

app.post("/api/admin/cs101/avatar", requireAdmin, requirePermission("ai-core:manage"), uploadPhoto.single("avatar"), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "Avatar image is required" });
    cs101Config.avatarUrl = "/photos/" + req.file.filename;
    saveCs101Config();
    io.to(CS101_ROOM_ID).emit("cs101:config", cs101PublicState());
    io.to(CS101_ROOM_ID).emit("room-state", publicRoom(rooms[CS101_ROOM_ID]));
    res.json({ success: true, avatarUrl: cs101Config.avatarUrl, config: cs101Config });
});

// Public Vapi client configuration. This endpoint intentionally returns only
// the Vapi Public Key and the fixed assistant ID. Never return VAPI_API_KEY,
// Authorization tokens, or any private credential from this route.
app.get("/api/vapi/config", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
        success: true,
        enabled: !!VAPI_PUBLIC_KEY && !!VAPI_ASSISTANT_ID,
        publicKey: VAPI_PUBLIC_KEY,
        assistantId: VAPI_ASSISTANT_ID,
        agentName: "Robin",
        demoUrl: cs101Config.vapiDemoUrl || VAPI_DEMO_URL || "",
        roomId: CS101_ROOM_ID,
        roomNumber: CS101_ROOM_NUMBER
    });
});

app.post("/api/admin/cs101/room-image", requireAdmin, requirePermission("ai-core:manage"), uploadBg.single("background"), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: "Room image is required" });
    cs101Config.roomBackgroundUrl = "/backgrounds/" + req.file.filename;
    saveCs101Config();
    const room = ensureOfficialCustomerServiceRoom();
    room.background = cs101Config.roomBackgroundUrl;
    saveRoomsToDisk();
    io.to(CS101_ROOM_ID).emit("cs101:config", cs101PublicState());
    io.to(CS101_ROOM_ID).emit("room-background-update", { url: room.background });
    io.to(CS101_ROOM_ID).emit("room-state", publicRoom(room));
    res.json({ success: true, roomBackgroundUrl: cs101Config.roomBackgroundUrl, config: cs101Config });
});

app.delete("/api/admin/rooms/:roomId", requireAdmin, requirePermission("rooms:delete"), requireRoomScope, (req, res) => {
    const room = safeRoomLookup(req.params.roomId);
    if (!room) return res.json({ success: false, message: "Not found" });
    if (String(req.params.roomId) === CS101_ROOM_ID) {
        return res.status(403).json({ success: false, message: "Official AI Customer Service Room 101 cannot be deleted." });
    }
    if (!actorCanAccessCountry(req.adminAccount, room.countryId)) return countryDeniedResponse(res);
    io.to(room.roomId).emit("kicked", { message: "Room closed (admin)" });
    rbac.logAction({ admin: req.adminAccount, action: "room-delete", module: "rooms", targetType: "room", targetId: room.roomId, before: { roomName: room.roomName }, ip: req.ip, userAgent: reqUserAgent(req) });
    fwTeardownRoom(room.roomId); // STABILIZATION FIX (Phase 3): stop any orphaned Fruit Wheel interval
    voiceSfu.sync.onRoomClosed(room.roomId); // PHASE 3, STEP 3.4 — deletes the mapped LiveKit room; no-op unless VOICE_MODE=sfu
    if (isSafeObjectKey(req.params.roomId)) delete rooms[req.params.roomId];
    saveRoomsToDisk();
    io.emit("room-list", roomListPublic());
    res.json({ success: true });
});

// ---- Moderator Room Restriction (RBAC Phase 3) — new room-scoped actions.
// These are the admin-panel (REST) equivalents of the in-room socket
// actions a room host/co-admin already has (kick-user, mod-mute-users,
// lock-seat) — added here so a Moderator account can actually exercise the
// permissions the SRS grants them (Kick User, Mute User, Seat Lock/Unlock)
// from the admin panel, gated by BOTH requirePermission and
// requireRoomScope. Business logic mirrors the existing socket handlers
// exactly; nothing about the underlying room features changes (SRS item 9).
app.post("/api/admin/rooms/:roomId/kick", requireAdmin, requirePermission("rooms:kick-user"), requireRoomScope, (req, res) => {
    const room = safeRoomLookup(req.params.roomId);
    if (!room) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, room.countryId)) return countryDeniedResponse(res);
    const targetUserId = req.body.targetUserId;
    if (!targetUserId || targetUserId === room.hostId) return res.json({ success: false, message: "Invalid target" });
    if (isImmuneUser(targetUserId)) return res.status(403).json({ success: false, message: "Target user is Immune — action cannot be taken" });
    const targetSocketId = socketsByUserId[targetUserId];
    handleUserLeaveRoom(room.roomId, targetUserId, null);
    emitToUser(targetUserId, "kicked", { message: "You were removed from the room via the Admin panel" }); // GAP #1 — cross-instance-safe
    if (targetSocketId) {
        const s = io.sockets.sockets.get(targetSocketId);
        if (s) { s.leave(room.roomId); s.currentRoom = null; }
    }
    rbac.logAction({ admin: req.adminAccount, action: "room-kick-user", module: "rooms", targetType: "room", targetId: room.roomId, meta: { targetUserId }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});
app.post("/api/admin/rooms/:roomId/mute", requireAdmin, requirePermission("rooms:mute-user"), requireRoomScope, (req, res) => {
    const room = safeRoomLookup(req.params.roomId);
    if (!room) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, room.countryId)) return countryDeniedResponse(res);
    const targetUserId = req.body.targetUserId;
    if (!targetUserId || targetUserId === room.hostId) return res.json({ success: false, message: "Invalid target" });
    if (isImmuneUser(targetUserId)) return res.status(403).json({ success: false, message: "Target user is Immune — action cannot be taken" });
    room.mutedUntil = room.mutedUntil || {};
    const mins = Math.max(0, Math.min(1440, parseInt(req.body.minutes, 10) || 0));
    const until = mins > 0 ? Date.now() + mins * 60000 : 0;
    if (until > 0) room.mutedUntil[targetUserId] = until; else delete room.mutedUntil[targetUserId];
    io.to(room.roomId).emit("mod-mute-update", { targetUserIds: [targetUserId], mutedUntil: until || null });
    io.to(room.roomId).emit("room-state", publicRoom(room));
    rbac.logAction({ admin: req.adminAccount, action: until ? "room-mute-user" : "room-unmute-user", module: "rooms", targetType: "room", targetId: room.roomId, meta: { targetUserId, minutes: mins }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, mutedUntil: until || null });
});
app.post("/api/admin/rooms/:roomId/seat-lock", requireAdmin, requirePermission("rooms:seat-lock"), requireRoomScope, (req, res) => {
    const room = safeRoomLookup(req.params.roomId);
    if (!room) return res.json({ success: false, message: "Not found" });
    if (!actorCanAccessCountry(req.adminAccount, room.countryId)) return countryDeniedResponse(res);
    const seatNumber = parseInt(req.body.seatNumber, 10);
    if (!seatNumber) return res.json({ success: false, message: "Provide a valid seatNumber" });
    const locked = !!req.body.locked;
    room.lockedSeats = room.lockedSeats || [];
    if (locked) { if (!room.lockedSeats.includes(seatNumber)) room.lockedSeats.push(seatNumber); }
    else room.lockedSeats = room.lockedSeats.filter((n) => n !== seatNumber);
    io.to(room.roomId).emit("seat-lock-update", { seatNumber, locked });
    rbac.logAction({ admin: req.adminAccount, action: locked ? "room-seat-lock" : "room-seat-unlock", module: "rooms", targetType: "room", targetId: room.roomId, meta: { seatNumber }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true, lockedSeats: room.lockedSeats });
});

app.get("/api/admin/exchanges", requireAdmin, requirePermission("withdraw:view"), (req, res) => {
    // Exchanges don't store their own countryId — the requesting user's
    // *current* country is looked up live instead, so a later re-assignment
    // (POST /api/admin/users/:mobile/country) is reflected immediately.
    const list = exchanges.filter((e) => {
        const found = findUserByUserId(e.userId);
        return actorCanAccessCountry(req.adminAccount, found ? found.user.countryId : "OTHERS");
    });
    res.json({ success: true, exchanges: list.slice().reverse() });
});
app.post("/api/admin/exchanges/:id/decide", requireAdmin, requirePermission("withdraw:approve"), (req, res) => {
    const ex = exchanges.find((e) => e.id === req.params.id);
    if (!ex) return res.json({ success: false, message: "Not found" });
    if (ex.status !== "pending") return res.json({ success: false, message: "A decision has already been made" });
    const found = findUserByUserId(ex.userId);
    if (!actorCanAccessCountry(req.adminAccount, found ? found.user.countryId : "OTHERS")) return countryDeniedResponse(res);
    const { approve } = req.body;
    if (approve) {
        if (!found || found.user.diamonds < ex.diamonds) {
            ex.status = "rejected";
            safeWrite(EXCHANGES_FILE, exchanges);
            return res.json({ success: false, message: "Not enough diamonds, request rejected" });
        }
        found.user.diamonds -= ex.diamonds;
        const coinsGained = ex.diamonds * 10;
        found.user.coins = clampCoinBalance(ex.userId, found.user.coins + coinsGained, "admin-exchange-decide");
        // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
        saveUsers();
        logTransaction(ex.userId, "diamonds", -ex.diamonds, "Exchange approved");
        logTransaction(ex.userId, "coins", coinsGained, "Exchange approved");
        ex.status = "approved";
        pushWalletUpdate(ex.userId);
    } else {
        ex.status = "rejected";
    }
    safeWrite(EXCHANGES_FILE, exchanges);
    rbac.logAction({ admin: req.adminAccount, action: approve ? "withdraw-approve" : "withdraw-reject", module: "withdraw", targetType: "exchange", targetId: ex.id, after: { status: ex.status, diamonds: ex.diamonds }, ip: req.ip, userAgent: reqUserAgent(req) });
    res.json({ success: true });
});

// ==================================================
// SOCKET.IO — real-time rooms, voice signaling, chat, gifts, games
// ==================================================
// Tell every online follower of `userId` that their status just changed —
// powers the Home screen "Following" tab's live green-dot/Live-badge updates.
// status is one of "live" (entered/updated a room), "online" (connected, not
// in a room) or "offline" (disconnected). roomInfo is only relevant for "live".
function broadcastFollowStatus(userId, status, roomInfo) {
    const found = findUserByUserId(userId);
    if (!found) return;
    const payload = {
        userId,
        userName: found.user.name,
        userPhoto: found.user.photo || "",
        status,
        roomId: roomInfo ? roomInfo.roomId : null,
        roomNumber: roomInfo ? roomInfo.roomNumber : null,
        roomName: roomInfo ? roomInfo.roomName : null
    };
    (found.user.followersList || []).forEach((followerId) => {
        emitToUser(followerId, "follow-status-update", payload); // GAP #1 — was socketsByUserId[followerId]-gated (local-instance only); now cross-instance-safe, see emitToUser()'s header
    });
}

// Add/update an entry in the visitor's "Recently" room history — one entry
// per room (re-visiting bumps it to the top instead of duplicating), newest
// first, capped at 50 per the spec.
function recordRecentRoomVisit(visitorUserId, room) {
    const found = findUserByUserId(visitorUserId);
    if (!found || !room) return;
    if (!Array.isArray(found.user.recentRooms)) found.user.recentRooms = [];
    const list = found.user.recentRooms.filter((e) => e.roomId !== room.roomId);
    list.unshift({
        roomId: room.roomId,
        roomNumber: room.roomNumber || room.hostId,
        roomName: room.roomName,
        hostId: room.hostId,
        hostName: room.hostName,
        lastVisitAt: new Date().toISOString()
    });
    found.user.recentRooms = list.slice(0, 50);
    saveUsers();
}

function handleUserLeaveRoom(roomId, userId, socket, isDisconnecting = false) {
    const room = rooms[roomId];
    if (!room) return;
    // ROOT-CAUSE FIX (2026-08-14, socket lifecycle race protection): a
    // second, top-of-function guard for the disconnect-grace-period call
    // path specifically. The grace timer in the "disconnect" handler
    // already checks this before calling in — this repeats the check here
    // so ANY current or future isDisconnecting=true call site (not just
    // that one timer) gets the same protection for free, and so this
    // function can never be accidentally used to tear down a newer
    // session's room membership out from under it. A live "leave-room"
    // (isDisconnecting=false, the user's own current socket asking to
    // leave) is never subject to this — that socket IS the authoritative
    // one for its own request.
    if (isDisconnecting && socket && socketsByUserId[userId] && socketsByUserId[userId] !== socket.id) {
        console.log(`⏭️  handleUserLeaveRoom: skipping stale disconnect-cleanup for user ${userId} in room ${roomId} — a newer socket (${socketsByUserId[userId]}) is already active (stale socket ${socket.id})`);
        return;
    }
    let seatNumber = null;
    room.seats.forEach((s, i) => {
        if (s && s.userId === userId) {
            // ROOT-CAUSE FIX (2026-08-14, seat cleanup): before freeing a
            // seat on a disconnect-grace expiry, verify the seat is still
            // actually occupied by socket that's disconnecting. If a
            // different (newer) socketId already took/re-took this exact
            // seat — e.g. the user reconnected and re-sat between the
            // original disconnect and this grace timer firing, in a
            // narrow window the socketsByUserId check above didn't happen
            // to catch — a stale disconnect must never free a seat that
            // belongs to that newer session. Live, explicit leave-room
            // calls (isDisconnecting=false) are unaffected: those always
            // free whichever seat the requesting user currently holds.
            if (isDisconnecting && socket && s.socketId && s.socketId !== socket.id) {
                console.log(`⏭️  handleUserLeaveRoom: not freeing seat ${i + 1} for user ${userId} — occupied by a newer socket (${s.socketId}) than the disconnecting one (${socket.id})`);
                return;
            }
            seatNumber = i + 1;
            room.seats[i] = null;
        }
    });
    room.onlineUsers = room.onlineUsers.filter((u) => u.userId !== userId);
    if (room.mutedUntil) delete room.mutedUntil[userId];
    if (room.seatLabels) delete room.seatLabels[userId];
    if (seatNumber) {
        io.to(roomId).emit("seat-update", { action: "leave", seatNumber, userId });
        friendshipCp.emitToRoomRelationshipState(room);
    }

    // AUDIT FIX (2026-07-27, permanent-ownership) — Host migration removed.
    // Previous behaviour silently reassigned room.hostId to another present
    // user once the host's reconnect grace period expired. That violates
    // the requirement that a room owner is PERMANENT and only changes via
    // an explicit transfer, admin action, or the owner deleting/closing the
    // room. room.hostId is left untouched here on purpose — the owner keeps
    // their room even while offline.
    //
    // This does bring back the situation the old migration was working
    // around: while the owner is offline, nobody present has host powers
    // (close-room/kick/lock/etc. all gate on `room.hostId === socket.userId`)
    // — that's correct for a permanent-ownership model, not a bug. The owner
    // is never locked out: /api/room/create's "existing room" check (by
    // hostId, unchanged) and a direct room rejoin both drop them straight
    // back into this SAME room — same roomId, same settings — the moment
    // they reconnect.
    if (room.hostId === userId) {
        console.log(`👑 Owner ${userId} is now offline in room ${roomId} — ownership retained, no migration`);
    }

    // AUDIT FIX (2026-07-27, room-permanence) — Ghost room auto-cleanup
    // removed. Previous behaviour deleted an empty room — including its
    // roomId, settings, moderators, seat config, and queue — 10 minutes
    // after the last person left. That violates the requirement that room
    // metadata and roomId persist permanently until the owner explicitly
    // deletes/closes the room (existing `close-room` event, unchanged) or
    // an admin does so. An empty room is now simply left as-is in memory
    // and on disk (saveRoomsToDisk() already persists it across restarts).
    //
    // Tradeoff, flagged rather than hidden: rooms whose owners never
    // return and never explicitly close them will now accumulate
    // indefinitely instead of self-cleaning after 10 minutes. If that
    // becomes a real storage concern later, add an *explicit*, long-horizon
    // admin cleanup tool (e.g. "rooms empty 90+ days, owner never seen") —
    // not a silent automatic one, since that's exactly the kind of
    // behavior this fix was asked to eliminate.

    io.to(roomId).emit("user-count", { count: room.onlineUsers.length });
    io.to(roomId).emit("room-state", publicRoom(room));
    // ROOT-CAUSE FIX (2026-07-28, private-call / online-presence bug):
    // this used to delete the user's socketsByUserId entry any time they
    // left a room for ANY reason — explicit "leave room", being kicked,
    // switching rooms, an admin action — not only on a real disconnect.
    // socketsByUserId is the single source of truth for "is this user
    // online" (green dot) AND is exactly what callSignaling.js looks up to
    // ring/route a Voice or Video call. So a user who was still fully
    // connected — just not inside a room — looked/behaved offline: no
    // online dot, and any call to them got "call:offline" instead of
    // ringing, even though their socket was live the whole time. Only an
    // actual disconnect (grace period expired with no reconnect) should
    // clear this entry now; every live "leave room" call site keeps
    // passing isDisconnecting=false (the default) so presence is untouched.
    if (isDisconnecting && socketsByUserId[userId] && (!socket || socketsByUserId[userId] === socket.id)) delete socketsByUserId[userId];
    // Fix (couldn't actually leave a room): this function updated the room's
    // data and told everyone else, but never removed the leaving socket
    // from the Socket.IO room itself — so their connection quietly stayed
    // subscribed to the old room's broadcasts (chat/gifts/room-state), and
    // joining a second room afterwards left them double-subscribed to both.
    if (socket) {
        socket.leave(roomId);
        if (socket.currentRoom === roomId) socket.currentRoom = null;
    }
    console.log(`🚶 User ${userId} left room ${roomId}${seatNumber ? ` (freed seat ${seatNumber})` : ""}`);
    io.emit("room-list", roomListPublic());
    // Still connected (just not in a room) unless this was also a full disconnect —
    // the "disconnect" handler sends "offline" separately when the socket is gone.
    if (socketsByUserId[userId]) broadcastFollowStatus(userId, "online", null);

    // PHASE 3, STEP 3.4 — this is the ONE shared function every leave path
    // (explicit leave-room, kick-user, close-room's member-clear, and
    // disconnect-grace-period expiry) already funnels through, so it's the
    // single hook point for both participant-level and room-level SFU
    // synchronization. Both calls are no-ops unless VOICE_MODE=sfu and
    // never throw/block this function — see voice_sfu/sync.js.
    voiceSfu.sync.onParticipantLeftRoom(roomId, userId);
    voiceSfu.sync.onRoomPossiblyEmpty(roomId, room.onlineUsers.length === 0);
}

// ---------- Fruit Wheel (Food Wheel) — server-authoritative game engine ----------
// The wheel's result, every bet, and every payout are decided and settled
// here, and only here. Connected clients receive the outcome via the
// "fruitwheel-round" / "fruitwheel-winners" broadcasts below and simply
// play the matching animation — a client is never trusted to report its
// own result or its own balance change for this game.
// FRUIT-THEME FIX (2026-08-02): this list must always be identical, id-for-id,
// to the client's food set in public/foodwheel/index.html (`Wn`) — a
// mismatch here is what caused the earlier blank-screen crash. The old
// fish/burger/pizza/chicken entries were non-veg items that don't belong in
// this party game and have been removed; the client's real fruit set (the
// one actually shown in the UI) is now the single source of truth for both
// sides.
const FRUIT_WHEEL_FOODS = [
    { id: "orange", mult: 5 },
    { id: "lemon", mult: 5 },
    { id: "grape", mult: 5 },
    { id: "cherry", mult: 5 },
    { id: "apple", mult: 10 },
    { id: "watermelon", mult: 15 },
    { id: "mango", mult: 25 },
    { id: "strawberry", mult: 45 }
];
// STABILIZATION FIX (Bug #1, Teen Patti/Food Wheel audit, 2026-08-02): the
// bundled client's chip selector (public/foodwheel/index.html, `Ri` array)
// offers 1K / 10K / 50K / 100K / 500K / 1M. This allow-list previously
// listed a completely different, much smaller set of amounts (10 / 100 /
// 500 / 1,000 / 5,000 / 10,000) that the client never actually offers, so
// any real tap on the bundle's chip UI was silently rejected here — the
// client showed a bet as placed while the server recorded nothing and
// deducted nothing. Aligned to match the client's real chip set exactly.
const FRUIT_WHEEL_CHIPS = [1000, 10000, 50000, 100000, 500000, 1000000];
const FW_BETTING_MS = 20000;
const FW_SPINNING_MS = 5000;
const FW_RESULT_MS = 3000;
const fruitWheelRooms = {}; // roomId -> { phase, bets, betLog, rejectedBets, resultFoodId, phaseEndsAt, viewers, timer, emptyTimer }

// STABILIZATION (Full Lucky Fruit audit, 2026-08-06): persistent, traceable
// audit trail — every finished round is appended to data/fruit_wheel_audit.jsonl
// (round id, full bet ledger with per-bet IDs, winners with balance
// before/after, rejected bets, processing time). This is what finally makes
// "who bet what, who got paid, was it correct" answerable after the fact
// instead of only living in a console.log that scrolls away. Also backs the
// new /api/fruitwheel/history/:userId endpoint below.
const fruitWheelAudit = require("./fruitWheelAudit.js");
let fwBetSeq = 0;
function fwNextBetId() {
    fwBetSeq += 1;
    return `FW-${Date.now()}-${fwBetSeq}`;
}

// STABILIZATION FIX (Bug #2, same audit): fruitWheelRooms was a plain
// in-memory object with no persistence at all — a server restart/redeploy
// during an active betting window silently dropped every bet placed in
// that round (coins already deducted, no win possible, no refund). This
// file is a debounced, best-effort snapshot of in-flight bets per room,
// written every time the bet set changes. On boot, anything found here
// represents a round that was interrupted by a restart; since safely
// resuming that exact round isn't supported by the current architecture
// (no client-side round replay, no way to reconstruct "how much time was
// left"), every recorded bet is refunded rather than lost, per the audit's
// recommended fix — this is a cancel-and-refund, never a coin-mint.
const FRUIT_WHEEL_ROUNDS_FILE = path.join(DATA_FOLDER, "fruit_wheel_rounds.json");
function fwPersistRounds() {
    const snapshot = {};
    for (const roomId of Object.keys(fruitWheelRooms)) {
        const g = fruitWheelRooms[roomId];
        if (g && g.bets && Object.keys(g.bets).length) snapshot[roomId] = { bets: g.bets, savedAt: Date.now() };
    }
    safeWrite(FRUIT_WHEEL_ROUNDS_FILE, snapshot);
}
// STABILIZATION FIX (Fruit Wheel Jackpot Ranking, 2026-08-02): the bundled
// client's "Jackpot Ranking" modal previously rendered a hardcoded array of
// fake names with Math.random() amounts — no real data existed anywhere on
// the server to back it. This is that real data: a persisted, cumulative
// "how much has this real user won at Fruit Wheel" total, updated only at
// the exact moment fwResolveSpin() below pays out a real win (never by
// anything client-reported), so it can never contain a fake/demo entry and
// survives server restarts.
const FRUIT_WHEEL_LEADERBOARD_FILE = path.join(DATA_FOLDER, "fruit_wheel_leaderboard.json");
let fruitWheelLeaderboard = safeRead(FRUIT_WHEEL_LEADERBOARD_FILE, {}); // userId -> { userId, name, totalWin }
function fwPersistLeaderboard() {
    safeWrite(FRUIT_WHEEL_LEADERBOARD_FILE, fruitWheelLeaderboard);
}
function fwLeaderboardPayload() {
    const top = Object.values(fruitWheelLeaderboard)
        .sort((a, b) => b.totalWin - a.totalWin)
        .slice(0, 20);
    // Real "pool" figure = total real coins ever paid out by Fruit Wheel
    // across all players, not an invented countdown number.
    const poolTotal = Object.values(fruitWheelLeaderboard).reduce((sum, e) => sum + (Number(e.totalWin) || 0), 0);
    return { leaderboard: top, poolTotal };
}
function fwBroadcastLeaderboard() {
    io.emit("fruitwheel-leaderboard", fwLeaderboardPayload());
}

function fwRecoverRoundsOnBoot() {
    const snapshot = safeRead(FRUIT_WHEEL_ROUNDS_FILE, {});
    const roomIds = Object.keys(snapshot || {});
    if (!roomIds.length) return;
    let refundedUsers = 0;
    roomIds.forEach((roomId) => {
        const bets = snapshot[roomId] && snapshot[roomId].bets;
        if (!bets) return;
        Object.keys(bets).forEach((userId) => {
            const perFood = bets[userId] || {};
            const total = Object.values(perFood).reduce((a, b) => a + (Number(b) || 0), 0);
            if (total <= 0) return;
            const found = findUserByUserId(userId);
            if (!found) return;
            found.user.coins = clampCoinBalance(userId, found.user.coins + total, "fruit-wheel-restart-refund");
            // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
            logTransaction(userId, "coins", total, "Fruit Wheel refund (interrupted by server restart)");
            pushWalletUpdate(userId);
            refundedUsers++;
        });
    });
    if (refundedUsers) {
        saveUsers();
        console.log(`🎡 Fruit Wheel: refunded ${refundedUsers} in-flight bet(s) from ${roomIds.length} room(s) interrupted by the last server restart.`);
    }
    safeWrite(FRUIT_WHEEL_ROUNDS_FILE, {}, { immediate: true });
}

// game-wheel-sync anti-abuse state (see socket handler below) — userId -> { lastSync, windowStart, windowGain }
const gameWheelSyncState = {};
const GAME_WHEEL_SYNC_COOLDOWN_MS = 3000; // min gap between accepted syncs per user
const GAME_WHEEL_SYNC_WINDOW_MS = 60000; // rolling window for the cumulative cap below
// STABILIZATION FIX (Bug #4, Teen Patti/Food Wheel audit, 2026-08-02):
// this handler is the ONLY thing standing between a forged Teen Patti
// client and the real wallet, since Teen Patti still has no server-side
// round engine (see Bug #3 in the audit — closing this properly requires
// that engine, which is a larger, separate rebuild of the Teen Patti
// client bundle and is out of scope for this pass). Until then, this is
// tightened to the audit's recommended interim mitigation: the caps below
// were sized for a completely different, larger chip range than what the
// current Teen Patti bundle actually offers. The bundle's real chip set
// tops out at 1,00,000 with a 2.9x payout, so the largest possible
// legitimate single-hand win is 1,00,000 x 2.9 = 2,90,000 coins — the old
// 5,000,000/8,000,000 caps were ~17x/~28x larger than that, giving a
// forged client far more headroom than any real win ever needs.
const GAME_WHEEL_SYNC_WINDOW_CAP = 900000; // ~3x the largest realistic single-hand win per rolling window
// AUDIT FIX (Phase 9, 2026-07-28): coins is a plain JS number with no
// upper bound anywhere in the codebase. Number arithmetic in V8 stays
// exact up to Number.MAX_SAFE_INTEGER (2^53-1); past that, += silently
// loses precision and coins can appear to "reset" or jump to an
// unrelated value on the next read/write — this is a plausible literal
// mechanism behind "million+ coin bug / balance reset" reports,
// compounding over many small wins/syncs on a long-lived account. A
// hard ceiling, enforced everywhere a balance increases (not just this
// handler), keeps every value comfortably inside the safe-integer range
// and gives legitimate players no realistic way to hit it during normal
// play.
const COIN_BALANCE_CEILING = 100000000000; // 100 billion — far above any realistic legitimate balance
function clampCoinBalance(userId, coins, context) {
    if (!Number.isFinite(coins) || coins < 0) coins = 0;
    coins = Math.floor(coins);
    if (coins > COIN_BALANCE_CEILING) {
        console.warn(`⚠️ Coin ceiling hit for user ${userId} in ${context}: ${coins} clamped to ${COIN_BALANCE_CEILING}`);
        coins = COIN_BALANCE_CEILING;
    }
    return coins;
}

// AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): diamonds had no
// equivalent ceiling/overflow guard at all — every diamond-crediting path
// (diamond seller sales, treasure chest diamond rewards) wrote the raw
// arithmetic result straight to the balance. Diamonds are typically
// smaller numbers than coins in normal play, but a single seller-recorded
// sale is admin/manually entered, so the same NaN/Infinity/overflow class
// of mistake is possible there too. Same shape as clampCoinBalance, kept
// as a separate ceiling since diamonds and coins are tracked/exchanged
// independently, not the same pool.
const DIAMOND_BALANCE_CEILING = 10000000000; // 10 billion — far above any realistic legitimate balance
function clampDiamondBalance(userId, diamonds, context) {
    if (!Number.isFinite(diamonds) || diamonds < 0) diamonds = 0;
    diamonds = Math.floor(diamonds);
    if (diamonds > DIAMOND_BALANCE_CEILING) {
        console.warn(`⚠️ Diamond ceiling hit for user ${userId} in ${context}: ${diamonds} clamped to ${DIAMOND_BALANCE_CEILING}`);
        diamonds = DIAMOND_BALANCE_CEILING;
    }
    return diamonds;
}

function fwBroadcastRoundState(roomId) {
    const g = fruitWheelRooms[roomId];
    if (!g) return;
    io.to(roomId).emit("fruitwheel-round", {
        roundId: g.roundId || 0,
        phase: g.phase,
        resultFoodId: g.phase === "betting" ? null : g.resultFoodId,
        endsInMs: Math.max(0, g.phaseEndsAt - Date.now())
    });
}
function fwStartRound(roomId) {
    const g = fruitWheelRooms[roomId];
    if (!g) return;
    g.phase = "betting";
    g.bets = {}; // userId -> { [foodId]: amount } — authoritative payout source, unchanged
    g.betLog = []; // ordered list of individual bets this round, each with a unique betId (audit/history only, never used for payout math)
    g.rejectedBets = []; // bets the server refused this round, with a reason (audit trail for req #9/#11)
    g.resultFoodId = null;
    g.phaseEndsAt = Date.now() + FW_BETTING_MS;
    g.roundId = (g.roundId || 0) + 1; // Authoritative monotonic round identity shared with every client.
    fwBroadcastRoundState(roomId);
    fwPersistRounds();
    console.log(`🎡 [Fruit Wheel] round #${g.roundId} started in room ${roomId}`);
}
function fwResolveBetting(roomId) {
    const g = fruitWheelRooms[roomId];
    if (!g) return;
    // The ONLY place a Fruit Wheel result is ever generated — server-side,
    // uniform random across the 8 foods, identical for every player in
    // the room since it's broadcast, never computed locally per-client.
    g.resultFoodId = FRUIT_WHEEL_FOODS[Math.floor(Math.random() * FRUIT_WHEEL_FOODS.length)].id;
    g.phase = "spinning";
    g.phaseEndsAt = Date.now() + FW_SPINNING_MS;
    fwBroadcastRoundState(roomId);
}
function fwResolveSpin(roomId) {
    const g = fruitWheelRooms[roomId];
    if (!g) return;
    const resolveStartedAt = Date.now(); // req #9/#12: processing time is part of the audit record
    const winningFood = FRUIT_WHEEL_FOODS.find((f) => f.id === g.resultFoodId);
    const mult = winningFood ? winningFood.mult : 1;
    const winners = [];
    // DEBUG (runtime payout audit, 2026-08-02): full bet ledger for this round,
    // logged BEFORE payout runs, so a disputed payout can be traced back to
    // exactly which userIds had money in this specific room+round and what
    // they bet on — independent of whatever the client UI displayed.
    const betLedger = Object.keys(g.bets).map((uid) => ({ userId: uid, bets: g.bets[uid] }));
    console.log(`🎡 [Fruit Wheel] PAYOUT-AUDIT room=${roomId} round=#${g.roundId} winningFood=${g.resultFoodId} bettors=${betLedger.length} ledger=${JSON.stringify(betLedger)}`);
    let leaderboardChanged = false;
    let totalBet = 0;
    let totalPayout = 0;
    // req #5: persisted, per-user, per-round record — separate from g.bets
    // (which stays the untouched payout source of truth) so this can be
    // written to the audit log even for a user who lost (amount 0).
    const auditBets = Object.keys(g.bets).map((uid) => {
        const perFood = g.bets[uid] || {};
        const betTotal = Object.values(perFood).reduce((a, b) => a + (Number(b) || 0), 0);
        const found = findUserByUserId(uid);
        totalBet += betTotal;
        return { userId: uid, name: found ? found.user.name : null, perFood, betTotal };
    });
    Object.keys(g.bets).forEach((userId) => {
        const perFood = g.bets[userId] || {};
        const betTotal = Object.values(perFood).reduce((a, b) => a + (Number(b) || 0), 0);
        const betOnWin = perFood[g.resultFoodId] || 0;
        const amount = betOnWin * mult;
        const found = findUserByUserId(userId);
        if (amount > 0 && found) {
            const balanceBefore = found.user.coins;
            found.user.coins = clampCoinBalance(userId, found.user.coins + amount, "fruit-wheel-payout");
            const balanceAfter = found.user.coins;
            // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
            logTransaction(userId, "coins", amount, "Fruit Wheel win");
            recordGameWin(found.user.name, amount, "Fruit Wheel");
            pushWalletUpdate(userId);
            totalPayout += amount;
            winners.push({
                userId, name: found.user.name, amount, photo: found.user.photo || null,
                foodId: g.resultFoodId, multiplier: mult, balanceBefore, balanceAfter
            });

            // Real, persistent Jackpot Ranking entry — only ever incremented
            // here, at the moment of an actual server-resolved payout, so it
            // can never hold a demo/fake amount and never resets on its own.
            const entry = fruitWheelLeaderboard[userId] || { userId, name: found.user.name, totalWin: 0 };
            entry.name = found.user.name;
            entry.totalWin = (Number(entry.totalWin) || 0) + amount;
            fruitWheelLeaderboard[userId] = entry;
            leaderboardChanged = true;
        }
        // Targeted real result for the bettor themselves (win or lose) — the
        // only source the client is allowed to show for "did I win / how
        // much"; replaces the old client-side Math.random() win popup.
        // GAP #1 — cross-instance-safe via emitToUser()
        emitToUser(userId, "fruitwheel-result", {
            roundId: g.roundId || 0,
            foodId: g.resultFoodId,
            hasBet: betTotal > 0,
            betTotal,
            win: amount,
            multiplier: mult
        });
    });
    if (winners.length) saveUsers();
    if (leaderboardChanged) { fwPersistLeaderboard(); fwBroadcastLeaderboard(); }
    winners.sort((a, b) => b.amount - a.amount);
    // DEBUG (runtime payout audit): explicit record of who actually got paid,
    // for the exact same room+round logged above — lets a support
    // investigation diff "who bet" vs "who got paid" line by line.
    console.log(`🎡 [Fruit Wheel] PAYOUT-AUDIT room=${roomId} round=#${g.roundId} winners=${JSON.stringify(winners)}`);
    io.to(roomId).emit("fruitwheel-winners", { roundId: g.roundId || 0, resultFoodId: g.resultFoodId, multiplier: mult, winners: winners.slice(0, 3) });
    g.phase = "result";
    g.phaseEndsAt = Date.now() + FW_RESULT_MS;

    // req #9: one permanent, structured record of this exact round — the
    // durable answer to "who bet, what happened, who got paid, how long did
    // it take" that a console.log line can never provide after the fact.
    fruitWheelAudit.logRound({
        roundId: g.roundId,
        roomId,
        winningFoodId: g.resultFoodId,
        multiplier: mult,
        totalBet,
        totalPayout,
        bettorCount: auditBets.length,
        bets: auditBets,
        betLog: g.betLog || [],
        winners: winners.map((w) => ({ userId: w.userId, name: w.name, amount: w.amount, balanceBefore: w.balanceBefore, balanceAfter: w.balanceAfter })),
        rejectedBets: g.rejectedBets || [],
        processingTimeMs: Date.now() - resolveStartedAt
    });

    // Round is fully resolved and every bettor has been paid or lost fairly —
    // clear this room's bets from the persisted snapshot so a restart during
    // the (bet-free) result/next-betting window has nothing stale to refund.
    g.bets = {};
    g.betLog = [];
    g.rejectedBets = [];
    fwPersistRounds();
    fwBroadcastRoundState(roomId);
    console.log(`🎡 [Fruit Wheel] round #${g.roundId} resolved in room ${roomId}: winner=${g.resultFoodId}, payouts=${winners.length}`);
}
function fwTick(roomId) {
    const g = fruitWheelRooms[roomId];
    if (!g) return;
    if (Date.now() < g.phaseEndsAt) return;
    if (g.phase === "betting") fwResolveBetting(roomId);
    else if (g.phase === "spinning") fwResolveSpin(roomId);
    else fwStartRound(roomId);
}
function fwEnsureRoom(roomId) {
    if (fruitWheelRooms[roomId]) return fruitWheelRooms[roomId];
    const g = { phase: "betting", bets: {}, betLog: [], rejectedBets: [], resultFoodId: null, phaseEndsAt: 0, viewers: new Set(), timer: null, emptyTimer: null, roundId: 0 };
    fruitWheelRooms[roomId] = g;
    g.timer = setInterval(() => fwTick(roomId), 500);
    fwStartRound(roomId);
    return g;
}
function fwStopRoomIfEmpty(roomId) {
    const g = fruitWheelRooms[roomId];
    if (!g || g.viewers.size > 0) return;
    if (g.emptyTimer) clearTimeout(g.emptyTimer);
    g.emptyTimer = setTimeout(() => {
        const g2 = fruitWheelRooms[roomId];
        if (!g2 || g2.viewers.size > 0) return;
        // Explicit interval teardown so an emptied room can never leave an
        // orphaned setInterval running (and holding a closure over stale
        // room state) after the room object itself is discarded below.
        clearInterval(g2.timer);
        delete fruitWheelRooms[roomId];
        fwPersistRounds();
        console.log(`🎡 [Fruit Wheel] room ${roomId} engine torn down (empty 30s+)`);
    }, 30000);
}
// STABILIZATION FIX (Phase 3, server-stability audit, 2026-08-02): the
// 30s empty-room teardown above only fires when the LAST viewer leaves
// the Fruit Wheel game itself. It was never called from the two places
// that delete the *room* out from under an active game — the "close-room"
// socket handler and the admin room-delete API — so closing/deleting a
// room while its Fruit Wheel engine was running left g.timer's
// setInterval(fwTick, 500ms) ticking forever: an orphaned interval that
// survives the room's deletion, wastes CPU indefinitely, and can collide
// with stale state if a future room ever reuses the same roomId. This is
// the same teardown fwStopRoomIfEmpty performs, just immediate (no 30s
// wait) since the room is gone right now, not merely empty.
function fwTeardownRoom(roomId) {
    const g = fruitWheelRooms[roomId];
    if (!g) return;
    if (g.timer) clearInterval(g.timer);
    if (g.emptyTimer) clearTimeout(g.emptyTimer);
    delete fruitWheelRooms[roomId];
    console.log(`🎡 [Fruit Wheel] room ${roomId} engine force-torn-down (room closed/deleted)`);
}

// Emoji Reaction feature (additive) — valid reaction IDs, matching the
// .lottie files shipped in public/emoji/.
const EMOJI_REACTION_IDS = new Set(["angry", "crying", "pizza", "pleading", "shock", "yawn"]);

io.on("connection", (socket) => {
    socket.userId = null;
    socket.currentRoom = null;
    socket.emit("room-list", roomListPublic());
    socket.emit("video-gift-catalog", publicVideoGiftCatalog());
    socket.emit("gift-catalog", publicGiftCatalog());
    callSignaling.registerSocketHandlers(socket);
    callHosting.registerSocketHandlers(socket);

    // Registers presence for a user who's connected but not (yet) in a room —
    // e.g. browsing the Home screen. Lets the "Following" tab show a green
    // online dot instead of just Live/Offline. Safe to call repeatedly.
    //
    // SECURITY HARDENING (Module 5.1, 2026-08-08): this previously trusted
    // whatever `userId` the client claimed with zero verification — any
    // socket could "identify" as any user (their presence, room-join
    // identity, gift-sender identity, everything downstream keys off
    // socket.userId). Same class of issue userAuth.requireUserAuth already
    // closed for HTTP; sockets had no equivalent.
    //
    // Rollout is intentionally incremental, same philosophy as
    // requireUserAuth's staged HTTP rollout (see security/userAuth.js):
    //   - authToken present + valid + matches the claimed userId -> verified,
    //     socket.authedUserId is set. Future socket handlers can require
    //     this field where impersonation risk is highest.
    //   - authToken present but invalid/mismatched -> REJECTED outright.
    //     A client that bothers to send a token but sends a bad one is far
    //     more likely an attacker than a legacy client, so this direction
    //     fails closed.
    //   - authToken absent entirely -> accepted as before (fail OPEN), but
    //     logged, so a client not yet updated to send the token isn't
    //     locked out. public/app.js (this change) now always sends it;
    //     any other, not-yet-updated client (e.g. a separately-shipped
    //     mobile app) keeps working exactly as before until it's updated.
    socket.on("identify", ({ userId, authToken } = {}) => {
        if (!userId) return;

        function finishIdentify() {
            socket.userId = socket.userId || userId;
            // GAP #1 (Redis Authoritative Runtime State): every socket now
            // also joins a small per-user room. This is the primitive that
            // lets io.to(`user:${userId}`).emit(...) reach this socket
            // regardless of which cluster instance it's connected to (the
            // Socket.IO Redis Adapter, already wired in above, makes room
            // membership and emits cross-instance) — unlike
            // socketsByUserId[userId], which only ever knows about a
            // socket connected to THIS instance. Joining a Socket.IO room
            // is a cheap, idempotent, purely additive no-op for every
            // existing single-instance deployment.
            socket.join(`user:${userId}`);
            if (pendingPresenceDisconnects[userId]) {
                console.log(`↩️  User ${userId} reconnected (no room) before presence grace period expired — cancelling`);
                clearTimeout(pendingPresenceDisconnects[userId].timer);
                delete pendingPresenceDisconnects[userId];
            }
            const wasOffline = !socketsByUserId[userId];
            bindSocketToUser(socket, userId); // ROOT-CAUSE FIX (2026-08-14) — was a bare assignment; now also tracks connection generation
            addCallSocket(userId, socket.id);
            callSignaling.resumeCall(userId, socket.id);
            callHosting.resumeCall(userId, socket.id);
            if (wasOffline) {
                broadcastFollowStatus(userId, "online", null);
                (findUserByUserId(userId)?.user.groups || []).forEach((gid) => broadcastGroupUpdate(gid));
            }
        }

        function rejectIdentify() {
            console.warn(`🚨 [socket-auth] identify REJECTED — userId ${userId} claimed with an invalid/mismatched authToken`);
            socket.emit("identify-rejected", { message: "Session verification failed — please log in again", forceLogout: true });
        }

        if (authToken) {
            // GAP #1: local validateToken() stays the synchronous fast path
            // (unchanged) for a token this instance issued or has already
            // seen. Only a genuine LOCAL MISS falls back to
            // validateTokenCrossInstance() (redis/sessionStore.js), which
            // lets a user whose login landed on a different cluster
            // instance still pass this check here instead of being wrongly
            // rejected/force-logged-out.
            const localMobile = userAuth.validateToken(authToken);
            if (localMobile) {
                const owner = findUserByUserId(userId);
                if (owner && owner.mobile === localMobile) {
                    socket.authedUserId = userId;
                    finishIdentify();
                } else {
                    rejectIdentify();
                }
                return;
            }
            userAuth.validateTokenCrossInstance(authToken).then((mobile) => {
                const owner = mobile ? findUserByUserId(userId) : null;
                const belongsToClaimedUser = mobile && owner && owner.mobile === mobile;
                if (!belongsToClaimedUser) { rejectIdentify(); return; }
                socket.authedUserId = userId;
                finishIdentify();
            }).catch(() => rejectIdentify());
        } else {
            console.warn(`⚠️ [socket-auth] identify without authToken for userId ${userId} — accepted unverified (legacy client)`);
            finishIdentify();
        }
    });

    // ---------- Presence: away/busy (Phase 2B-2, see redis/presence.js) ----------
    // Purely additive, optional socket event — nothing in the app emits
    // this today, so it changes zero existing behavior. When a client
    // does opt in, it lets a user's cluster-wide presence show "away" or
    // "busy" instead of the auto-derived online/in_room/in_voice_call
    // status. Sending {status:"online"} (or anything else not in the
    // away/busy set) simply clears any manual override, falling back to
    // the auto-derived status — no separate "clear" event needed.
    // Lazy-required and wrapped so a problem here can never affect the
    // identify/join-room handlers around it.
    socket.on("presence:set-status", ({ status } = {}) => {
        if (!socket.userId) return; // no identified user yet (identify/join-room hasn't fired) — nothing to key the override on
        try {
            const presence = require("./redis/presence.js");
            if (status === "away" || status === "busy") {
                presence.setOverride(socket.userId, status).catch(() => {});
            } else {
                presence.clearOverride(socket.userId).catch(() => {});
            }
        } catch (e) {
            // redis/presence.js failing to load never breaks this socket.
        }
    });

    // Official Room 101 AI Customer Service voice/text bridge.
    // The browser's existing voice stack remains authoritative for audio
    // transport; this handler turns finalized speech transcripts into AI
    // responses and sends them back to the caller.
    socket.on("cs101:start", () => {
        socket.emit("cs101:ready", cs101PublicState());
    });

    socket.on("cs101:greet", () => {
        if (!cs101Config.enabled || !socket.userId || !socket.currentRoom || !cs101IsRoom(socket.currentRoom)) return;
        const found = findUserByUserId(socket.userId);
        const name = found && found.user ? String(found.user.name || "").trim() : "";
        const official = Array.isArray(cs101Config.officialUserIds) && cs101Config.officialUserIds.includes(socket.userId);
        let text = cs101PersonalizedGreeting(socket.userId);
        if (official) {
            text = `নমস্কার ${name || "স্যার/ম্যাডাম"}, আপনাকে বিশেষ সম্মানের সঙ্গে স্বাগত জানাচ্ছি। আমি রবিন, PingPong Customer Service-এর AI Room Administrator। আমি কীভাবে আপনাকে সাহায্য করতে পারি?`;
        }
        socket.emit("cs101:reply", {
            roomId: CS101_ROOM_ID, agentId: CS101_AGENT_ID, agentName: cs101Config.agentName,
            text,
            voice: { enabled: !!cs101Config.voiceEnabled, persona: "fixed-female", rate: cs101Config.voiceRate, pitch: cs101Config.voicePitch, language: found?.user?.language || "bn" }
        });
    });

    // Client-side voice-call failure report (public/vapi-support.js
    // notifyFailure()). No credentials are ever included by the client here
    // — only a classified, human-readable reason string and a truncated raw
    // message. Stored for the Admin Panel's "Robin health" view.
    socket.on("cs101:voice-error", (payload = {}) => {
        if (!socket.userId || !socket.currentRoom || !cs101IsRoom(socket.currentRoom)) return;
        cs101RecordVoiceError({
            ts: Date.now(),
            userId: socket.userId,
            seat: (rooms[CS101_ROOM_ID]?.seats || []).findIndex(s => s && s.userId === socket.userId) + 1 || null,
            reason: String(payload.reason || "Unknown error").slice(0, 300),
            raw: String(payload.raw || "").slice(0, 300)
        });
    });

    socket.on("cs101:admin-command", (payload = {}, ack) => {
        const reply = (value) => { try { if (typeof ack === "function") ack(value); } catch (_) {} };
        if (!socket.userId || !cs101IsRoom(socket.currentRoom)) return reply({ ok: false, message: "You are not in Room 101." });
        try {
            const result = cs101RunAdminCommand(rooms[CS101_ROOM_ID], socket.userId, payload);
            reply(result);
        } catch (err) {
            console.error("[CS101] admin command failed:", err);
            reply({ ok: false, message: "I could not complete that room action." });
        }
    });

    socket.on("cs101:message", async ({ roomId, text, history } = {}) => {
        if (!cs101Config.enabled || !cs101IsRoom(roomId) || !socket.userId || !String(text || "").trim()) return;
        try {
            const room = rooms[CS101_ROOM_ID];
            const command = cs101RunRoomCommand(room, String(text).trim());
            if (command && command.ok) {
                const n = command.seatNumber;
                socket.emit("cs101:reply", {
                    roomId: CS101_ROOM_ID, agentId: CS101_AGENT_ID, agentName: cs101Config.agentName,
                    text: `অবশ্যই। আমি Room 101-এর ${n} নম্বর customer seat খুলে দিয়েছি। আপনি চাইলে এখন সেখানে বসতে পারবেন।`,
                    voice: { enabled: !!cs101Config.voiceEnabled, persona: "fixed-female", rate: cs101Config.voiceRate, pitch: cs101Config.voicePitch }
                });
                return;
            }
            if (command && !command.ok) {
                socket.emit("cs101:reply", {
                    roomId: CS101_ROOM_ID, agentId: CS101_AGENT_ID, agentName: cs101Config.agentName,
                    text: command.message,
                    voice: { enabled: !!cs101Config.voiceEnabled, persona: "fixed-female", rate: cs101Config.voiceRate, pitch: cs101Config.voicePitch }
                });
                return;
            }
            const reply = await cs101GenerateReply(String(text).trim(), history);
            socket.emit("cs101:reply", {
                roomId: CS101_ROOM_ID,
                agentId: CS101_AGENT_ID,
                agentName: cs101Config.agentName,
                text: String(reply || "").slice(0, 1800),
                voice: { enabled: !!cs101Config.voiceEnabled, persona: "fixed-female", rate: cs101Config.voiceRate, pitch: cs101Config.voicePitch }
            });
        } catch (err) {
            console.error("Room 101 AI reply failed:", err.message);
            socket.emit("cs101:error", {
                roomId: CS101_ROOM_ID,
                message: "AI Customer Service is temporarily unavailable. Please try again or contact a human agent."
            });
        }
    });

    socket.on("join-room", ({ roomId, userId, userName, userPhoto, password }) => {
        // AUTH-1 FIX (Phase 1 identity audit, 2026-08-10): a socket that has
        // already verified its identity via "identify" (socket.authedUserId
        // set) can no longer join a room claiming a DIFFERENT userId. Before
        // this fix, join-room set socket.userId straight from this
        // client-supplied payload with no check at all — see
        // FIREBASE_IDENTITY_AUDIT.md item AUTH-1 and
        // security/socketIdentity.js for the full rationale. A socket that
        // never verified (no authedUserId yet) is still accepted unverified,
        // unchanged from prior behavior, to avoid locking out legacy clients.
        if (!socketIdentity.isJoinIdentityAllowed(socket.authedUserId, userId)) {
            console.warn(`🚨 [socket-auth] join-room REJECTED — socket verified as ${socket.authedUserId} tried to claim userId ${userId}`);
            socket.emit("identify-rejected", { message: "Session verification failed — please log in again", forceLogout: true });
            return;
        }

        // ROOT-CAUSE FIX #1 (2026-08-14, reconnect/duplicate join-room audit)
        // — SERVER-SIDE JOIN IDEMPOTENCY: the production log showed the same
        // socket.id emitting "join-room" for a room it was ALREADY joined
        // to (double-tap on the room card, a duplicate emit racing a
        // reconnect, etc). Previously this re-ran the entire join mutation
        // (performRoomJoin) a second time — re-pushing the user into
        // room.onlineUsers (harmless there, since it's keyed by userId), but
        // also re-broadcasting "room-state"/"user-count" to the whole room,
        // re-emitting "room-list" to everyone, re-recording a "recent room
        // visit", and re-broadcasting follow-status/vehicle-entry — all
        // side effects that should only ever happen once per real join. Do
        // nothing but resend this socket's own authoritative snapshot.
        if (socket.currentRoom === roomId && socket.userId === userId && socketsByUserId[userId] === socket.id) {
            const alreadyRoom = rooms[roomId];
            if (alreadyRoom) {
                console.log(`↩️  join-room: ignoring duplicate join for already-joined user ${userId} in room ${roomId} (socket ${socket.id})`);
                socket.emit("room-state", publicRoom(alreadyRoom));
                return;
            }
            // Room vanished (closed) between joins — fall through and let
            // the normal "room not found" handling below run.
        }

        // ROOT-CAUSE FIX #2 (2026-08-14) — PREVENT STALE ROOM JOINS / SERIALIZE
        // ROOM SWITCHING: if this socket is currently a member of a DIFFERENT
        // room (the user tapped room B while still joined to room A, without
        // an explicit "leave-room" ever reaching the server — this is exactly
        // what the client did before its own 2026-08-14 fix), the old room's
        // membership/seat/onlineUsers entry was never cleaned up. That stale
        // membership could later broadcast/verify against this socket and
        // even (via the old room's own disconnect-grace path) remove state
        // that actually belongs to the NEW room. Clean up the old room first,
        // synchronously, before this socket is allowed to join the new one —
        // "leave old room -> confirm/complete cleanup -> join new room",
        // exactly as required. isDisconnecting=false: this is a voluntary
        // switch, not a disconnect, so presence (socketsByUserId) is left
        // untouched — only handleUserLeaveRoom's socket.leave(oldRoomId)/room
        // bookkeeping actually needs to run.
        if (socket.currentRoom && socket.currentRoom !== roomId) {
            console.log(`🔄 join-room: user ${userId} switching rooms ${socket.currentRoom} -> ${roomId} on socket ${socket.id} — cleaning up old room first`);
            handleUserLeaveRoom(socket.currentRoom, userId, socket, false);
        }

        // ROOT-CAUSE FIX #3 (2026-08-14) — join sequencing token. The
        // cross-instance (RPC) path below is asynchronous; if this socket
        // fires ANOTHER "join-room" (e.g. tapping a third room) before the
        // RPC for this one resolves, only the LATEST request should ever be
        // allowed to actually finish the join — an in-flight response for a
        // room the socket no longer wants must be discarded rather than
        // silently overwriting whatever newer join won the race. The local
        // (non-RPC) path is fully synchronous so this is a no-op guard
        // there, but it's captured unconditionally for the async path below.
        socket._joinSeq = (socket._joinSeq || 0) + 1;
        const mySeq = socket._joinSeq;

        const room = rooms[roomId];
        // Fix (banned users could still act in rooms): banned status was only
        // checked at OTP login, not when actually joining a room over a socket
        // (e.g. a session opened before the ban, or an old cached session).
        // Checked before the local-vs-cross-instance branch below since this
        // is a user-account check, not a room-state one — identical either way.
        const foundForBan = findUserByUserId(userId);
        if (foundForBan && foundForBan.user.banned) {
            socket.emit("kicked", { message: "Your account has been banned", forceLogout: true });
            return;
        }

        // Shared post-join bookkeeping — identical for a room this instance
        // already had locally and one joined cross-instance via RPC below
        // (roomSnapshot is publicRoom(room) either way: the real local
        // object on the local path, the owning instance's returned
        // snapshot on the cross-instance path).
        function finishJoin(roomSnapshot) {
            if (pendingDisconnects[userId]) {
                const resumedRoomId = pendingDisconnects[userId].roomId;
                console.log(`↩️  User ${userId} reconnected before grace period expired — cancelling scheduled leave`);
                clearTimeout(pendingDisconnects[userId].timer);
                voiceSfu.sync.onParticipantGraceResumed(resumedRoomId, userId); // PHASE 3, STEP 3.4 — no-op unless VOICE_MODE=sfu
                // IMPORTANT: the user's Socket.IO id changed during the reconnect.
                // Tell every room peer to stop treating the old signaling socket as
                // authoritative and immediately renegotiate against the new socket.
                // This is what prevents "connected but silent" after a mobile refresh
                // or transient network drop, including audience listeners.
                voiceReconnect.notifyPeerResumed(resumedRoomId, userId);
                delete pendingDisconnects[userId];
            }
            if (pendingPresenceDisconnects[userId]) {
                clearTimeout(pendingPresenceDisconnects[userId].timer);
                delete pendingPresenceDisconnects[userId];
            }
            socket.userId = userId;
            socket.currentRoom = roomId;
            bindSocketToUser(socket, userId); // ROOT-CAUSE FIX (2026-08-14) — was a bare `socketsByUserId[userId] = socket.id`; now also tracks connection generation for the grace-period/seat race guards below
            socket.join(`user:${userId}`); // GAP #1 — see identify handler's finishIdentify() for why (cross-instance targeted emit primitive); idempotent if already joined via identify
            addCallSocket(userId, socket.id);
            callSignaling.resumeCall(userId, socket.id);
            callHosting.resumeCall(userId, socket.id);
            socket.join(roomId); // safe even for a cross-instance-owned room: Socket.IO's Redis adapter makes room membership/emits cluster-wide, so this socket now correctly receives io.to(roomId).emit(...) from the owning instance too
            // BUG-001 FIX (2026-08-10, forensic audit): performRoomJoin() (local
            // path) and the owning instance's own performRoomJoin() (cross-instance
            // path) both broadcast "room-state" via io.to(roomId).emit(...) BEFORE
            // this socket reaches the socket.join(roomId) line above — Socket.IO
            // room-scoped emits only reach sockets that are ALREADY members, so the
            // joining socket never received its own first room-state. Symptom: a
            // freshly-joined user saw an empty room (no seats, no chat, no user IDs,
            // mic/SFU never initialized) until some unrelated later broadcast
            // happened to arrive. Sending the same, already-current roomSnapshot
            // directly to this socket — now that it IS a member — closes that gap
            // without touching performRoomJoin() or any of the other 12 room-state
            // call sites (already-present users' behavior is unchanged; this is
            // purely additive for the joining socket itself). roomSnapshot here is
            // always the fresh publicRoom(room)/RPC result already computed AFTER
            // performRoomJoin()'s mutations, both on the local and cross-instance
            // path, so this is never a stale duplicate.
            socket.emit("room-state", roomSnapshot);
            if (foundForBan) svip.checkExpiry(userId);
            console.log(`🚪 join-room: user ${userId} (${userName || "?"}) joined room ${roomId} (socket ${socket.id})`);

            io.emit("room-list", roomListPublic());
            recordRecentRoomVisit(userId, roomSnapshot);
            broadcastFollowStatus(userId, "live", roomSnapshot);

            // Vehicle Entry System (add-on, see vehicles.js) — if the joining
            // user has an Active Vehicle, broadcast the full-screen entry
            // animation to everyone currently in THIS room only (io.to(roomId),
            // same room-scoping every other room event here already uses).
            // Never blocks or alters the join flow above if it has no vehicle.
            const activeVehicle = getUserActiveVehicle(userId);
            if (activeVehicle) {
                io.to(roomId).emit("vehicle-entry", { userId, userName, userPhoto, vehicle: activeVehicle });
            }

            // AI Room Assistant auto-greeting removed by request — the room no
            // longer pushes a "PingPong AI welcome" message into chat on
            // join. (aiRoomAssistant.welcomeMessage/needsWelcome/markWelcomed
            // are left in ai-room-assistant.js in case "@AI" in-room replies
            // still use that module elsewhere — only this auto-trigger on join
            // is disabled.)
        }

        if (room) {
            // ---------- LOCAL PATH (unchanged behavior) ----------
            const result = performRoomJoin(room, { userId, userName, userPhoto, socketId: socket.id, passwordHash: password ? hashRoomPassword(password) : null });
            if (!result.ok) {
                socket.emit("room-error", {
                    message: result.error === "wrong-password" ? "Wrong Password" : "Room is locked — enter Password",
                    needPassword: true,
                    roomId
                });
                return;
            }
            finishJoin(publicRoom(room));
            return;
        }

        // ---------- CROSS-INSTANCE PATH (GAP #1 remaining item 2) ----------
        // Not found locally. Ask the cluster (via redis/roomJoinRpc.js) in
        // case another instance actually owns this room before giving up.
        // Safe no-op / instant "timeout" if Redis is disabled or nobody
        // answers — falls through to the exact same room-not-found /
        // crossInstance diagnostic this handler already had.
        roomJoinRpc.requestCrossInstanceJoin({
            roomId, userId, userName, userPhoto, socketId: socket.id,
            passwordHash: password ? hashRoomPassword(password) : null
        }).then((result) => {
            // ROOT-CAUSE FIX #3 continued (2026-08-14): this RPC round-trip is
            // the one genuinely asynchronous gap in the join flow — if a
            // newer "join-room" (a different room, or even a retry of this
            // same one) has already bumped socket._joinSeq past mySeq by the
            // time this resolves, this response is stale. Discard it rather
            // than letting it call finishJoin()/emit room-error for a room
            // this socket has already moved on from — only the LATEST
            // requested room is ever allowed to become authoritative.
            if (socket._joinSeq !== mySeq) {
                console.log(`⏭️  join-room: discarding stale cross-instance RPC result for room ${roomId} on socket ${socket.id} — a newer join-room superseded it`);
                return;
            }
            if (result.ok && result.room) {
                console.log(`🌐 [cluster] join-room: user ${userId} joined room ${roomId} via cross-instance RPC`);
                finishJoin(result.room);
                return;
            }
            if (result.needPassword) {
                socket.emit("room-error", {
                    message: result.error === "wrong-password" ? "Wrong Password" : "Room is locked — enter Password",
                    needPassword: true,
                    roomId
                });
                return;
            }
            // GAP #1 (Redis Authoritative Runtime State): distinguish
            // "genuinely doesn't exist" from "exists on a different
            // cluster instance but the RPC above still failed" (Redis
            // disabled, timeout, owning instance crashed mid-flight) —
            // same honest `crossInstance` diagnostic this handler already
            // had, now only reached once the RPC path itself has already
            // been tried and come back empty.
            try {
                const clusterRead = require("./redis/clusterRead.js");
                clusterRead.getRoomAcrossCluster(roomId).then((remote) => {
                    if (socket._joinSeq !== mySeq) return; // stale — see guard above
                    if (remote) {
                        console.warn(`⚠️ [cluster] join-room: room ${roomId} exists on instance ${remote.instanceId} but cross-instance join failed (${result.error}) — likely Redis pub/sub connectivity issue`);
                        socket.emit("room-error", { message: "Room not found", crossInstance: true });
                    } else {
                        socket.emit("room-error", { message: "Room not found" });
                    }
                }).catch(() => { if (socket._joinSeq === mySeq) socket.emit("room-error", { message: "Room not found" }); });
            } catch (e) {
                socket.emit("room-error", { message: "Room not found" });
            }
        }).catch(() => {
            if (socket._joinSeq === mySeq) socket.emit("room-error", { message: "Room not found" });
        });
    });

    socket.on("leave-room", ({ roomId, userId }) => handleUserLeaveRoom(roomId, userId, socket));

    socket.on("take-seat", ({ roomId, seatNumber }) => {
        if (!socket.userId) return;
        if (seatNumber < 1 || seatNumber > 8) return;
        const room = rooms[roomId];
        if (room) {
            // ---------- LOCAL PATH (unchanged behavior) ----------
            const result = performTakeSeat(room, { userId: socket.userId, socketId: socket.id, seatNumber });
            if (!result.ok && result.message) socket.emit("room-error", { message: result.message });
            return;
        }
        // ---------- CROSS-INSTANCE PATH (GAP #2) ----------
        // Not found locally — this socket is in a room owned by a
        // different instance (joined locally before, or joined via
        // roomJoinRpc.js's cross-instance join). Ask the owning instance
        // to run the exact same performTakeSeat() on the real room
        // object; see redis/roomOpRpc.js. Times out to ok:false, same
        // fallback shape as the local rejection paths above.
        roomOpRpc.forwardOp("take-seat", roomId, { userId: socket.userId, socketId: socket.id, seatNumber }).then((res) => {
            if (!res.ok && res.result && res.result.message) socket.emit("room-error", { message: res.result.message });
        }).catch(() => {});
    });

    socket.on("leave-seat", ({ roomId }) => {
        if (!socket.userId) return;
        const room = rooms[roomId];
        if (room) {
            // ---------- LOCAL PATH (unchanged behavior) ----------
            performLeaveSeat(room, { userId: socket.userId });
            return;
        }
        // ---------- CROSS-INSTANCE PATH (GAP #2) ----------
        roomOpRpc.forwardOp("leave-seat", roomId, { userId: socket.userId }).catch(() => {});
    });

    socket.on("send-message", ({ roomId, message }) => {
        if (!message || !message.trim() || !socket.userId) return;
        const room = rooms[roomId];
        if (room) {
            // ---------- LOCAL PATH (unchanged behavior) ----------
            const result = performSendMessage(room, { userId: socket.userId, message });
            if (!result.ok && result.message) socket.emit("room-error", { message: result.message });
            return;
        }
        // ---------- CROSS-INSTANCE PATH (GAP #2) ----------
        // Not found locally. Forward to whichever instance owns the room
        // (redis/roomOpRpc.js) so chat, AI moderation, and the AI room
        // assistant all keep working for a user in a cross-instance room —
        // same real performSendMessage() function the local path uses,
        // reached over pub/sub instead of a direct call.
        roomOpRpc.forwardOp("send-message", roomId, { userId: socket.userId, message }).then((res) => {
            if (!res.ok && res.result && res.result.message) socket.emit("room-error", { message: res.result.message });
        }).catch(() => {});
    });

    // ---- Emoji Reaction feature (additive) ----
    // Broadcasts which emoji + which sender to everyone in the room;
    // clients place the animation above that sender's seat avatar
    // themselves (see emojiReaction.js). No new persisted state — this is
    // a fire-and-forget, in-the-moment reaction, same as voice-activity.
    socket.on("send-emoji-reaction", ({ roomId, emojiId }) => {
        const room = rooms[roomId];
        if (!room || !socket.userId || !EMOJI_REACTION_IDS.has(emojiId)) return;
        if ((room.chatBannedIds || []).includes(socket.userId)) return;
        // Reuses the same rate-limit helper as chat, own namespaced key so
        // it can never affect (or be affected by) the chat flood limit.
        if (aiSecurity.isRateLimited(`emoji-reaction:${socket.userId}`, { windowMs: 3000, max: 5 })) return;
        io.to(roomId).emit("emoji-reaction", { userId: socket.userId, emojiId });
    });

    // Room Ranking popup — fetched on open, then kept live via the
    // "room-ranking-update" broadcasts emitted alongside every gift send.
    socket.on("get-room-ranking", ({ roomId }) => {
        if (!roomId || !rooms[roomId]) return;
        socket.emit("room-ranking-data", buildRoomRankingPayload(roomId));
    });

    // Gift Box / Level Information popup — fetched on open; kept live
    // afterward via the "id-level-up" event idLevel.js already emits to
    // this same user's socket the moment a room gift send actually crosses
    // a level threshold, so the client never needs to re-fetch to stay
    // current while the popup is open.
    socket.on("get-level-info", () => {
        if (!socket.userId) return;
        const info = idLevel.getLevelInfo(socket.userId);
        if (info) socket.emit("level-info-data", info);
    });

    // Accepts either a single targetUserId (legacy) or targetUserIds (array,
    // for multi-recipient sends), plus an optional quantity (repeat-send
    // count, e.g. x1/x7/x77/x777 from the client). Each selected recipient
    // receives the gift `quantity` times. Total cost is checked upfront
    // against the full amount before anything is deducted, so a sender can
    // never go negative partway through a multi-recipient send.
    socket.on("send-gift", ({ roomId, targetUserId, targetUserIds, giftId, quantity, requestId }) => {
        const room = rooms[roomId];
        if (!room || !socket.userId) return;
        // See isDuplicateGiftRequest() above — the same tap replayed (double
        // emit, reconnect-triggered resend) is dropped before any coin is
        // touched, rather than processed as a second real send.
        if (isDuplicateGiftRequest(requestId)) return;
        const senderFound = findUserByUserId(socket.userId);
        if (!senderFound) return;
        const gift = giftCatalog.find((g) => g.id === giftId && g.enabled !== false);
        if (!gift) { socket.emit("room-error", { message: "Gift not found" }); return; }

        const qty = Math.max(1, Math.min(777, parseInt(quantity, 10) || 1));
        const ids = Array.isArray(targetUserIds) && targetUserIds.length ? targetUserIds : (targetUserId ? [targetUserId] : []);
        const uniqueIds = [...new Set(ids)].filter((uid) => uid !== senderFound.user.userId);
        if (!uniqueIds.length) { socket.emit("room-error", { message: "Choose someone" }); return; }

        const targets = uniqueIds.map((uid) => findUserByUserId(uid)).filter(Boolean);
        if (!targets.length) { socket.emit("room-error", { message: "User not found" }); return; }

        const perTargetAmount = gift.price * qty;
        const totalCost = perTargetAmount * targets.length;
        if (senderFound.user.coins < totalCost) { socket.emit("room-error", { message: "Not enough coins" }); return; }

        // AUDIT FIX (2026-07-27, cross-file transaction safety): this handler
        // had no try/catch at all — an uncaught throw partway through the
        // targets loop below (e.g. a bad recordGiftHistory call) left the
        // sender's coins already deducted with some targets paid and others
        // not, no way to recover, and risked taking the whole socket
        // connection (or process, depending on how it propagated) down with
        // it. Snapshot every balance touched BEFORE mutating, wrap the whole
        // sequence, and restore everyone (including any targets already
        // credited) on failure.
        const senderSnapshot = { coins: senderFound.user.coins, level: senderFound.user.level, lifetimeGiftSent: senderFound.user.lifetimeGiftSent, idLevel: senderFound.user.idLevel };
        const targetSnapshots = new Map(targets.map((t) => [t.user.userId, { diamonds: t.user.diamonds, vipLevel: t.user.vipLevel }]));
        try {
            senderFound.user.coins -= totalCost;
            // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
            const hostFoundForHistory = room.hostId ? findUserByUserId(room.hostId) : null;
            const agencyIdForHistory = hostFoundForHistory ? hostFoundForHistory.user.agencyId : null;
            targets.forEach((targetFound) => {
                // Restored on request (2026-08-04): gift recipients earn Diamonds,
                // not Coins — same fix as the REST /api/gifts/send path above.
                targetFound.user.diamonds = clampDiamondBalance(targetFound.user.userId, (targetFound.user.diamonds || 0) + perTargetAmount, "gift-receive-multi");
                targetFound.user.vipLevel = vipLevelFromDiamonds(targetFound.user.diamonds);
                pushWalletUpdate(targetFound.user.userId);
                const label = qty > 1 ? `${gift.name} x${qty}` : gift.name;
                logTransaction(senderFound.user.userId, "coins", -perTargetAmount, `Sent ${label} to ${targetFound.user.name}`);
                logTransaction(targetFound.user.userId, "diamonds", perTargetAmount, `Received ${label} from ${senderFound.user.name}`);
                logGift({ fromUserId: senderFound.user.userId, fromName: senderFound.user.name, toUserId: targetFound.user.userId, toName: targetFound.user.name, gift, quantity: qty, roomId, time: new Date().toISOString() });
                recordGiftHistory({
                    senderId: senderFound.user.userId, receiverId: targetFound.user.userId, roomId, hostId: room.hostId,
                    agencyId: agencyIdForHistory, giftName: label, giftId: gift.id, quantity: qty, diamondAmount: perTargetAmount,
                    transactionId: makeGiftTransactionId(requestId, senderFound.user.userId, targetFound.user.userId, gift.id, qty)
                });
                io.to(roomId).emit("gift-received", { fromUserId: senderFound.user.userId, fromName: senderFound.user.name, toUserId: targetFound.user.userId, toName: targetFound.user.name, gift, quantity: qty });
            });
        } catch (giftErr) {
            console.error(`🚨 Multi-gift send transaction failed mid-way, rolling back sender ${senderFound.user.userId} and ${targetSnapshots.size} target(s):`, giftErr.message);
            Object.assign(senderFound.user, senderSnapshot);
            targets.forEach((t) => { const snap = targetSnapshots.get(t.user.userId); if (snap) Object.assign(t.user, snap); });
            socket.emit("room-error", { message: "Problem sending gift, please try again" });
            return;
        }
        io.to(roomId).emit("room-ranking-update", buildRoomRankingPayload(roomId));

        saveUsers();
        pushWalletUpdate(senderFound.user.userId);
        svip.addWealth(senderFound.user.userId, totalCost, `gift:${gift.id}:${Date.now()}`, "gift_sent");
        idLevel.recordGiftSent(senderFound.user.userId, totalCost);

        const opened = contributeToChest(room, senderFound.user.userId, senderFound.user.name, totalCost);
        io.to(roomId).emit("room-state", publicRoom(room));
        if (opened) {
            opened.forEach((o) => {
                const top = topChestContributors(room.treasureChest, 3);
                const recipients = new Set([room.hostId, ...top.map((c) => c.userId)]);
                recipients.forEach((uid) => applyChestReward(uid, o.reward));
                recipients.forEach((uid) => pushWalletUpdate(uid));
                io.to(roomId).emit("chest-opened", { level: o.level, reward: o.reward, topContributors: top });
            });
        }
    });

    // Video Gift System — spends Coins (changed from Diamonds on request)
    // and, only once the spend succeeds, broadcasts the full-screen video to
    // everyone currently in the room. Broadcasting only on success means a
    // failed/insufficient send never triggers playback for anyone.
    socket.on("send-video-gift", ({ roomId, targetUserId, targetUserIds, videoGiftId, quantity, requestId }) => {
        const room = rooms[roomId];
        if (!room || !socket.userId) return;
        // See isDuplicateGiftRequest() above — same guard as send-gift.
        if (isDuplicateGiftRequest(requestId)) return;
        const senderFound = findUserByUserId(socket.userId);
        if (!senderFound) return;
        const gift = videoGiftCatalog.find((g) => g.id === videoGiftId && g.enabled !== false);
        if (!gift) { socket.emit("room-error", { message: "Gift not found" }); return; }

        const qty = Math.max(1, Math.min(777, parseInt(quantity, 10) || 1));
        const ids = Array.isArray(targetUserIds) && targetUserIds.length ? targetUserIds : (targetUserId ? [targetUserId] : []);
        const uniqueIds = [...new Set(ids)].filter((uid) => uid !== senderFound.user.userId);
        const targets = uniqueIds.map((uid) => findUserByUserId(uid)).filter(Boolean);
        // Video gifts can still be sent "to the room" with no specific
        // recipient (targets empty) — in that case it's a single broadcast
        // send, not per-recipient, so cost is just price * quantity.
        const sendCount = targets.length || 1;
        const totalCost = gift.price * qty * sendCount;
        if ((senderFound.user.coins || 0) < totalCost) { socket.emit("room-error", { message: "Not enough coins" }); return; }

        // AUDIT FIX (2026-07-27, cross-file transaction safety): same pattern
        // as the other two gift-send paths — snapshot before mutating, defer
        // the disk save and the wealth/XP side effects until the whole
        // sequence below has completed without throwing, and roll the
        // sender's coins/level back on failure instead of leaving coins
        // spent with nothing recorded.
        const senderSnapshot = { coins: senderFound.user.coins, level: senderFound.user.level };
        try {
            senderFound.user.coins -= totalCost;
            // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
            const label = qty > 1 ? `${gift.name} x${qty}` : gift.name;
            const targetList = targets.length ? targets : [null];
            const hostFoundForHistory = room.hostId ? findUserByUserId(room.hostId) : null;
            const agencyIdForHistory = hostFoundForHistory ? hostFoundForHistory.user.agencyId : null;
            targetList.forEach((targetFound) => {
                logTransaction(senderFound.user.userId, "coins", -(gift.price * qty), `Sent video gift ${label}${targetFound ? ` to ${targetFound.user.name}` : ""}`);
                logGift({
                    fromUserId: senderFound.user.userId, fromName: senderFound.user.name,
                    toUserId: targetFound ? targetFound.user.userId : null, toName: targetFound ? targetFound.user.name : null,
                    gift: { id: gift.id, name: gift.name, price: gift.price, videoGift: true }, quantity: qty, roomId, time: new Date().toISOString()
                });
                // No specific recipient chosen (room-wide send) — credit the
                // room's host as receiver, same convention used elsewhere for
                // undirected room gifts (e.g. treasure chest contributions).
                recordGiftHistory({
                    senderId: senderFound.user.userId, receiverId: targetFound ? targetFound.user.userId : room.hostId, roomId, hostId: room.hostId,
                    agencyId: agencyIdForHistory, giftName: label, giftId: gift.id, quantity: qty, diamondAmount: gift.price * qty,
                    transactionId: makeGiftTransactionId(requestId, senderFound.user.userId, targetFound ? targetFound.user.userId : room.hostId, gift.id, qty)
                });
                // Everyone currently in the room plays it at the same moment; anyone
                // who joins later simply never receives this past event.
                io.to(roomId).emit("video-gift-play", {
                    fromUserId: senderFound.user.userId, fromName: senderFound.user.name,
                    toUserId: targetFound ? targetFound.user.userId : null, toName: targetFound ? targetFound.user.name : null,
                    gift: { id: gift.id, name: gift.name, price: gift.price, videoUrl: gift.videoUrl, thumbnail: gift.thumbnail, duration: gift.duration }
                });
            });
        } catch (giftErr) {
            console.error(`🚨 Video gift send transaction failed mid-way, rolling back sender ${senderFound.user.userId}:`, giftErr.message);
            Object.assign(senderFound.user, senderSnapshot);
            socket.emit("room-error", { message: "Problem sending gift, please try again" });
            return;
        }
        saveUsers();
        pushWalletUpdate(senderFound.user.userId);
        svip.addWealth(senderFound.user.userId, totalCost, `videogift:${gift.id}:${Date.now()}`, "video_gift_sent");
        idLevel.recordGiftSent(senderFound.user.userId, totalCost);
        io.to(roomId).emit("room-ranking-update", buildRoomRankingPayload(roomId));

        // Bug fix: video/custom gifts spent coins but, unlike the regular
        // send-gift handler, never called contributeToChest — so this spend
        // never "counted" toward the room's treasure chest / wealth level or
        // the top-contributor ranking. Mirror the same logic used elsewhere.
        const opened = contributeToChest(room, senderFound.user.userId, senderFound.user.name, totalCost);
        io.to(roomId).emit("room-state", publicRoom(room));
        if (opened) {
            opened.forEach((o) => {
                const top = topChestContributors(room.treasureChest, 3);
                const recipients = new Set([room.hostId, ...top.map((c) => c.userId)]);
                recipients.forEach((uid) => applyChestReward(uid, o.reward));
                recipients.forEach((uid) => pushWalletUpdate(uid));
                io.to(roomId).emit("chest-opened", { level: o.level, reward: o.reward, topContributors: top });
            });
        }
    });

    socket.on("music-update", ({ roomId, url, name, playing }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.music = { url, name, playing };
        io.to(roomId).emit("music-update", room.music);
    });

    // ==================================================
    // YOUTUBE ROOM PLAYER
    // Purely additive real-time layer: its own events, its own room fields
    // (videoPlaylist / videoPlayer), never touches seats/voice/gifts/admin.
    // Only the room owner or an admin can add/remove/control playback —
    // everyone else just receives broadcasts and watches (same permission
    // shape as lock-seat/clear-chat above, via isOwnerOrAdmin).
    // ==================================================
    socket.on("yt-toggle-mode", ({ roomId, on }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.videoPlayer = room.videoPlayer || freshVideoPlayerState();
        room.videoPlayer.mode = !!on;
        const found = findUserByUserId(socket.userId);
        io.to(roomId).emit("yt-mode-update", { on: room.videoPlayer.mode, byName: found ? found.user.name : "Host" });
    });

    socket.on("yt-add-video", ({ roomId, url }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        const videoId = extractYouTubeId(url);
        if (!videoId) { socket.emit("room-error", { message: "Enter a valid YouTube Link" }); return; }
        const found = findUserByUserId(socket.userId);
        if (!found) return;
        room.videoPlaylist = room.videoPlaylist || [];
        if (room.videoPlaylist.length >= 200) { socket.emit("room-error", { message: "Playlist is full" }); return; }
        const item = {
            id: crypto.randomBytes(6).toString("hex"),
            videoId,
            title: "YouTube Video",
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            addedByUserId: found.user.userId,
            addedByUsername: found.user.name,
            addedAt: new Date().toISOString()
        };
        room.videoPlaylist.push(item);
        saveVideoPlaylists();
        io.to(roomId).emit("yt-playlist-update", room.videoPlaylist);
        // Title fetch is best-effort and never blocks the add itself — the
        // item already went out above with a placeholder title.
        fetchYouTubeTitle(videoId, url).then((title) => {
            const liveRoom = rooms[roomId];
            if (!liveRoom) return;
            const it = (liveRoom.videoPlaylist || []).find((v) => v.id === item.id);
            if (!it) return;
            it.title = title;
            saveVideoPlaylists();
            io.to(roomId).emit("yt-playlist-update", liveRoom.videoPlaylist);
        });
    });

    socket.on("yt-remove-video", ({ roomId, videoItemId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.videoPlaylist = room.videoPlaylist || [];
        const idx = room.videoPlaylist.findIndex((v) => v.id === videoItemId);
        if (idx === -1) return;
        room.videoPlaylist.splice(idx, 1);
        room.videoPlayer = room.videoPlayer || freshVideoPlayerState();
        if (room.videoPlayer.currentIndex === idx) {
            // Currently-playing video got deleted — stop cleanly instead of
            // pointing at a now-missing/shifted index.
            room.videoPlayer.currentIndex = -1;
            room.videoPlayer.isPlaying = false;
            room.videoPlayer.position = 0;
            room.videoPlayer.updatedAt = Date.now();
            io.to(roomId).emit("yt-player-update", publicVideoPlayer(room));
        } else if (room.videoPlayer.currentIndex > idx) {
            room.videoPlayer.currentIndex -= 1;
        }
        saveVideoPlaylists();
        io.to(roomId).emit("yt-playlist-update", room.videoPlaylist);
    });

    function ytPlayIndex(room, index) {
        if (!room.videoPlaylist || !room.videoPlaylist.length) return;
        const i = ((index % room.videoPlaylist.length) + room.videoPlaylist.length) % room.videoPlaylist.length;
        room.videoPlayer = room.videoPlayer || freshVideoPlayerState();
        room.videoPlayer.currentIndex = i;
        room.videoPlayer.isPlaying = true;
        room.videoPlayer.position = 0;
        room.videoPlayer.updatedAt = Date.now();
        io.to(room.roomId).emit("yt-player-update", publicVideoPlayer(room));
    }

    socket.on("yt-play", ({ roomId, videoItemId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.videoPlaylist = room.videoPlaylist || [];
        if (!room.videoPlaylist.length) return;
        room.videoPlayer = room.videoPlayer || freshVideoPlayerState();
        if (videoItemId) {
            const idx = room.videoPlaylist.findIndex((v) => v.id === videoItemId);
            if (idx === -1) return;
            ytPlayIndex(room, idx);
            return;
        }
        if (room.videoPlayer.currentIndex === -1) { ytPlayIndex(room, 0); return; }
        room.videoPlayer.isPlaying = true;
        room.videoPlayer.updatedAt = Date.now();
        io.to(roomId).emit("yt-player-update", publicVideoPlayer(room));
    });

    socket.on("yt-pause", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.videoPlayer = room.videoPlayer || freshVideoPlayerState();
        room.videoPlayer.position = currentYtPosition(room.videoPlayer);
        room.videoPlayer.isPlaying = false;
        room.videoPlayer.updatedAt = Date.now();
        io.to(roomId).emit("yt-player-update", publicVideoPlayer(room));
    });

    // Owner-side periodic drift correction while playing (client sends this
    // every few seconds) — keeps late joiners / long sessions in sync
    // without forcing a seek on every other client for every tick.
    socket.on("yt-seek", ({ roomId, position }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.videoPlayer = room.videoPlayer || freshVideoPlayerState();
        room.videoPlayer.position = Math.max(0, Number(position) || 0);
        room.videoPlayer.updatedAt = Date.now();
        io.to(roomId).emit("yt-player-update", publicVideoPlayer(room));
    });

    socket.on("yt-next", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (!room.videoPlaylist || !room.videoPlaylist.length) return;
        const cur = room.videoPlayer ? room.videoPlayer.currentIndex : -1;
        ytPlayIndex(room, cur + 1);
    });

    socket.on("yt-prev", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (!room.videoPlaylist || !room.videoPlaylist.length) return;
        const cur = room.videoPlayer ? room.videoPlayer.currentIndex : -1;
        ytPlayIndex(room, cur - 1);
    });

    // Reported by whichever client is actually driving playback (the
    // owner/admin's player) when a video finishes — auto-advances the
    // room. Guarded by the same permission check so a stray event from an
    // audience member's own (view-only) player can never skip anyone.
    socket.on("yt-ended", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (!room.videoPlaylist || !room.videoPlaylist.length) return;
        const cur = room.videoPlayer ? room.videoPlayer.currentIndex : -1;
        if (cur + 1 < room.videoPlaylist.length) {
            ytPlayIndex(room, cur + 1);
        } else {
            room.videoPlayer.isPlaying = false;
            room.videoPlayer.position = 0;
            room.videoPlayer.updatedAt = Date.now();
            io.to(roomId).emit("yt-player-update", publicVideoPlayer(room));
        }
    });

    // God Power "Invisible Mode" self-toggle — only usable by a holder whose
    // is_invisible permission is currently on. Voice/socket stay untouched;
    // this only removes them from the member/online-user rosters (see
    // isHiddenUser / publicRoom / roomListPublic).
    socket.on("toggle-invisible", () => {
        const found = findUserByUserId(socket.userId);
        if (!found || !found.user.is_invisible) return;
        found.user.invisibleActive = !found.user.invisibleActive;
        saveUsers();
        socket.emit("invisible-state", { active: found.user.invisibleActive });
        if (socket.currentRoom && rooms[socket.currentRoom]) {
            io.to(socket.currentRoom).emit("room-state", publicRoom(rooms[socket.currentRoom]));
        }
        io.emit("room-list", roomListPublic());
    });

    socket.on("lock-seat", ({ roomId, seatNumber, locked }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.lockedSeats = room.lockedSeats || [];
        if (locked) { if (!room.lockedSeats.includes(seatNumber)) room.lockedSeats.push(seatNumber); }
        else room.lockedSeats = room.lockedSeats.filter((n) => n !== seatNumber);
        io.to(roomId).emit("seat-lock-update", { seatNumber, locked });
    });

    // Room Lock (#11): only the room owner may lock/unlock or change the
    // password. Locking without a password is rejected — a lock always
    // needs one. Only the hash is ever kept server-side or persisted.
    socket.on("set-room-lock", ({ roomId, locked, password }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.userId) return;
        if (locked) {
            const pw = (password || "").trim();
            if (!pw) { socket.emit("room-error", { message: "Enter a Password to lock" }); return; }
            room.roomLocked = true;
            room.roomPasswordHash = hashRoomPassword(pw);
        } else {
            room.roomLocked = false;
            room.roomPasswordHash = null;
        }
        saveRoomsToDisk();
        io.to(roomId).emit("room-state", publicRoom(room));
        io.emit("room-list", roomListPublic());
        socket.emit("room-lock-saved", { locked: room.roomLocked });
    });

    socket.on("update-room-background", ({ roomId, url }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.background = url;
        saveRoomsToDisk();
        io.to(roomId).emit("room-background-update", { url });
    });

    socket.on("update-room-logo", ({ roomId, url }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.logo = url;
        saveRoomsToDisk();
        io.to(roomId).emit("room-logo-update", { url });
        io.emit("room-list", roomListPublic());
    });

    socket.on("clear-chat", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        room.messages = [];
        const found = findUserByUserId(socket.userId);
        io.to(roomId).emit("chat-cleared", { by: found ? found.user.name : "Admin" });
    });

    socket.on("close-room", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.userId) return;
        io.to(roomId).emit("kicked", { message: "Room closed" });
        const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
        if (socketsInRoom) socketsInRoom.forEach((sid) => { const s = io.sockets.sockets.get(sid); if (s) { s.leave(roomId); s.currentRoom = null; } });
        fwTeardownRoom(roomId); // STABILIZATION FIX (Phase 3): stop any orphaned Fruit Wheel interval
        voiceSfu.sync.onRoomClosed(roomId); // PHASE 3, STEP 3.4 — deletes the mapped LiveKit room; no-op unless VOICE_MODE=sfu
        if (String(roomId) === CS101_ROOM_ID) {
            socket.emit("room-error", { message: "Official AI Customer Service Room 101 cannot be closed." });
            return;
        }
        delete rooms[roomId];
        saveRoomsToDisk();
        deleteVideoPlaylist(roomId);
        aiRoomAssistant.clearRoom(roomId);
        io.emit("room-list", roomListPublic());
    });

    socket.on("kick-user", ({ roomId, targetUserId }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId) || targetUserId === room.hostId) return;
        if (isModActionRateLimited(socket.userId)) return; // MODULE 5.2
        if (isImmuneUser(targetUserId)) return rejectImmune(socket);
        const targetSocketId = socketsByUserId[targetUserId];
        handleUserLeaveRoom(roomId, targetUserId, null);
        emitToUser(targetUserId, "kicked", { message: "You have been removed from the room" }); // GAP #1 — cross-instance-safe
        if (targetSocketId) {
            const s = io.sockets.sockets.get(targetSocketId);
            if (s) { s.leave(roomId); s.currentRoom = null; }
        }
    });

    socket.on("set-admin", ({ roomId, targetUserId, isAdmin }) => {
        const room = rooms[roomId];
        if (!room || room.hostId !== socket.userId) return;
        if (isModActionRateLimited(socket.userId)) return; // MODULE 5.2
        room.adminIds = room.adminIds || [];
        if (isAdmin) { if (!room.adminIds.includes(targetUserId)) room.adminIds.push(targetUserId); }
        else room.adminIds = room.adminIds.filter((id) => id !== targetUserId);
        saveRoomsToDisk();
        io.to(roomId).emit("room-state", publicRoom(room));
    });

    // ---- Host/Admin bulk moderation on multiple selected users at once.
    // None of these touch coins/diamonds/wallet — purely room UI/state. ----

    // Mute selected users' mics for N minutes (0 = unmute now). Server is
    // the source of truth for mute state; it's up to the WebRTC layer on the
    // client to stop sending audio while its own userId is muted.
    socket.on("mod-mute-users", ({ roomId, targetUserIds, minutes }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (isModActionRateLimited(socket.userId)) return; // MODULE 5.2
        room.mutedUntil = room.mutedUntil || {};
        const mins = Math.max(0, Math.min(1440, parseInt(minutes, 10) || 0));
        const ids = Array.isArray(targetUserIds) ? targetUserIds.filter((uid) => uid !== room.hostId && !isImmuneUser(uid)) : [];
        if (!ids.length) return;
        const until = mins > 0 ? Date.now() + mins * 60000 : 0;
        ids.forEach((uid) => {
            if (until > 0) room.mutedUntil[uid] = until;
            else delete room.mutedUntil[uid];
        });
        io.to(roomId).emit("mod-mute-update", { targetUserIds: ids, mutedUntil: until || null });
        io.to(roomId).emit("room-state", publicRoom(room));
    });

    // Ban Chat: blocks a single user's ability to send messages in this
    // room (mic/seat state untouched). Same permission tier as the other
    // per-user moderation actions.
    socket.on("mod-chat-ban", ({ roomId, targetUserId, banned }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId) || targetUserId === room.hostId) return;
        if (isModActionRateLimited(socket.userId)) return; // MODULE 5.2
        if (isImmuneUser(targetUserId)) return rejectImmune(socket);
        room.chatBannedIds = room.chatBannedIds || [];
        if (banned) { if (!room.chatBannedIds.includes(targetUserId)) room.chatBannedIds.push(targetUserId); }
        else room.chatBannedIds = room.chatBannedIds.filter((id) => id !== targetUserId);
        io.to(roomId).emit("room-state", publicRoom(room));
    });

    // Invite selected users to take an open seat — sends a personal prompt
    // to each target only; nothing happens until they accept (which just
    // calls the existing take-seat flow client-side).
    socket.on("mod-invite-to-seat", ({ roomId, targetUserIds }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (isModActionRateLimited(socket.userId)) return; // MODULE 5.2
        const hostFound = findUserByUserId(socket.userId);
        const openSeats = room.seats.map((s, i) => (s ? null : i + 1)).filter((n) => n !== null);
        if (!openSeats.length) return;
        const ids = Array.isArray(targetUserIds) ? targetUserIds : [];
        ids.forEach((uid, idx) => {
            const seatNumber = openSeats[idx % openSeats.length];
            emitToUser(uid, "seat-invite", { roomId, seatNumber, fromName: hostFound ? hostFound.user.name : "Host" }); // GAP #1 — cross-instance-safe
        });
    });

    // Feature: Owner/Admin "Move Mic" — move a seated user directly to a
    // different (empty, unlocked) seat in one click, instead of having to
    // Remove From Seat then separately Invite To Seat in two steps.
    socket.on("mod-move-seat", ({ roomId, targetUserId, seatNumber }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (isModActionRateLimited(socket.userId)) return;
        if (isImmuneUser(targetUserId)) return rejectImmune(socket);
        const result = cs101IsRoom(roomId) ? cs101MoveSeat(room, targetUserId, seatNumber) : null;
        if (result) { if (!result.ok) io.to(socket.id).emit("room-error", { message: result.message }); return; }
        const destIdx = Number(seatNumber) - 1;
        if (!Number.isInteger(destIdx) || destIdx < 0 || destIdx >= room.seats.length) return;
        if (room.seats[destIdx]) { io.to(socket.id).emit("room-error", { message: "Seat is not empty" }); return; }
        if ((room.lockedSeats || []).includes(Number(seatNumber))) { io.to(socket.id).emit("room-error", { message: "Seat is locked" }); return; }
        const fromIdx = room.seats.findIndex((s) => s && s.userId === targetUserId);
        if (fromIdx === -1) return;
        const seatData = room.seats[fromIdx];
        room.seats[fromIdx] = null;
        room.seats[destIdx] = seatData;
        io.to(roomId).emit("seat-update", { action: "move", fromSeatNumber: fromIdx + 1, seatNumber: destIdx + 1, userId: targetUserId, socketId: seatData.socketId, userName: seatData.userName, userPhoto: seatData.userPhoto, activeFrame: seatData.activeFrame || null, vipLevel: seatData.vipLevel || 0, customTag: seatData.customTag || null, nameEffect: seatData.nameEffect || null, role: roleForUser(room, targetUserId) });
        io.to(roomId).emit("room-state", publicRoom(room));
        voiceSfu.sync.onSeatChanged(roomId, targetUserId, { seatNumber: destIdx + 1, isHost: room.hostId === targetUserId, isModerator: (room.adminIds || []).includes(targetUserId), canPublish: true });
        friendshipCp.emitToRoomRelationshipState(room);
    });

    // Move selected users off their seat, back to audience. Same underlying
    // action as "Remove from Seat" — just triggered on a batch of users.
    socket.on("mod-move-to-audience", ({ roomId, targetUserIds }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (isModActionRateLimited(socket.userId)) return; // MODULE 5.2
        const ids = new Set((Array.isArray(targetUserIds) ? targetUserIds : []).filter((uid) => uid !== room.hostId && !isImmuneUser(uid)));
        if (!ids.size) return;
        let changed = false;
        room.seats.forEach((s, i) => {
            if (s && ids.has(s.userId)) {
                room.seats[i] = null;
                changed = true;
                io.to(roomId).emit("seat-update", { action: "leave", seatNumber: i + 1, userId: s.userId });
                // PHASE 3, STEP 3.4 — revokes publish permission (moved to
                // audience, not removed from the LiveKit room); no-op
                // unless VOICE_MODE=sfu. See sync.js's onSeatChanged.
                voiceSfu.sync.onSeatChanged(roomId, s.userId, { seatNumber: null, canPublish: false });
            }
        });
        if (changed) {
            friendshipCp.emitToRoomRelationshipState(room);
            io.to(roomId).emit("room-state", publicRoom(room));
        }
    });

    // Room-local label shown on the seat/name (e.g. "Speaker", "Guest") —
    // separate from the paid/admin-panel customTag; only visible in this
    // room and cleared automatically when the room resets. Empty text clears it.
    socket.on("mod-label-users", ({ roomId, targetUserIds, text, color }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (isModActionRateLimited(socket.userId)) return; // MODULE 5.2
        room.seatLabels = room.seatLabels || {};
        const cleanText = (text || "").trim().slice(0, 14);
        const ids = Array.isArray(targetUserIds) ? targetUserIds : [];
        ids.forEach((uid) => {
            if (cleanText) room.seatLabels[uid] = { text: cleanText, color: (color || "#F7CE7E").slice(0, 20) };
            else delete room.seatLabels[uid];
        });
        io.to(roomId).emit("room-state", publicRoom(room));
    });

    // Announcement sent only to the selected users (as opposed to a
    // room-wide announcement broadcast) — shows as a toast/system note on
    // their client.
    socket.on("mod-announce-users", ({ roomId, targetUserIds, message }) => {
        const room = rooms[roomId];
        if (!room || !isOwnerOrAdmin(room, socket.userId)) return;
        if (isModActionRateLimited(socket.userId)) return; // MODULE 5.2
        const text = sanitizeText((message || "").trim(), 300); // Phase 10: also strips control chars
        if (!text) return;
        const hostFound = findUserByUserId(socket.userId);
        const ids = Array.isArray(targetUserIds) ? targetUserIds : [];
        ids.forEach((uid) => {
            emitToUser(uid, "mod-announcement", { fromName: hostFound ? hostFound.user.name : "Host", message: text }); // GAP #1 — cross-instance-safe
        });
    });

    // ---- Fruit Wheel: bets, results and payouts are resolved entirely by the
    // server engine above. The client only ever sends a bet request and only
    // ever receives back a broadcast round state / a wallet-update — it can't
    // report or influence its own result or balance for this game. ----
    socket.on("fruitwheel-join", ({ roomId }) => {
        if (!socket.currentRoom || socket.currentRoom !== roomId || !socket.userId) return;
        const g = fwEnsureRoom(roomId);
        if (g.emptyTimer) { clearTimeout(g.emptyTimer); g.emptyTimer = null; }
        const wasAlreadyViewer = g.viewers.has(socket.userId);
        g.viewers.add(socket.userId);
        socket.emit("fruitwheel-round", {
            roundId: g.roundId || 0,
            phase: g.phase,
            resultFoodId: g.phase === "betting" ? null : g.resultFoodId,
            endsInMs: Math.max(0, g.phaseEndsAt - Date.now()),
            // BUG FIX (Fruit Wheel audit, item #2, 2026-08-02): a refresh/reconnect
            // mid-betting-phase previously came back with no memory of a bet the
            // user already placed this round — the money was always safe
            // server-side (payout still resolves correctly against g.bets), but
            // the UI looked like the bet never landed, which could lead a user
            // to place a second real-money bet on top of the first, thinking the
            // first had failed. Sending their own current-round bet back on join
            // lets the client restore that state instead of showing empty.
            myBets: g.bets[socket.userId] || {}
        });
        if (wasAlreadyViewer) {
            console.log(`🎡 [Fruit Wheel] user ${socket.userId} resynced room ${roomId} (reconnect/refresh) — served live phase="${g.phase}"`);
        }
    });
    socket.on("fruitwheel-leaderboard-request", () => {
        if (!socket.userId) return;
        socket.emit("fruitwheel-leaderboard", fwLeaderboardPayload());
    });
    socket.on("fruitwheel-leave", ({ roomId }) => {
        const g = fruitWheelRooms[roomId];
        if (!g || !socket.userId) return;
        g.viewers.delete(socket.userId);
        fwStopRoomIfEmpty(roomId);
    });
    socket.on("fruitwheel-bet", ({ roomId, foodId, amount }) => {
        // STABILIZATION (Full Lucky Fruit audit, 2026-08-06, req #7/#10/#11):
        // every rejection path below used to just silently `return` — the
        // client had no way to distinguish "bet accepted, wallet-update is
        // coming" from "server dropped this on the floor", which is exactly
        // the kind of desync that leads someone to tap again thinking the
        // first tap failed. Every path now either acks or explicitly rejects
        // with a reason, and every rejection is recorded in g.rejectedBets
        // for the round's audit record. No payout/balance logic below this
        // comment has changed.
        const reject = (reason) => {
            if (socket.userId) {
                const g2 = fruitWheelRooms[roomId];
                if (g2 && g2.rejectedBets) {
                    g2.rejectedBets.push({ userId: socket.userId, foodId, amount, reason, at: Date.now() });
                }
            }
            socket.emit("fruitwheel-bet-rejected", { reason });
        };
        if (!socket.currentRoom || socket.currentRoom !== roomId || !socket.userId) return reject("not-in-room");
        const g = fruitWheelRooms[roomId];
        if (!g || g.phase !== "betting") return reject("betting-closed");
        if (!FRUIT_WHEEL_FOODS.some((f) => f.id === foodId)) return reject("invalid-food");
        amount = Math.floor(Number(amount) || 0);
        if (!FRUIT_WHEEL_CHIPS.includes(amount)) return reject("invalid-chip");
        const found = findUserByUserId(socket.userId);
        if (!found) return reject("user-not-found");
        if (found.user.coins < amount) return reject("insufficient-balance");

        const balanceBefore = found.user.coins;
        found.user.coins -= amount;
        const balanceAfter = found.user.coins;
        saveUsers();
        logTransaction(socket.userId, "coins", -amount, "Fruit Wheel bet");
        pushWalletUpdate(socket.userId);
        if (!g.bets[socket.userId]) g.bets[socket.userId] = {};
        g.bets[socket.userId][foodId] = (g.bets[socket.userId][foodId] || 0) + amount;

        // req #1/#5: unique Bet ID for every individual bet action, kept
        // separate from g.bets (the aggregated payout source of truth, left
        // untouched) purely for audit/history traceability.
        const betId = fwNextBetId();
        if (!g.betLog) g.betLog = [];
        g.betLog.push({ betId, userId: socket.userId, name: found.user.name, foodId, amount, balanceBefore, balanceAfter, roundId: g.roundId, at: Date.now() });

        fwPersistRounds();
        socket.emit("fruitwheel-bet-ack", { betId, foodId, amount, myBets: g.bets[socket.userId] });
    });

    // ---- Seat-8 room games: sync client-side game balance back to the real wallet ----
    // NOTE: Teen Patti still resolves its hands in the browser, so this delta is
    // client-reported for that game only; it's clamped to a sane range per sync
    // so a single call can't mint unlimited coins. Food Wheel / Fruit Wheel no
    // longer uses this path at all — its balance moves only through the
    // server-authoritative engine above, so this handler now ignores it.
    //
    // AUDIT FIX (2026-07-27, economy exploit): the per-call cap above only
    // bounded a SINGLE sync, but nothing stopped a scripted client from
    // firing this event in a tight loop — no cooldown, no rate limiter (the
    // app's rate limiter only covers HTTP routes, never Socket.IO events).
    // At up to +5,000,000 coins per call with no floor on call spacing, a
    // bot could mint effectively unlimited coins in seconds. Added: a
    // per-user cooldown between syncs and a rolling 60s cumulative-gain cap,
    // on top of (not instead of) the existing per-call clamp.
    socket.on("game-wheel-sync", ({ roomId, balance, game }) => {
        if (game === "Food Wheel" || game === "Fruit Wheel") return;
        const found = findUserByUserId(socket.userId);
        if (!found) return;

        const now = Date.now();
        const state = gameWheelSyncState[socket.userId] || { lastSync: 0, windowStart: now, windowGain: 0 };

        balance = Math.max(0, Math.floor(Number(balance) || 0));
        const before = found.user.coins;
        // STABILIZATION FIX (Bug #4): re-sized to the real Teen Patti chip
        // range (max chip 1,00,000 x 2.9x payout = 2,90,000 per hand) with
        // headroom for a hand won on more than one chip stack, instead of
        // the previous 5,000,000 cap sized for a game with a much larger
        // chip set than what actually ships in the bundle.
        const MAX_GAIN_PER_SYNC = 350000;
        let delta = Math.min(Math.max(balance - before, -before), MAX_GAIN_PER_SYNC);
        if (delta > 0 && balance - before > MAX_GAIN_PER_SYNC) {
            console.warn(`⚠️ [game-wheel-sync] user ${socket.userId} reported a gain of ${balance - before} for "${game}", clamped to ${MAX_GAIN_PER_SYNC} — likely a forged/modified client, logged for review.`);
        }
        // Duplicate-report diagnostic (Section 10 of the audit): a genuine
        // duplicate of the *same* balance is already harmless (delta≈0
        // below), but log it so repeated identical reports from one user
        // are visible in ops/monitoring rather than silently absorbed.
        if (state.lastReportedBalance === balance && now - state.lastSync < GAME_WHEEL_SYNC_COOLDOWN_MS) {
            console.log(`ℹ️ [game-wheel-sync] duplicate balance report (${balance}) from user ${socket.userId} within cooldown — ignored as a no-op, not re-credited.`);
        }
        state.lastReportedBalance = balance;

        // BUG FIX (Phase 15, "balance rollback" production bug, 2026-07-28):
        // the cooldown/window-cap below exist ONLY to stop a scripted client
        // from mint-looping coin GAINS — they were never meant to guard
        // losses, since a client reporting it lost money can't be used to
        // create coins out of nothing. The old code applied the cooldown to
        // every sync regardless of direction and, critically, DROPPED a
        // throttled call entirely with no queue/catch-up. During a fast
        // losing streak (several hands within the 3s cooldown window),
        // every loss after the first was silently discarded — the client
        // kept counting the balance down locally (real game state, not
        // fake), but the server's persisted wallet never saw most of it. If
        // the player then closed the game and opened Profile before the
        // window cleared, the fresh server-authoritative read showed the
        // stale, mostly-undeducted balance — which read as "my balance got
        // restored to what it was before I lost." Root-cause fix: only
        // gains (delta > 0) are subject to the cooldown/window-cap; losses
        // and no-ops always apply immediately, every time, so the
        // server-side wallet can never drift behind a real loss.
        if (delta > 0) {
            if (now - state.lastSync < GAME_WHEEL_SYNC_COOLDOWN_MS) return; // ignore rapid-fire gain claims only
            const remainingWindowAllowance = Math.max(0, GAME_WHEEL_SYNC_WINDOW_CAP - state.windowGain);
            delta = Math.min(delta, remainingWindowAllowance);
            state.windowGain += delta;
            state.lastSync = now;
        }
        if (now - state.windowStart > GAME_WHEEL_SYNC_WINDOW_MS) { state.windowStart = now; state.windowGain = 0; }
        gameWheelSyncState[socket.userId] = state;

        found.user.coins = clampCoinBalance(socket.userId, before + delta, "game-wheel-sync");
        // LEVEL SYSTEM UPGRADE 2026-08-04: removed — user.level no longer auto-recomputed from raw coin balance on every coin change (that was the "level increases automatically" bug). Level now only changes via idLevel.js recordGiftSent() (room gift send only), which also mirrors onto this same field. See idLevel.js.
        if (delta !== 0) logTransaction(found.user.userId, "coins", delta, `${game || "Food Wheel"} game`);
        if (delta > 0) recordGameWin(found.user.name, delta, game || "Food Wheel");
        saveUsers();
        socket.emit("game-wheel-sync-result", { coins: found.user.coins });
        pushWalletUpdate(found.user.userId);
    });

    // ---- Room game (Food Wheel / Teen Patti): opening/closing it is now
    // local to whoever tapped the button only — it no longer broadcasts to
    // (and force-opens on) everyone else's screen in the room. ----
    socket.on("game-toggle", ({ roomId, open, game }) => {
        if (!socket.currentRoom || socket.currentRoom !== roomId || !socket.userId) return;
        // Intentionally not relayed to the rest of the room.
    });

    // ---- Real-time voice activity relay (drives the speaking-ring UI) ----
    // Phase 11: .volatile — this fires continuously while someone talks
    // (many times/sec), and each update supersedes the last one instantly.
    // If a recipient's connection is momentarily backed up, Socket.IO
    // would otherwise buffer these and deliver a burst of stale
    // speaking-state late; volatile just drops them when not immediately
    // deliverable, which is strictly better for a value that's replaced
    // faster than any buffered backlog could be useful. Every OTHER emit
    // in this file (chat, gifts, bans, kicks, wallet updates, room state)
    // is deliberately left non-volatile — those must always arrive.
    socket.on("voice-activity", ({ roomId, speaking }) => {
        if (!socket.currentRoom || socket.currentRoom !== roomId || !socket.userId) return;
        socket.volatile.to(roomId).emit("voice-activity", { userId: socket.userId, speaking: !!speaking });
    });

    // ---- WebRTC signaling relay ----
    // ROOT-CAUSE FIX (voice stability pass): these three handlers used to
    // forward straight to whatever `target` socket id the client sent, with
    // no check that the sender/target were actually seated in the same
    // voice room, no verification the target socket still exists, no rate
    // limit, and no try/catch — a malformed payload here could throw
    // uncaught and take the socket (or, for certain error types, the
    // process) down. relayVoiceSignal() below centralizes the same
    // validate-then-relay logic for all three so the fix only needs to live
    // in one place.
    function relayVoiceSignal(event, socket, target, targetUserId, payload) {
        try {
            if (!socket.userId || !socket.currentRoom || !target || !targetUserId) return;
            if (aiSecurity.isRateLimited(`voice-sig:${socket.userId}`, { windowMs: 10000, max: 200 })) return;
            const room = rooms[socket.currentRoom];
            if (!room) return;
            // Authorize the destination by userId against the authoritative
            // room seat list, then address the socket id through Socket.IO's
            // adapter. This is important in clustered deployments: the old
            // code used io.sockets.sockets.get(target), which only finds a
            // socket on THIS Node instance, so a third seated speaker on a
            // different instance could become visible but completely silent.
            const targetSeat = (room.seats || []).find((seat) => seat && seat.userId === targetUserId);
            const targetIsAudience = (room.onlineUsers || []).some((u) => u && u.userId === targetUserId);
            if (!targetSeat && !targetIsAudience) return;
            if (targetSeat && targetSeat.socketId && targetSeat.socketId !== target) return;
            // A seated speaker may be heard by an audience listener, so the
            // receiver does not have to occupy a seat. The client never
            // publishes while it is an audience member. io.to(socketId) is
            // cross-instance-safe when the Redis adapter is enabled.
            io.to(target).emit(event, { ...payload, from: socket.id });
        } catch (e) {
            console.error(`[voice-signal] ${event} relay error:`, e && e.message);
        }
    }
    socket.on("voice-offer", ({ target, targetUserId, offer }) => relayVoiceSignal("voice-offer", socket, target, targetUserId, { offer }));
    socket.on("voice-answer", ({ target, targetUserId, answer }) => relayVoiceSignal("voice-answer", socket, target, targetUserId, { answer }));
    socket.on("voice-candidate", ({ target, targetUserId, candidate }) => relayVoiceSignal("voice-candidate", socket, target, targetUserId, { candidate }));

    socket.on("disconnect", () => {
        if (socket.userId) removeCallSocket(socket.userId, socket.id);
        // VOICE FIX (multi-device): previously this only ran when the
        // disconnecting socket was the single "primary" one in
        // socketsByUserId — so if a user had an active call open on an
        // older/background tab while a newer tab was their "primary" (e.g.
        // just opened Home in a second tab), that call's disconnect was
        // silently never handled at all. handleDisconnect() has its own
        // check for whether this exact socket is the one actually attached
        // to a live call, so it's safe (a no-op) to call unconditionally
        // for every disconnecting socket rather than gating it here.
        if (socket.userId) callSignaling.handleDisconnect(socket.userId, socket.id);
        if (socket.userId) callHosting.handleDisconnect(socket.userId, socket.id);
        if (socket.userId && socketsByUserId[socket.userId] === socket.id) {
            broadcastFollowStatus(socket.userId, "offline", null);
            (findUserByUserId(socket.userId)?.user.groups || []).forEach((gid) => broadcastGroupUpdate(gid));
            delete gameWheelSyncState[socket.userId];
        }
        if (socket.userId) {
            Object.keys(fruitWheelRooms).forEach((rid) => {
                const g = fruitWheelRooms[rid];
                if (g.viewers.delete(socket.userId)) fwStopRoomIfEmpty(rid);
            });
        }
        if (socket.currentRoom && socket.userId) {
            const uid = socket.userId, rid = socket.currentRoom;
            const myGen = socket.connGen; // ROOT-CAUSE FIX (2026-08-14) — captured at schedule time, see userConnGeneration comment above
            console.log(`🔌 Disconnect: user ${uid} from room ${rid} (socket ${socket.id}) — starting grace period`);
            voiceSfu.sync.onParticipantGraceStart(rid, uid); // PHASE 3, STEP 3.4 — no-op unless VOICE_MODE=sfu; does not remove the SFU participant, only tags metadata (see sync.js)
            // IMPORTANT: surface the server's 30s presence grace period to every
            // voice peer. Clients can then hold/rebuild the correct peer instead
            // of destroying a healthy media path merely because the signaling
            // socket briefly disappeared.
            voiceReconnect.notifyPeerDisconnecting(rid, uid);
            pendingDisconnects[uid] = {
                roomId: rid,
                socketId: socket.id,
                timer: setTimeout(() => {
                    // Fix (random logout / room desync): this timer was scheduled by
                    // THIS socket's disconnect. If the user has since reconnected
                    // (e.g. page refresh, brief network drop + auto-reconnect) their
                    // new socket already registered itself in socketsByUserId and
                    // cleared this entry via join-room. If that entry now points at
                    // a *different* socket id, the reconnect simply hasn't reached
                    // the server yet in time to cancel this particular timer (rare
                    // but possible under load) — either way, only actually remove
                    // the user from the room if no newer connection has taken over.
                    //
                    // ROOT-CAUSE FIX (2026-08-14, socket lifecycle race protection):
                    // added the connGen check as a second, independent signal
                    // alongside the socketsByUserId check. socketsByUserId[uid] is a
                    // single mutable slot — under a fast enough sequence of
                    // disconnect/reconnect/disconnect events it is theoretically
                    // possible for it to briefly hold a value that still matches
                    // this timer's captured socket.id by coincidence (e.g. the user
                    // reconnected, then their brand-new connection also dropped
                    // before this timer fired, on a socket.id the pool happened to
                    // reuse-look-alike). userConnGeneration only ever increases and
                    // is bumped on every real rebind, so comparing it too closes
                    // that gap: this callback now only acts if BOTH the socket id
                    // AND the generation it was scheduled for are still current.
                    const staleBySocket = socketsByUserId[uid] && socketsByUserId[uid] !== socket.id;
                    const staleByGeneration = myGen !== undefined && userConnGeneration[uid] !== myGen;
                    if (staleBySocket || staleByGeneration) {
                        console.log(`↩️  Skipping stale leave for user ${uid} — already reconnected on a new socket/session`);
                        delete pendingDisconnects[uid];
                        return;
                    }
                    console.log(`🚪 Grace period expired: removing user ${uid} from room ${rid}`);
                    handleUserLeaveRoom(rid, uid, socket, true);
                    delete pendingDisconnects[uid];
                }, 30000) // grace period so a brief network drop / browser refresh doesn't yank the seat.
                // FIX (login/session investigation, 2026-07-29): was 8000ms. Real-world
                // logs showed refreshes that legitimately reconnect (client bootstrap
                // validates the session, opens the socket, then rejoins the room) but
                // don't always make it back inside 8s on a slow mobile connection or a
                // cold page load — the seat was being freed out from under a person who
                // WAS coming back, just a couple seconds too slowly. 30s comfortably
                // covers that full round trip while still being short enough that a
                // person who's actually gone (closed the tab, left) is cleaned up
                // promptly, not indefinitely.
            };
        } else if (socket.userId) {
            // AUDIT FIX (2026-07-29, socket-reconnection-stability): same grace-period
            // cleanup as above, for a user who disconnected while NOT in any room (e.g.
            // browsing Home). Without this, socketsByUserId[uid] never gets cleared and
            // the user stays "online" forever on a dead socket.id (see comment at the
            // pendingPresenceDisconnects declaration for the full explanation).
            const uid = socket.userId;
            const myGen = socket.connGen; // ROOT-CAUSE FIX (2026-08-14) — same generation guard as the room-grace timer above
            pendingPresenceDisconnects[uid] = {
                socketId: socket.id,
                timer: setTimeout(() => {
                    const staleByGeneration = myGen !== undefined && userConnGeneration[uid] !== myGen;
                    if (socketsByUserId[uid] === socket.id && !staleByGeneration) {
                        delete socketsByUserId[uid];
                        console.log(`👋 Presence grace period expired: user ${uid} fully offline (no room) — cleared socketsByUserId`);
                    } else {
                        console.log(`↩️  Skipping stale presence cleanup for user ${uid} — already reconnected on a new socket/session`);
                    }
                    delete pendingPresenceDisconnects[uid];
                }, 30000) // matches the room-seat grace period above, same refresh-tolerance reasoning
            };
        }
    });
});

// Keep every room's daily chest timer honest even when nobody is gifting.
setInterval(() => {
    Object.values(rooms).forEach((room) => {
        if (!room.treasureChest) return;
        const before = room.treasureChest.resetAt;
        ensureChestFresh(room);
        if (room.treasureChest.resetAt !== before) {
            io.to(room.roomId).emit("room-state", publicRoom(room));
        }
    });
}, 60 * 1000);

// ==================================================
// START SERVER
// ==================================================
const PORT = process.env.PORT || 3000;
// Migrate/ensure the legacy single-admin login has a first-class RBAC
// "owner" identity. Runs once — if an owner account already exists
// (e.g. created on a previous boot), this is a no-op.
const ownerAccount = rbac.ensureOwnerAccount(ADMIN_USERNAME, ADMIN_PASSWORD);

// ==================================================
// REAL RANKING SYSTEM — CP / ROOM / TOP GIFTERS
// Additive integration over the existing Auth/User/Room/Gift/Wallet data.
// No wallet deduction or gift sending is implemented here.
// ==================================================
const { initRankingService } = require("./rankings/ranking.service.js");
const rankingService = initRankingService({
    app, io, userAuth,
    findUserByUserId,
    getUsers: () => users,
    getRooms: () => rooms,
    getGiftHistory: () => giftHistory,
    getAcceptedRelationships: friendshipCp.getAcceptedRelationships,
    onGiftRecorded: registerGiftRecordedHook
});

// PingPong Club — production integration. The club module is initialized
// only after the real gift history recorder and auth/user services exist,
// so confirmed gifts can contribute to clubs without touching wallet logic.
const { initClubService } = require("./club.service.js");
const clubService = initClubService({
    app, io, DATA_FOLDER, safeRead, safeWrite, userAuth, findUserByUserId, users,
    onGiftRecorded: registerGiftRecordedHook
});

// Phase 10: global fallback error handler — must be the LAST app.use().
// Catches multer errors (wrong file type / over size limit) from any
// upload route that doesn't already have its own scoped handler (video-
// gifts and gifts already had one — see above), plus any other thrown/
// next(err) error, and returns JSON instead of Express's default HTML
// stack-trace page (which would leak internals in production).
app.use((err, req, res, next) => {
    if (!err) return next();
    console.error(`❌ Unhandled error on ${req.method} ${req.originalUrl}:`, err.message);
    if (res.headersSent) return next(err);
    res.status(err.status || 400).json({ success: false, message: err.message || "Server error" });
});

// STABILIZATION (Bug #2 recovery, Teen Patti/Food Wheel audit): run once at
// boot, before any socket can join a Fruit Wheel room — refunds any bets
// left over from a round that was interrupted by the previous restart.
fwRecoverRoundsOnBoot();
// Persist the final round snapshot on a graceful shutdown too (SIGTERM from
// a deploy, SIGINT from Ctrl+C), same pattern as writeQueue's flushAll, so
// a normal restart round-trips through fwRecoverRoundsOnBoot() above with
// accurate data instead of a stale snapshot from the last mid-round save.
process.on("SIGTERM", () => { try { fwPersistRounds(); } catch (_) {} });
process.on("SIGINT", () => { try { fwPersistRounds(); } catch (_) {} });

const renderMetrics = createMetrics({ rooms, socketsByUserId, voiceHealth });
app.get("/api/metrics", (req, res) => {
    // Metrics are operational data, not a user API. In production, expose
    // this endpoint only behind a private network/reverse-proxy ACL.
    if (process.env.METRICS_PUBLIC !== "true" && process.env.NODE_ENV === "production") {
        const token = process.env.METRICS_TOKEN || "";
        const supplied = (req.headers.authorization || "").startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
        if (!token || supplied !== token) return res.status(401).type("text/plain").send("unauthorized\n");
    }
    res.type("text/plain; version=0.0.4").send(renderMetrics());
});

http.listen(PORT, () => {
    console.log(`🏓 ${APP_NAME} server running on port ${PORT}`);
    console.log(`   Mobile app:  http://localhost:${PORT}/`);
    console.log(`   Admin panel: http://localhost:${PORT}/admin/`);
    console.log(`   Admin login configured for owner: ${ADMIN_USERNAME}  (password intentionally not logged)`);
    aiMonitor.start(() => ({
        onlineUsers: Object.keys(socketsByUserId).length,
        activeRooms: Object.keys(rooms).length,
    }));
});
