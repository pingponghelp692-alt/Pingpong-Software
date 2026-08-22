// test/aiProviderFallback.test.js
// Verifies ai/ai-service.js's cross-provider fallback (AUDIT FIX 2026-08-12):
// if the primary provider throws, and AI_FALLBACK_PROVIDER names a different,
// key-configured provider, that provider is tried before the caller sees an
// error. Also verifies the old single-provider behavior is unchanged when no
// fallback is configured.
//
// HONEST LIMITATION: this mocks ai/providers/gemini-provider.js and
// ai/providers/openai-provider.js at the require-cache level so no real
// network call is made — same "no network egress in this sandbox"
// limitation documented in test/paramsValidation.test.js. What's verified
// here is the real routing/retry/fallback logic in ai-service.js itself,
// against fake providers with controlled success/failure.
//
// Run: node test/aiProviderFallback.test.js

const path = require("path");
const Module = require("module");

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ✓", msg); }
  else { fail++; console.error("  ✗ FAIL:", msg); }
}

const geminiPath = path.join(__dirname, "..", "ai", "providers", "gemini-provider.js");
const openaiPath = path.join(__dirname, "..", "ai", "providers", "openai-provider.js");
const configPath = path.join(__dirname, "..", "ai", "ai-config.js");
const servicePath = path.join(__dirname, "..", "ai", "ai-service.js");

function freshRequire(modPath) {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

function mockProvider(modPath, impl) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: { generate: impl }
  };
}

// ai-config.js does `require("dotenv").config()`. dotenv isn't installed in
// this sandbox (no network to npm install — same limitation noted above),
// so stub it exactly like a no-op .env loader would behave when no .env
// file is present. On a real deployment with `npm install` run, the real
// dotenv package is used instead (this stub only wins if dotenv is truly
// absent from node_modules).
try { require.resolve("dotenv"); } catch (e) {
  require.cache[require.resolve.paths ? "dotenv" : "dotenv"] = null; // no-op, resolve() below is what matters
  const Mod = require("module");
  const origResolve = Mod._resolveFilename;
  Mod._resolveFilename = function (request, ...rest) {
    if (request === "dotenv") return "dotenv-stub";
    return origResolve.call(this, request, ...rest);
  };
  require.cache["dotenv-stub"] = { id: "dotenv-stub", filename: "dotenv-stub", loaded: true, exports: { config: () => ({}) } };
}

async function withEnv(envOverrides, fn) {
  const saved = {};
  for (const k of Object.keys(envOverrides)) { saved[k] = process.env[k]; process.env[k] = envOverrides[k]; }
  // Clear cached modules that read process.env at load time.
  delete require.cache[require.resolve(configPath)];
  delete require.cache[require.resolve(servicePath)];
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(configPath)];
    delete require.cache[require.resolve(servicePath)];
  }
}

(async () => {
  console.log("=== ai-service.js: primary provider succeeds, no fallback needed ===");
  await withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "fake-key", AI_FALLBACK_PROVIDER: "openai", OPENAI_API_KEY: "fake-key-2" }, async () => {
    mockProvider(geminiPath, async () => ({ text: "hello from gemini", usage: { inputTokens: 1, outputTokens: 1 } }));
    mockProvider(openaiPath, async () => { throw new Error("openai should not be called"); });
    const { generateReply } = freshRequire(servicePath);
    const text = await generateReply([{ role: "user", content: "hi" }], "sys");
    assert(text === "hello from gemini", "returns primary provider's text when it succeeds");
  });

  console.log("=== ai-service.js: primary fails, fallback configured with key -> fallback used ===");
  await withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "fake-key", AI_FALLBACK_PROVIDER: "openai", OPENAI_API_KEY: "fake-key-2" }, async () => {
    mockProvider(geminiPath, async () => { throw new Error("Gemini API error 503: overloaded"); });
    mockProvider(openaiPath, async () => ({ text: "hello from openai fallback", usage: { inputTokens: 1, outputTokens: 1 } }));
    const { generateReply } = freshRequire(servicePath);
    const text = await generateReply([{ role: "user", content: "hi" }], "sys");
    assert(text === "hello from openai fallback", "falls back to the configured second provider when primary throws");
  });

  console.log("=== ai-service.js: primary fails, no AI_FALLBACK_PROVIDER set -> old behavior (throws) ===");
  await withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "fake-key", AI_FALLBACK_PROVIDER: "" }, async () => {
    mockProvider(geminiPath, async () => { throw new Error("Gemini API error 500"); });
    mockProvider(openaiPath, async () => ({ text: "should never be reached", usage: {} }));
    const { generateReply } = freshRequire(servicePath);
    let threw = false;
    try { await generateReply([{ role: "user", content: "hi" }], "sys"); }
    catch (e) { threw = true; assert(/500/.test(e.message), "the original primary error propagates unchanged"); }
    assert(threw, "throws (no fallback configured) exactly like before this fix — non-breaking default");
  });

  console.log("=== ai-service.js: fallback named but its own API key is missing -> not attempted, primary error propagates ===");
  await withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "fake-key", AI_FALLBACK_PROVIDER: "openai", OPENAI_API_KEY: "" }, async () => {
    mockProvider(geminiPath, async () => { throw new Error("Gemini API error 429: rate limited"); });
    let openaiCalled = false;
    mockProvider(openaiPath, async () => { openaiCalled = true; return { text: "unexpected", usage: {} }; });
    const { generateReply } = freshRequire(servicePath);
    try {
      await generateReply([{ role: "user", content: "hi" }], "sys");
      assert(false, "should have thrown");
    } catch (e) {
      assert(/429/.test(e.message), "propagates primary error when fallback has no key configured");
    }
    assert(openaiCalled === false, "never calls a fallback provider that has no API key set (avoids a confusing second error)");
  });

  console.log("=== ai-service.js: both providers fail -> primary's error surfaces (most relevant to the configured setup) ===");
  await withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "fake-key", AI_FALLBACK_PROVIDER: "openai", OPENAI_API_KEY: "fake-key-2" }, async () => {
    mockProvider(geminiPath, async () => { throw new Error("Gemini down"); });
    mockProvider(openaiPath, async () => { throw new Error("OpenAI also down"); });
    const { generateReply } = freshRequire(servicePath);
    try {
      await generateReply([{ role: "user", content: "hi" }], "sys");
      assert(false, "should have thrown");
    } catch (e) {
      assert(/Gemini down/.test(e.message), "when both fail, the primary provider's error is what's thrown (matches server-side log convention)");
    }
  });

  // Restore real provider modules for any test that runs after this file in
  // the same process (run-all.js spawns each file in its own process, so
  // this is defense-in-depth, not strictly required).
  delete require.cache[require.resolve(geminiPath)];
  delete require.cache[require.resolve(openaiPath)];

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
})();
