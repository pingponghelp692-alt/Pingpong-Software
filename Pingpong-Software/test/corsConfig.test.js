// test/corsConfig.test.js
// Verifies security/corsConfig.js — the real module, not a re-implementation.
// No npm deps, no real HTTP server / Socket.IO instance needed: the module
// exposes its origin-check logic as pure functions specifically so this can
// run standalone (see corsConfig.js's own comment on why).
//
// Run: node test/corsConfig.test.js

const path = require("path");
const {
  parseAllowlist,
  isOriginAllowed,
  corsOriginCallback,
  getAllowlist
} = require(path.join(__dirname, "..", "security", "corsConfig.js"));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

console.log("=== parseAllowlist ===");
{
  assert(parseAllowlist(undefined) === null, "unset env value parses to null (not configured)");
  assert(parseAllowlist("") === null, "empty string parses to null (not configured)");
  assert(parseAllowlist("   ") === null, "whitespace-only parses to null (not configured)");
  const list = parseAllowlist("https://a.example.com, https://b.example.com ,https://a.example.com");
  assert(list instanceof Set, "returns a Set when configured");
  assert(list.size === 2, "de-duplicates and trims entries (3 in, 2 unique out)");
  assert(list.has("https://a.example.com") && list.has("https://b.example.com"), "contains the exact trimmed origins");
  const trailingSlash = parseAllowlist("https://c.example.com/");
  assert(trailingSlash.has("https://c.example.com"), "trailing slash is stripped when parsing");
}

console.log("=== isOriginAllowed: no Origin header (mobile app / same-origin / curl) ===");
{
  assert(isOriginAllowed(undefined, null) === true, "no Origin header allowed when unconfigured");
  assert(isOriginAllowed(undefined, new Set(["https://prod.example.com"])) === true, "no Origin header allowed even WITH an allowlist configured (never a cross-origin browser request)");
}

console.log("=== isOriginAllowed: CORS_ORIGINS configured (explicit allowlist) ===");
{
  const allowlist = parseAllowlist("https://prod.example.com,https://admin.example.com");
  assert(isOriginAllowed("https://prod.example.com", allowlist) === true, "an allowlisted origin is allowed");
  assert(isOriginAllowed("https://admin.example.com", allowlist) === true, "a second allowlisted origin is allowed");
  assert(isOriginAllowed("https://evil.example.com", allowlist) === false, "a non-allowlisted origin is rejected");
  assert(isOriginAllowed("http://prod.example.com", allowlist) === false, "scheme mismatch (http vs https) is rejected — exact match required");
  assert(isOriginAllowed("https://prod.example.com:8443", allowlist) === false, "port mismatch is rejected — exact match required");
  assert(isOriginAllowed("https://prod.example.com/", allowlist) === true, "a trailing slash on the incoming Origin is tolerated");
}

console.log("=== isOriginAllowed: CORS_ORIGINS NOT configured (safe default) ===");
{
  assert(isOriginAllowed("http://localhost:3000", null) === true, "localhost (dev) is allowed by default");
  assert(isOriginAllowed("http://127.0.0.1:5173", null) === true, "127.0.0.1 (dev) is allowed by default");
  assert(isOriginAllowed("https://localhost", null) === true, "localhost with no port is allowed by default");
  assert(isOriginAllowed("https://random-site.com", null) === false, "an arbitrary cross-origin browser request is REJECTED by default (was previously wide open)");
  assert(isOriginAllowed("https://notlocalhost.com", null) === false, "a domain merely containing 'localhost' as a substring is still rejected");
}

console.log("=== corsOriginCallback: shape expected by both `cors` and Socket.IO ===");
{
  let calledWith = null;
  process.env.CORS_ORIGINS = "https://prod.example.com";
  corsOriginCallback("https://prod.example.com", (err, allow) => { calledWith = { err, allow }; });
  assert(calledWith.err === null, "callback never passes an Error (a rejected origin is just denied, not thrown)");
  assert(calledWith.allow === true, "callback allows a configured origin");

  corsOriginCallback("https://not-allowed.example.com", (err, allow) => { calledWith = { err, allow }; });
  assert(calledWith.err === null, "callback never passes an Error for a rejected origin either");
  assert(calledWith.allow === false, "callback denies a non-configured origin");
  delete process.env.CORS_ORIGINS;
}

console.log("=== getAllowlist(): reflects live process.env.CORS_ORIGINS ===");
{
  delete process.env.CORS_ORIGINS;
  assert(getAllowlist() === null, "reads null when env is unset");
  process.env.CORS_ORIGINS = "https://x.example.com";
  const list = getAllowlist();
  assert(list && list.has("https://x.example.com"), "reads the configured allowlist once env is set");
  delete process.env.CORS_ORIGINS;
}

console.log("\n==================================================");
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
