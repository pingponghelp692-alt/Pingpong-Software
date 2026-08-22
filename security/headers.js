// ==================================================
// PHASE 10 — SECURITY HEADERS (additive, no new dependency)
// ==================================================
// A hand-rolled equivalent of the common `helmet` presets — no extra
// package needed. Mount this once, early, in server.js:
//   const { securityHeaders } = require("./security/headers");
//   app.use(securityHeaders);
//
// Notes on choices made here:
// - CSP is deliberately permissive on media/img/connect (this app serves
//   its own uploaded photos/music/video-gifts from same-origin static
//   routes, and the mobile WebView + admin panel both use inline
//   <script>/<style> in a few places) — a hostile lockdown CSP would break
//   existing pages. `default-src 'self'` plus explicit allowances is a
//   real improvement over having no CSP at all without risking breakage.
// - HSTS is only sent when the request actually arrived over HTTPS (via
//   `req.secure` or a trusted `x-forwarded-proto: https`, e.g. behind
//   nginx/Cloudflare). Sending HSTS on a plain-HTTP dev/Termux setup would
//   make the browser refuse to even try HTTP next time, which would brick
//   local testing.
// - X-Powered-By removal happens here too (avoids leaking "Express").

function securityHeaders(req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-XSS-Protection", "0"); // deprecated in modern browsers; explicit 0 avoids legacy filter false-positives, CSP is the real defense
    res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=(self), payment=()");
    res.setHeader(
        "Content-Security-Policy",
        [
            "default-src 'self'",
            // Bug fix (YouTube Room Player wouldn't start): this CSP had no
            // allowance at all for YouTube. `script-src` blocked the
            // https://www.youtube.com/iframe_api script tag the player
            // depends on (window.onYouTubeIframeAPIReady never fired), and
            // there was no `frame-src` directive, so it fell back to
            // `default-src 'self'` and silently blocked the youtube.com
            // <iframe> embed itself — both failures are invisible in the UI,
            // they just look like "nothing happens". img-src is extended too
            // so video thumbnails (i.ytimg.com) actually render.
            // Bug fix (Emoji Reaction popup looked empty / taps did
            // nothing): same root cause as the YouTube fix above — CSP had
            // no allowance for the dotLottie player, which the Emoji
            // Reaction feature loads from unpkg.com (script) and fetches
            // its WASM render engine from jsdelivr/unpkg at runtime.
            // 'wasm-unsafe-eval' is required for the browser to compile
            // that WASM module at all under a strict script-src.
            // Bug fix (Firebase Phone OTP / Google Login: "Cannot read
            // properties of undefined (reading 'sendPhoneOtp'/
            // 'signInWithGoogle')", 2026-08-03): root cause was THIS CSP,
            // not app.js/firebaseClient.js. script-src had no allowance for
            // https://www.gstatic.com (where the Firebase SDK itself is
            // hosted) or https://apis.google.com (which the SDK loads at
            // runtime for the Google Sign-In popup helper). The browser
            // silently blocked those <script> tags, so the global `firebase`
            // object never existed; firebaseClient.js's top-level
            // `firebase.initializeApp(...)` then threw immediately and
            // aborted before reaching its last line
            // (`window.ppFirebaseAuth = {...}`) — which is exactly why that
            // object came back undefined at click time. Same class of bug
            // as the YouTube/dotLottie CSP fixes above, different vendor.
            // Bug fix (Robin/Vapi voice: "start-method-error", 2026-08-12):
            // same root-cause class as the three bugs documented above — this
            // CSP had no allowance for Vapi's Web SDK dependency, daily-js.
            // vapi.start() internally opens a Daily.co call object: it needs
            // (a) an iframe origin on *.daily.co (frame-src), (b) blob:
            // workers for Krisp noise-cancellation (script-src blob:), and
            // (c) https/wss connections to api.vapi.ai and *.daily.co
            // (connect-src). None of these were present, so the browser
            // silently blocked the underlying Daily call setup and the SDK
            // surfaced that as a generic "start-method-error" — the SDK
            // itself was never broken. The standalone minimal test page
            // worked because it wasn't served through this middleware, so
            // no CSP applied to it at all.
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://www.youtube.com https://s.ytimg.com https://unpkg.com https://cdn.jsdelivr.net https://www.gstatic.com https://apis.google.com https://esm.sh https://*.daily.co",
            "style-src 'self' 'unsafe-inline'",
            // gstatic.com serves the "Continue with Google" icon we use, and
            // Google Sign-In returns a photo URL on lh3.googleusercontent.com
            // (decoded.picture in /api/auth/firebase-login on the server).
            "img-src 'self' data: blob: https://i.ytimg.com https://*.ytimg.com https://www.gstatic.com https://lh3.googleusercontent.com",
            "media-src 'self' blob: https://*.daily.co",
            // accounts.google.com hosts the Google Sign-In popup itself;
            // *.firebaseapp.com hosts the invisible reCAPTCHA iframe Phone
            // Auth depends on (recaptcha-container) and the OAuth redirect
            // handler page Firebase uses internally even in popup mode.
            // *.daily.co is Vapi/Robin's underlying call iframe (see note above).
            "frame-src 'self' https://www.youtube.com https://youtube.com https://accounts.google.com https://*.firebaseapp.com https://*.daily.co",
            "worker-src 'self' blob:",
            // securetoken/identitytoolkit are the REST endpoints the
            // Firebase Auth SDK itself calls (send OTP, verify OTP, verify
            // ID token, refresh token) — without these every SDK call fails
            // at the network level even once the script itself loads fine.
            // api.vapi.ai + *.daily.co are Robin's call-setup/signaling
            // endpoints (see Vapi/daily-js CSP note above).
            "connect-src 'self' ws: wss: https://www.youtube.com https://unpkg.com https://cdn.jsdelivr.net https://apis.google.com https://esm.sh https://securetoken.googleapis.com https://www.googleapis.com https://identitytoolkit.googleapis.com https://api.vapi.ai https://*.daily.co wss://*.daily.co",
            "font-src 'self' data:",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'self'"
        ].join("; ")
    );
    const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
    if (isHttps) {
        res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
    res.removeHeader("X-Powered-By");
    next();
}

module.exports = { securityHeaders };
