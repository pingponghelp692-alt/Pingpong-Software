// test/productionAuditWiring.test.js
// Regression coverage for two PRODUCTION AUDIT FIX changes made on
// 2026-08-10 (see FINAL_PRODUCTION_AUDIT_REPORT.md / CHANGELOG_FINAL.md):
//   1. ai/ai-service.js now retries a failed provider.generate() call via
//      the previously-unwired ai/ai-recovery.js retryJob() helper.
//   2. integration_update/middleware's requestId() helper is now wired
//      into server.js as global HTTP middleware for correlation IDs.
// No npm deps, runs standalone: node test/productionAuditWiring.test.js

const path = require("path");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

console.log("=== ai-service.js: transient provider failure is retried, not surfaced immediately ===");
{
  const geminiPath = require.resolve(path.join(__dirname, "..", "ai", "providers", "gemini-provider"));
  const configPath = require.resolve(path.join(__dirname, "..", "ai", "ai-config"));
  let calls = 0;
  require.cache[geminiPath] = {
    id: geminiPath, filename: geminiPath, loaded: true,
    exports: {
      generate: async () => {
        calls++;
        if (calls < 2) throw new Error("simulated transient 503");
        return { text: "ok after retry", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    }
  };
  require.cache[configPath] = {
    id: configPath, filename: configPath, loaded: true,
    exports: { AI_PROVIDER: "gemini", PROVIDER_PRICING: { gemini: { inputPerM: 0, outputPerM: 0 } } }
  };
  delete require.cache[require.resolve(path.join(__dirname, "..", "ai", "ai-service"))];
  const aiService = require(path.join(__dirname, "..", "ai", "ai-service"));

  (async () => {
    const text = await aiService.generateReply([{ role: "user", content: "hi" }], "sys");
    assert(text === "ok after retry", "generateReply() succeeds after one simulated transient failure");
    assert(calls === 2, "provider.generate() was called exactly twice (1 failure + 1 retry), not swallowed or looped forever");
    runPermanentFailureCheck();
  })().catch((e) => {
    fail++;
    console.error("  ✗ FAIL: unexpected throw on transient-failure case:", e.message);
    runPermanentFailureCheck();
  });
}

function runPermanentFailureCheck() {
  console.log("\n=== ai-service.js: permanent provider failure still rejects (no infinite retry, no silent success) ===");
  const geminiPath = require.resolve(path.join(__dirname, "..", "ai", "providers", "gemini-provider"));
  let calls = 0;
  require.cache[geminiPath].exports = {
    generate: async () => { calls++; throw new Error("simulated permanent outage"); }
  };
  delete require.cache[require.resolve(path.join(__dirname, "..", "ai", "ai-service"))];
  const aiService = require(path.join(__dirname, "..", "ai", "ai-service"));

  aiService.generateReply([{ role: "user", content: "hi" }], "sys")
    .then(() => {
      fail++;
      console.error("  ✗ FAIL: should have rejected on permanent failure, but resolved instead");
      finish();
    })
    .catch((err) => {
      assert(err.message === "simulated permanent outage", "rejects with the underlying provider error after retries are exhausted");
      assert(calls === 3, "retried exactly retries+1 (2 retries + original) times, then stopped — bounded, not unbounded");
      finish();
    });
}

function finish() {
  console.log("\n=== integration_update/middleware: requestId() sets correlation ID on req + response header ===");
  const sharedMiddleware = require(path.join(__dirname, "..", "integration_update", "middleware"));
  const headers = {};
  const req = { get: () => undefined };
  const res = { set: (h, v) => { headers[h] = v; } };
  let nextCalled = false;
  sharedMiddleware.requestId(req, res, () => { nextCalled = true; });
  assert(nextCalled === true, "calls next() so the request pipeline continues");
  assert(typeof req.requestId === "string" && req.requestId.length > 0, "sets a non-empty req.requestId");
  assert(headers["x-request-id"] === req.requestId, "response x-request-id header matches req.requestId exactly");

  console.log("\n=== integration_update/middleware: requestId() honors an incoming x-request-id (client/proxy correlation) ===");
  const incomingId = "client-supplied-trace-id-123";
  const req2 = { get: (h) => (h === "x-request-id" ? incomingId : undefined) };
  const headers2 = {};
  const res2 = { set: (h, v) => { headers2[h] = v; } };
  sharedMiddleware.requestId(req2, res2, () => {});
  assert(req2.requestId === incomingId, "reuses an incoming x-request-id instead of generating a new one, preserving upstream correlation");

  console.log("\n==================================================");
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("==================================================");
  process.exit(fail === 0 ? 0 : 1);
}
