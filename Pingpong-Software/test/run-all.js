// test/run-all.js
// Small dependency-free test runner for the repository's standalone
// regression suites. Each suite is executed in its own Node process so
// module-level state (sessions, Redis mocks, timers) cannot leak between
// tests.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = __dirname;
const rootFiles = fs.readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => path.join(dir, f));

// PRODUCTION AUDIT FIX (2026-08-10): these three suites (94 assertions
// total, independently re-verified passing on 2026-08-10) existed and
// passed when run directly with `node <file>`, but were never discovered
// by this runner because they live under integration_update/ rather than
// test/. That meant `npm test` and CI (.github/workflows/ci.yml, which
// only runs `npm test`) silently never exercised them. Adding them here
// is additive only — same execution model (separate process per file),
// no change to how root ./test/*.test.js suites run or are counted.
const extraDirs = [
  path.join(dir, "..", "integration_update", "country_permission", "test"),
  path.join(dir, "..", "integration_update", "merchant", "test"),
  path.join(dir, "..", "integration_update", "module4_wallet_ledger", "test")
];
const extraFiles = [];
for (const d of extraDirs) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    // module4_wallet_ledger/test/ also has mockPg.js, a helper — not a
    // suite itself, so the .test.js suffix filter (same rule as root)
    // correctly excludes it.
    if (f.endsWith(".test.js")) extraFiles.push(path.join(d, f));
    // regression_tests.js / extra_boundary_tests.js don't follow the
    // *.test.js naming convention (predate it) but are real suites.
    if (f === "regression_tests.js" || f === "extra_boundary_tests.js") extraFiles.push(path.join(d, f));
  }
}

const files = [...rootFiles, ...extraFiles].sort();

let passedSuites = 0;
let failed = [];

for (const fullPath of files) {
  const label = path.relative(path.join(dir, ".."), fullPath);
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(process.execPath, [fullPath], {
    stdio: "inherit",
    env: process.env
  });

  if (result.status === 0) {
    passedSuites++;
  } else {
    failed.push(label);
  }
}

console.log("\n==================================================");
console.log(`Suites: ${passedSuites}/${files.length} passed`);
if (failed.length) console.log(`Failed: ${failed.join(", ")}`);
console.log("==================================================");

process.exit(failed.length ? 1 : 0);
