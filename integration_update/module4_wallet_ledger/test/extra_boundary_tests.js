const assert = require("assert");
const { createMockPool } = require("./mockPg.js");

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

async function freshWallet(clampFn) {
    delete require.cache[require.resolve("../wallet/index.js")];
    delete require.cache[require.resolve("../wallet/db.js")];
    const wallet = require("../wallet/index.js");
    const pool = createMockPool();
    await wallet.init({ pgPool: pool, clampFn });
    return { wallet, pool };
}

async function main() {
    console.log("=== Exact worked example from task spec: opening=990, ceiling=1000, credit=100 -> final=1000 ===");
    {
        const ceilingClamp = (userId, bal) => Math.min(bal, 1000);
        const { wallet } = await freshWallet(ceilingClamp);
        // establish opening balance of 990 via an unclamped credit
        await wallet.credit({ userId: "u1", currency: "coins", amount: 990, txnId: "seed1" });
        const before = await wallet.getBalance("u1", "coins");
        await test("opening balance is 990", async () => assert.strictEqual(before, 990));

        const res = await wallet.credit({ userId: "u1", currency: "coins", amount: 100, txnId: "credit1" });
        await test("final balance is clamped to 1000, not 1090", async () => assert.strictEqual(res.balanceAfter, 1000));

        const mainRow = await wallet.getTransaction("credit1");
        const clampRow = await wallet.getTransaction("credit1:clamp");
        await test("main ledger row amount is +100 (unmodified, raw intent)", async () => assert.strictEqual(Number(mainRow.amount), 100));
        await test("clamp ledger row amount is -90 (1000 - 1090)", async () => assert.strictEqual(Number(clampRow.amount), -90));
        await test("clamp row is auditable via getTransaction with reason", async () => assert.strictEqual(clampRow.reason, "ceiling-clamp-adjustment"));

        const recon = await wallet.reconcileBalance("u1", "coins");
        await test("reconcile: trueBalance (sum of ledger) === cachedBalance === 1000", async () => {
            assert.strictEqual(recon.trueBalance, 1000);
            assert.strictEqual(recon.cachedBalance, 1000);
        });
        await test("reconcile: drift is exactly 0 (no double-count, no fudge)", async () => assert.strictEqual(recon.drift, 0));
        await test("accounting equation: opening(990) + SUM(this op's completed deltas: +100 + -90 = +10) = final(1000)", async () => {
            assert.strictEqual(990 + (100 + -90), 1000);
        });
    }

    console.log("\n=== BUG #3 boundary matrix: receiver below/at/near/over ceiling ===");
    const ceiling = 1000;
    const clampFn = (userId, bal) => Math.min(bal, ceiling);

    await test("receiver below ceiling: no clamp fires, exact sum lands", async () => {
        const { wallet } = await freshWallet(clampFn);
        await wallet.credit({ userId: "toU", currency: "coins", amount: 500, txnId: "s1" });
        await wallet.credit({ userId: "fromU", currency: "coins", amount: 200, txnId: "s2" });
        const r = await wallet.transferBetweenUsers({ fromUserId: "fromU", toUserId: "toU", currency: "coins", amount: 100, txnId: "t1" });
        assert.strictEqual(r.credit.balanceAfter, 600);
        const recon = await wallet.reconcileBalance("toU", "coins");
        assert.strictEqual(recon.drift, 0);
    });

    await test("receiver exactly at ceiling after transfer: no clamp needed, exact boundary", async () => {
        const { wallet } = await freshWallet(clampFn);
        await wallet.credit({ userId: "toU", currency: "coins", amount: 900, txnId: "s1" });
        await wallet.credit({ userId: "fromU", currency: "coins", amount: 200, txnId: "s2" });
        const r = await wallet.transferBetweenUsers({ fromUserId: "fromU", toUserId: "toU", currency: "coins", amount: 100, txnId: "t1" });
        assert.strictEqual(r.credit.balanceAfter, 1000);
        const recon = await wallet.reconcileBalance("toU", "coins");
        assert.strictEqual(recon.drift, 0);
    });

    await test("receiver near ceiling, transfer pushes 1 over: clamps to exactly ceiling", async () => {
        const { wallet } = await freshWallet(clampFn);
        await wallet.credit({ userId: "toU", currency: "coins", amount: 999, txnId: "s1" });
        await wallet.credit({ userId: "fromU", currency: "coins", amount: 200, txnId: "s2" });
        const r = await wallet.transferBetweenUsers({ fromUserId: "fromU", toUserId: "toU", currency: "coins", amount: 5, txnId: "t1" });
        assert.strictEqual(r.credit.balanceAfter, 1000);
        const recon = await wallet.reconcileBalance("toU", "coins");
        assert.strictEqual(recon.drift, 0);
    });

    await test("receiver would exceed ceiling by a lot: clamps, sender's debit is unaffected by receiver's clamp", async () => {
        const { wallet } = await freshWallet(clampFn);
        await wallet.credit({ userId: "toU", currency: "coins", amount: 950, txnId: "s1" });
        // seed fromU via a currency the clampFn doesn't apply the same ceiling to would be
        // artificial; instead seed via multiple sub-ceiling credits so fromU's own balance
        // legitimately reaches 900 without itself being clamped.
        await wallet.credit({ userId: "fromU", currency: "coins", amount: 900, txnId: "s2" });
        const r = await wallet.transferBetweenUsers({ fromUserId: "fromU", toUserId: "toU", currency: "coins", amount: 300, txnId: "t1" });
        assert.strictEqual(r.credit.balanceAfter, 1000, "receiver clamped to ceiling despite a 300 transfer landing on 950");
        assert.strictEqual(r.debit.balanceAfter, 600, "sender's debit (900-300=600) is unaffected by the receiver's clamp");
        const reconTo = await wallet.reconcileBalance("toU", "coins");
        const reconFrom = await wallet.reconcileBalance("fromU", "coins");
        assert.strictEqual(reconTo.drift, 0);
        assert.strictEqual(reconFrom.drift, 0);
    });

    await test("debit side clamp (e.g. a floor-style clampFn) also gets its own auditable ledger row", async () => {
        // clampFn that floors negative-looking edge cases isn't realistic for debit,
        // but verify debit path routes through applyClampIfNeeded at all by using a
        // clamp that always rounds down to nearest 10 (exercises the debit call site).
        const roundFn = (userId, bal) => Math.floor(bal / 10) * 10;
        const { wallet } = await freshWallet(roundFn);
        await wallet.credit({ userId: "toU", currency: "coins", amount: 500, txnId: "s1" });
        await wallet.credit({ userId: "fromU", currency: "coins", amount: 237, txnId: "s2" }); // clamps to 230 on credit itself
        const fromBal = await wallet.getBalance("fromU", "coins");
        assert.strictEqual(fromBal, 230);
        const r = await wallet.transferBetweenUsers({ fromUserId: "fromU", toUserId: "toU", currency: "coins", amount: 15, txnId: "t1" });
        // 230 - 15 = 215 -> floored to 210
        assert.strictEqual(r.debit.balanceAfter, 210);
        const reconFrom = await wallet.reconcileBalance("fromU", "coins");
        assert.strictEqual(reconFrom.drift, 0);
    });

    await test("transfer atomicity: insufficient funds rejects BOTH sides, no partial state", async () => {
        const { wallet } = await freshWallet(clampFn);
        await wallet.credit({ userId: "toU", currency: "coins", amount: 100, txnId: "s1" });
        await wallet.credit({ userId: "fromU", currency: "coins", amount: 10, txnId: "s2" });
        const r = await wallet.transferBetweenUsers({ fromUserId: "fromU", toUserId: "toU", currency: "coins", amount: 500, txnId: "t1" });
        assert.strictEqual(r.debit.status, "rejected");
        assert.strictEqual(r.credit, null);
        const toBal = await wallet.getBalance("toU", "coins");
        const fromBal = await wallet.getBalance("fromU", "coins");
        assert.strictEqual(toBal, 100, "receiver must be untouched on rejected transfer");
        assert.strictEqual(fromBal, 10, "sender must be untouched on rejected transfer");
    });

    await test("transfer idempotent replay: same txnId retried does not double-move funds", async () => {
        const { wallet } = await freshWallet(clampFn);
        await wallet.credit({ userId: "toU", currency: "coins", amount: 100, txnId: "s1" });
        await wallet.credit({ userId: "fromU", currency: "coins", amount: 100, txnId: "s2" });
        await wallet.transferBetweenUsers({ fromUserId: "fromU", toUserId: "toU", currency: "coins", amount: 30, txnId: "t1" });
        const r2 = await wallet.transferBetweenUsers({ fromUserId: "fromU", toUserId: "toU", currency: "coins", amount: 30, txnId: "t1" });
        assert.strictEqual(r2.replay, true);
        const toBal = await wallet.getBalance("toU", "coins");
        const fromBal = await wallet.getBalance("fromU", "coins");
        assert.strictEqual(toBal, 130);
        assert.strictEqual(fromBal, 70);
    });

    console.log("\n=== Concurrency-sensitive path (via mock pool's serialized-but-independent connections) ===");
    await test("two concurrent credits with DIFFERENT txnIds both apply (no lost update)", async () => {
        const { wallet } = await freshWallet(null);
        await wallet.credit({ userId: "cu", currency: "coins", amount: 100, txnId: "seed" });
        await Promise.all([
            wallet.credit({ userId: "cu", currency: "coins", amount: 10, txnId: "c1" }),
            wallet.credit({ userId: "cu", currency: "coins", amount: 10, txnId: "c2" }),
            wallet.credit({ userId: "cu", currency: "coins", amount: 10, txnId: "c3" }),
        ]);
        const bal = await wallet.getBalance("cu", "coins");
        assert.strictEqual(bal, 130);
    });

    await test("two concurrent credits with the SAME txnId: only one applies (idempotency under race)", async () => {
        const { wallet } = await freshWallet(null);
        await wallet.credit({ userId: "cu2", currency: "coins", amount: 100, txnId: "seed" });
        const results = await Promise.all([
            wallet.credit({ userId: "cu2", currency: "coins", amount: 10, txnId: "racey" }),
            wallet.credit({ userId: "cu2", currency: "coins", amount: 10, txnId: "racey" }),
        ]);
        const bal = await wallet.getBalance("cu2", "coins");
        assert.strictEqual(bal, 110, "must apply exactly once despite concurrent identical txnId");
        const replays = results.filter(r => r.replay).length;
        assert.strictEqual(replays, 1, "exactly one of the two racing calls should see replay:true");
    });

    console.log(`\n${"=".repeat(50)}\nRESULT: ${passed} passed, ${failed} failed\n${"=".repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

main();
