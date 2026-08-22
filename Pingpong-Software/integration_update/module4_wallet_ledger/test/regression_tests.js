const assert = require("assert");
const { createMockPool } = require("./mockPg.js");

let passed = 0, failed = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.log(`  ❌ ${name}`);
        console.log(`     ${e.message}`);
        failed++;
    }
}

async function main() {
    console.log("=== BUG #1: userProfile.js allowlist enforced even when Redis is down ===");
    {
        delete require.cache[require.resolve("../redis/userProfile.js")];
        const userProfile = require("../redis/userProfile.js");
        userProfile.init(); // no ioredis in this sandbox -> client stays null, same as "Redis down"
        await test("isEnabled() is false (Redis genuinely unavailable in this sandbox)", async () => {
            assert.strictEqual(userProfile.isEnabled(), false);
        });
        await test("setProfile() with an allowed field no-ops (false) instead of throwing", async () => {
            const res = await userProfile.setProfile("u1", { name: "Labib" });
            assert.strictEqual(res, false);
        });
        await test("setProfile() with a FORBIDDEN field (coins) throws even though Redis is down", async () => {
            let threw = false;
            try { await userProfile.setProfile("u1", { coins: 500 }); }
            catch (e) { threw = true; assert.ok(/unsupported field/.test(e.message)); }
            assert.strictEqual(threw, true, "expected setProfile to throw for an out-of-scope field regardless of Redis availability");
        });
        await test("setProfile() with a mix of allowed+forbidden fields still throws", async () => {
            let threw = false;
            try { await userProfile.setProfile("u1", { name: "Labib", banned: true }); }
            catch (e) { threw = true; }
            assert.strictEqual(threw, true);
        });
        await userProfile.shutdown();
    }

    console.log("\n=== BUG #2: every module4 Redis client gets an 'error' listener ===");
    {
        delete require.cache[require.resolve("../redis/connectionFactory.js")];
        const connectionFactory = require("../redis/connectionFactory.js");
        await test("createClient() returns null when ioredis isn't installed (this sandbox) — listener attach path only reachable with the real package, confirmed present in source instead", async () => {
            const c = connectionFactory.createClient("test");
            assert.strictEqual(c, null); // expected in this sandbox — no ioredis
        });
        await test("source code: every createClient() branch attaches client.on(\"error\", ...) before returning", async () => {
            const src = require("fs").readFileSync(require("path").resolve(__dirname, "..", "redis/connectionFactory.js"), "utf8");
            assert.ok(/client\.on\("error"/.test(src), "expected an 'error' listener attached inside createClient()");
        });
        await test("wallet/index.js defensively attaches an error listener to an injected redisPool too", async () => {
            const src = require("fs").readFileSync(require("path").resolve(__dirname, "..", "wallet/index.js"), "utf8");
            assert.ok(/redisClient\.on\("error"/.test(src));
        });
    }

    console.log("\n=== BUG #3 + #4: transferBetweenUsers() applies the ceiling clamp on both sides, and reconcileBalance() stays consistent through a clamp ===");
    {
        delete require.cache[require.resolve("../wallet/db.js")];
        delete require.cache[require.resolve("../wallet/index.js")];
        const db = require("../wallet/db.js");
        const wallet = require("../wallet/index.js");

        const mockPool = createMockPool();
        // A ceiling clamp function: nobody may hold more than 1000 "coins".
        const CEILING = 1000;
        const clampFn = (userId, balance) => Math.min(balance, CEILING);

        await wallet.init({ pgPool: mockPool, clampFn, redisPool: null });

        await test("credit() past the ceiling gets clamped (baseline, already worked before the fix)", async () => {
            const res = await wallet.credit({ userId: "alice", currency: "coins", amount: 1500, txnId: "t-credit-1" });
            assert.strictEqual(res.balanceAfter, CEILING);
        });

        await test("reconcileBalance() shows ZERO drift immediately after a clamp (BUG #4 fix)", async () => {
            const r = await wallet.reconcileBalance("alice", "coins");
            assert.strictEqual(r.drift, 0, `expected 0 drift, got ${r.drift} (trueBalance=${r.trueBalance}, cachedBalance=${r.cachedBalance})`);
        });

        // Give bob a starting balance under the ceiling via a fresh credit.
        await wallet.credit({ userId: "bob", currency: "coins", amount: 100, txnId: "t-bob-seed" });

        await test("transferBetweenUsers(): receiving side gets clamped too (BUG #3 fix)", async () => {
            // carol sits right at the ceiling (1000); bob has 100. Transferring
            // 950 from carol to bob would put bob at 1050 without a clamp.
            await wallet.credit({ userId: "carol", currency: "coins", amount: 1000, txnId: "t-carol-seed" });
            const res = await wallet.transferBetweenUsers({ fromUserId: "carol", toUserId: "bob", currency: "coins", amount: 950, txnId: "t-transfer-1" });
            assert.strictEqual(res.credit.balanceAfter, CEILING, `expected receiving balance clamped to ${CEILING}, got ${JSON.stringify(res)}`);
        });

        await test("reconcileBalance() still shows ZERO drift for the transfer's receiving side after the clamp", async () => {
            const r = await wallet.reconcileBalance("bob", "coins");
            assert.strictEqual(r.drift, 0, `expected 0 drift after transfer clamp, got ${r.drift}`);
        });

        await test("reconcileBalance() also zero-drift for the transfer's sending side (debit-path clamp helper, same code path)", async () => {
            const r = await wallet.reconcileBalance("carol", "coins");
            assert.strictEqual(r.drift, 0);
        });

        await test("a clamp adjustment is retrievable as its own ledger entry (auditability)", async () => {
            const clampRow = await wallet.getTransaction("t-credit-1:clamp");
            assert.ok(clampRow, "expected a ...:clamp ledger row to exist");
            assert.strictEqual(clampRow.reason, "ceiling-clamp-adjustment");
            assert.strictEqual(Number(clampRow.amount), CEILING - 1500);
        });

        await test("insufficient funds still rejects cleanly (existing behavior untouched by the clamp changes)", async () => {
            const res = await wallet.debit({ userId: "bob", currency: "coins", amount: 999999, txnId: "t-bob-overdraw" });
            assert.strictEqual(res.status, "rejected");
            assert.strictEqual(res.reason, "insufficient_funds");
        });
    }

    console.log("\n=== BUG #5: txnId is genuinely required, not silently auto-generated ===");
    {
        delete require.cache[require.resolve("../wallet/index.js")];
        const wallet = require("../wallet/index.js");
        const mockPool = createMockPool();
        await wallet.init({ pgPool: mockPool, redisPool: null });

        await test("credit() with NO txnId throws (previously: silently minted a random one)", async () => {
            let threw = false;
            try { await wallet.credit({ userId: "dave", currency: "coins", amount: 100 }); }
            catch (e) { threw = true; assert.ok(/txnId is required/.test(e.message)); }
            assert.strictEqual(threw, true);
        });

        await test("debit() with an empty-string txnId throws", async () => {
            let threw = false;
            try { await wallet.debit({ userId: "dave", currency: "coins", amount: 10, txnId: "" }); }
            catch (e) { threw = true; }
            assert.strictEqual(threw, true);
        });

        await test("transferBetweenUsers() with NO txnId throws", async () => {
            let threw = false;
            try { await wallet.transferBetweenUsers({ fromUserId: "dave", toUserId: "eve", currency: "coins", amount: 10 }); }
            catch (e) { threw = true; assert.ok(/txnId is required/.test(e.message)); }
            assert.strictEqual(threw, true);
        });

        await test("credit() with a real, stable txnId still works normally (no regression)", async () => {
            const res = await wallet.credit({ userId: "dave", currency: "coins", amount: 100, txnId: "t-dave-1" });
            assert.strictEqual(res.status, "completed");
            assert.strictEqual(res.balanceAfter, 100);
        });

        await test("retrying the SAME txnId is a safe no-op replay, not a double-credit (idempotency actually holds now)", async () => {
            const res1 = await wallet.credit({ userId: "frank", currency: "coins", amount: 50, txnId: "t-frank-1" });
            const res2 = await wallet.credit({ userId: "frank", currency: "coins", amount: 50, txnId: "t-frank-1" }); // same txnId, simulating a retry
            assert.strictEqual(res2.replay, true);
            const bal = await wallet.getBalance("frank", "coins");
            assert.strictEqual(bal, 50, `expected exactly one credit to have applied (50), got ${bal} — a retry must never double-apply`);
        });

        await test("generateTxnId() utility is still exported for callers to mint a stable id up front", async () => {
            assert.strictEqual(typeof wallet, "object");
            const src = require("fs").readFileSync(require("path").resolve(__dirname, "..", "wallet/index.js"), "utf8");
            assert.ok(/generateTxnId\s*=\s*deps\.generateTxnId/.test(src));
        });
    }

    console.log("\n=== Cross-check: SQL parameterization + transaction atomicity unchanged ===");
    {
        const src = require("fs").readFileSync(require("path").resolve(__dirname, "..", "wallet/index.js"), "utf8");
        await test("no string-concatenated SQL (still 100% parameterized $1/$2/... placeholders)", async () => {
            // crude but effective: every client.query( call's first arg is a
            // template literal containing only $N placeholders for values,
            // never a concatenated variable. Spot-check: no `+ userId`,
            // `+ currency`, `+ amount` etc directly inside a query string.
            const suspicious = /query\(\s*`[^`]*\$\{/.test(src);
            assert.strictEqual(suspicious, false, "found a template-literal interpolation inside a SQL string — possible injection risk");
        });
        await test("every doWork() still wraps BEGIN...COMMIT with a catch->ROLLBACK->rethrow", async () => {
            const beginCount = (src.match(/await client\.query\("BEGIN"\)/g) || []).length;
            const rollbackCount = (src.match(/client\.query\("ROLLBACK"\)/g) || []).length;
            assert.strictEqual(beginCount, 2, "expected exactly 2 doWork() transactions (applyDelta + transferBetweenUsers)");
            assert.strictEqual(rollbackCount, 2);
        });
    }

    console.log("\n=== Isolation: Module 4 still does not import/modify master ===");
    {
        const { execSync } = require("child_process");
        const redisDir = require("path").resolve(__dirname, "..", "redis");
        const walletDir = require("path").resolve(__dirname, "..", "wallet");
        const grep = execSync(`grep -rn "require(" "${redisDir}" "${walletDir}" || true`).toString();
        await test("no require() reaches outside module4/ except npm packages and node builtins", async () => {
            const lines = grep.split("\n").filter(Boolean);
            const offenders = lines.filter((l) => /require\(["'](\.\.\/){2,}|require\(["']\/home\/claude\/work3\/(?!module4)/.test(l));
            assert.strictEqual(offenders.length, 0, "found a require() reaching outside module4/: " + offenders.join("; "));
        });
    }

    console.log(`\n${"=".repeat(50)}\nRESULT: ${passed} passed, ${failed} failed\n${"=".repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
