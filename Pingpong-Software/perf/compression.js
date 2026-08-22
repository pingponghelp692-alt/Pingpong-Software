// ==================================================
// PHASE 11 — RESPONSE COMPRESSION
// ==================================================
// Unlike security/*.js and this file's siblings (writeQueue.js,
// userIndex.js, cache.js), this ONE Phase 11 piece is NOT hand-rolled.
// Reasoning, stated plainly: gzip/deflate response compression means
// intercepting every res.write()/res.end() call and re-streaming bytes
// through zlib correctly (chunked responses, Content-Length removal,
// Accept-Encoding negotiation, already-compressed content like images
// skipped, error cases where headers are already sent, etc). That's
// exactly the kind of low-level byte-stream logic that's easy to get
// subtly wrong, and this project's sandbox has no network access to
// actually run the server and verify real HTTP responses byte-for-byte —
// so hand-rolling and shipping UNTESTED stream-mangling middleware here
// would risk silently corrupting every response in the app, which is a
// far worse outcome than adding one dependency. `compression` is the
// standard, extremely widely used (Express's own docs recommend it),
// single-purpose npm package for exactly this — it's added to
// package.json like express/socket.io/multer already are (Phase 10's
// "no new dependency" rule was specifically about auth/security-critical
// code; this is a different risk profile).
//
// Skips already-compressed binary content (images, audio, video) since
// re-compressing those wastes CPU for no size benefit — same default
// `compression` uses (content-type based filter), left as default here.

let compressionMiddleware;
try {
    compressionMiddleware = require("compression")();
} catch (err) {
    // Dependency not installed yet (run `npm install` — it's in
    // package.json). Fail open rather than crash the whole server: no
    // compression, but the app still runs.
    console.warn("⚠️  'compression' package not installed — responses will not be gzip-compressed. Run `npm install`.");
    compressionMiddleware = (req, res, next) => next();
}

module.exports = { compression: compressionMiddleware };
