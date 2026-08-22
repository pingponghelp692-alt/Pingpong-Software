// test/rechargeService.test.js
// Regression tests for wallet/rechargeService.js — covers the spec's
// requirement #16 checklist: successful/failed/cancelled/pending recharge,
// admin approve/reject, duplicate-transaction idempotency, wrong
// transaction ID, balance-manipulation isolation, ledger correctness,
// and simultaneous-approval-callback safety.
//
// Run: node test/rechargeService.test.js

const path = require("path");
const os = require("os");
const { initRechargeService } = require(path.join(__dirname, "..", "wallet", "rechargeService.js"));

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { pass++; console.log("  ✓", msg); }
    else { fail++; console.error("  ✗ FAIL:", msg); }
}

// In-memory fake safeRead/safeWrite + a fake `users` store, mirroring the
// pattern test/otpService.test.js already uses for this project's other
// initX({deps}) modules.
function makeHarness() {
    const files = {};
    const safeRead = (file, fallback) => (files[file] !== undefined ? files[file] : fallback);
    const safeWrite = (file, value) => { files[file] = JSON.parse(JSON.stringify(value)); };

    const users = {}; // mobile -> user
    function addUser(mobile, userId, coins = 0) {
        users[mobile] = { userId, mobile, coins, name: "User_" + userId };
        return users[mobile];
    }
    function findUserByUserId(userId) {
        const mobile = Object.keys(users).find((m) => users[m].userId === userId);
        return mobile ? { mobile, user: users[mobile] } : null;
    }
    let saveCount = 0;
    function saveUsers() { saveCount++; }
    const loggedTxns = [];
    function logTransaction(userId, currency, amount, note) { loggedTxns.push({ userId, currency, amount, note }); }
    const walletPushes = [];
    function pushWalletUpdate(userId) { walletPushes.push(userId); }
    function clampCoinBalance(userId, coins) { return Number.isFinite(coins) && coins >= 0 ? Math.floor(coins) : 0; }

    const svc = initRechargeService({
        DATA_FOLDER: os.tmpdir(), safeRead, safeWrite,
        findUserByUserId, saveUsers, logTransaction, pushWalletUpdate, clampCoinBalance
    });

    return { svc, users, addUser, findUserByUserId, loggedTxns, walletPushes, getSaveCount: () => saveCount };
}

function enablePayments(svc) {
    svc.updateSettings({ enabled: true, upiId: "owner@upi", receiverName: "PingPong Owner", methods: { upi: true, phonepe: true, gpay: true }, minAmountINR: 10, maxAmountINR: 10000 }, "admin_owner");
}

function makePackage(svc, overrides = {}) {
    const r = svc.createPackage(Object.assign({ priceINR: 100, coins: 1000, bonusCoins: 100, label: "Popular" }, overrides), "admin_owner");
    return r.package;
}

// PHASE 5 FIX (2026-08-17): tests 19/20 below need `await` (for the new
// async getOrderPaymentData()), and Node treats a file mixing top-level
// `require()` with top-level `await` as ambiguous module syntax (throws
// ERR_AMBIGUOUS_MODULE_SYNTAX before a single test even runs). Wrapping
// everything from here down in an async IIFE keeps this file plain
// CommonJS (require() stays require()) while still allowing await inside.
// Purely mechanical — no test logic changed, nothing un-indented, this is
// the smallest possible diff to unblock the new async tests.
(async () => {

console.log("=== 1. Successful recharge -> correct coins credited ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000001", "u1", 50);
    const created = svc.createTransaction({ mobile: "9000000001", userId: "u1", packageId: pkg.id, method: "upi", utr: "UTR12345678" });
    assert(created.transaction && created.transaction.status === "PENDING", "new recharge request starts PENDING");
    const before = findUserByUserId("u1").user.coins;
    const approved = svc.approveTransaction(created.transaction.id, "admin_owner");
    assert(approved.transaction.status === "PAID", "approved transaction is marked PAID");
    const after = findUserByUserId("u1").user.coins;
    assert(after === before + pkg.coins + pkg.bonusCoins, "user's coin balance increased by exactly package coins + bonus");
    assert(approved.ledgerEntry.balanceBefore === before && approved.ledgerEntry.balanceAfter === after, "ledger entry records the correct before/after balance");
}

console.log("=== 2. Failed / rejected payment -> 0 coins ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000002", "u2", 0);
    const created = svc.createTransaction({ mobile: "9000000002", userId: "u2", packageId: pkg.id, method: "upi", utr: "UTR-REJECT-1" });
    const rejected = svc.rejectTransaction(created.transaction.id, "admin_owner", "UTR does not match any received payment");
    assert(rejected.transaction.status === "REJECTED", "transaction marked REJECTED");
    assert(findUserByUserId("u2").user.coins === 0, "no coins credited on rejection");
}

console.log("=== 3. Cancelled payment (user-initiated) -> 0 coins ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000003", "u3", 0);
    const created = svc.createTransaction({ mobile: "9000000003", userId: "u3", packageId: pkg.id, method: "gpay", utr: "UTR-CANCEL-1" });
    const cancelled = svc.cancelTransaction("9000000003", created.transaction.id);
    assert(cancelled.transaction.status === "CANCELLED", "user can cancel their own pending transaction");
    assert(findUserByUserId("u3").user.coins === 0, "no coins credited on cancellation");
    const secondCancel = svc.cancelTransaction("9000000003", created.transaction.id);
    assert(secondCancel.error === "not-pending", "cancelling an already-cancelled transaction is rejected, not silently repeated");
}

console.log("=== 4. Pending payment -> coins not yet credited ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000004", "u4", 25);
    svc.createTransaction({ mobile: "9000000004", userId: "u4", packageId: pkg.id, method: "phonepe", utr: "UTR-PENDING-1" });
    assert(findUserByUserId("u4").user.coins === 25, "balance unchanged while a request is still PENDING");
}

console.log("=== 5. Admin-approved manual payment -> coins credited ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc, { priceINR: 500, coins: 5500, bonusCoins: 500 });
    addUser("9000000005", "u5", 0);
    const created = svc.createTransaction({ mobile: "9000000005", userId: "u5", packageId: pkg.id, method: "upi", utr: "UTR-APPROVE-500" });
    svc.approveTransaction(created.transaction.id, "admin_super1");
    assert(findUserByUserId("u5").user.coins === 6000, "admin approval credits package coins + bonus (5500+500=6000)");
}

console.log("=== 6. Rejected manual payment -> coins not credited ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000006", "u6", 10);
    const created = svc.createTransaction({ mobile: "9000000006", userId: "u6", packageId: pkg.id, method: "upi", utr: "UTR-REJECT-2" });
    svc.rejectTransaction(created.transaction.id, "admin_super1", "Amount mismatch");
    assert(findUserByUserId("u6").user.coins === 10, "balance unchanged after rejection");
}

console.log("=== 7. Same transaction processed twice -> coins credited exactly once (idempotency) ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000007", "u7", 0);
    const created = svc.createTransaction({ mobile: "9000000007", userId: "u7", packageId: pkg.id, method: "upi", utr: "UTR-DOUBLE-APPROVE" });
    const first = svc.approveTransaction(created.transaction.id, "admin_a");
    const second = svc.approveTransaction(created.transaction.id, "admin_b"); // e.g. two admins racing, or a retried request
    assert(first.transaction.status === "PAID" && !first.error, "first approval succeeds");
    assert(second.error === "not-pending", "second approval of the SAME transaction is rejected, not re-applied");
    assert(findUserByUserId("u7").user.coins === pkg.coins + pkg.bonusCoins, "coins credited exactly once, not twice, across two approve calls");
}

console.log("=== 7b. Resubmitting the same UTR as a new request is blocked at submission time ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000071", "u71", 0);
    svc.createTransaction({ mobile: "9000000071", userId: "u71", packageId: pkg.id, method: "upi", utr: "UTR-DUPE-SUBMIT" });
    const dupe = svc.createTransaction({ mobile: "9000000071", userId: "u71", packageId: pkg.id, method: "upi", utr: "UTR-DUPE-SUBMIT" });
    assert(dupe.error === "duplicate-utr", "the same UTR+method can't be submitted as a second live request");
}

console.log("=== 8. Wrong / malformed transaction ID -> rejected at submission (never silently accepted) ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000008", "u8", 0);
    const tooShort = svc.createTransaction({ mobile: "9000000008", userId: "u8", packageId: pkg.id, method: "upi", utr: "ab" });
    assert(tooShort.error === "invalid-utr", "a too-short/garbage UTR is rejected up front, not stored as a pending claim");
    const empty = svc.createTransaction({ mobile: "9000000008", userId: "u8", packageId: pkg.id, method: "upi", utr: "" });
    assert(empty.error === "invalid-utr", "an empty UTR is rejected");
}

console.log("=== 9. User cannot modify their own balance directly (module exposes no such function) ===");
{
    const { svc } = makeHarness();
    const surface = Object.keys(svc);
    assert(!surface.some((k) => /setbalance|creditcoins|adjustbalance/i.test(k)), "no direct balance-set/credit function is exposed to callers other than approveTransaction");
    assert(surface.includes("approveTransaction") && surface.includes("rejectTransaction"), "the only coin-crediting path is the admin approve function");
}

console.log("=== 9b. A user cannot cancel or act on someone else's transaction ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000009", "u9", 0);
    addUser("9000000099", "u99", 0);
    const created = svc.createTransaction({ mobile: "9000000009", userId: "u9", packageId: pkg.id, method: "upi", utr: "UTR-OWNERSHIP-1" });
    const stolen = svc.cancelTransaction("9000000099", created.transaction.id); // different mobile trying to cancel u9's request
    assert(stolen.error === "forbidden", "a different user's mobile cannot cancel someone else's pending transaction");
}

console.log("=== 10. Admin action fields (decidedBy) always reflect the server-supplied adminId, never client input ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000010", "u10", 0);
    const created = svc.createTransaction({ mobile: "9000000010", userId: "u10", packageId: pkg.id, method: "upi", utr: "UTR-ADMINID-1" });
    const approved = svc.approveTransaction(created.transaction.id, "admin_real_id");
    assert(approved.transaction.decidedBy === "admin_real_id", "decidedBy is set from the adminId parameter the route derives from the authenticated session, not any client-supplied field");
}

console.log("=== 11. Full transaction history is queryable/filterable for admin records + user wallet history ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000011", "u11", 0);
    const t1 = svc.createTransaction({ mobile: "9000000011", userId: "u11", packageId: pkg.id, method: "upi", utr: "UTR-HIST-1" });
    svc.approveTransaction(t1.transaction.id, "admin_x");
    const t2 = svc.createTransaction({ mobile: "9000000011", userId: "u11", packageId: pkg.id, method: "gpay", utr: "UTR-HIST-2" });
    svc.rejectTransaction(t2.transaction.id, "admin_x", "test");

    const userHistory = svc.getUserHistory("9000000011");
    assert(userHistory.length === 2, "user's own recharge history shows both their transactions");

    const paidOnly = svc.listTransactionsAdmin({ status: "PAID" });
    assert(paidOnly.items.length === 1 && paidOnly.items[0].id === t1.transaction.id, "admin records can filter by status=PAID");
    const byUtr = svc.listTransactionsAdmin({ q: "HIST-2" });
    assert(byUtr.items.length === 1 && byUtr.items[0].id === t2.transaction.id, "admin records can search by UTR substring");
    assert(typeof paidOnly.total === "number" && typeof paidOnly.page === "number" && typeof paidOnly.totalPages === "number", "admin listing is paginated");
}

console.log("=== 12. balance-before/balance-after ledger correctness across multiple recharges ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc, { priceINR: 50, coins: 500, bonusCoins: 0 });
    addUser("9000000012", "u12", 200);
    const t1 = svc.createTransaction({ mobile: "9000000012", userId: "u12", packageId: pkg.id, method: "upi", utr: "UTR-LEDGER-1" });
    const a1 = svc.approveTransaction(t1.transaction.id, "admin_x");
    assert(a1.ledgerEntry.balanceBefore === 200 && a1.ledgerEntry.balanceAfter === 700, "first ledger entry: 200 -> 700");
    const t2 = svc.createTransaction({ mobile: "9000000012", userId: "u12", packageId: pkg.id, method: "upi", utr: "UTR-LEDGER-2" });
    const a2 = svc.approveTransaction(t2.transaction.id, "admin_x");
    assert(a2.ledgerEntry.balanceBefore === 700 && a2.ledgerEntry.balanceAfter === 1200, "second ledger entry chains from the first: 700 -> 1200");
    const ledger = svc.getLedgerForUser("u12");
    assert(ledger.length === 2, "both ledger entries are retrievable for this user");
}

console.log("=== 13. Concurrent/duplicate approve calls on the same transaction never double-credit ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc, { priceINR: 100, coins: 1000, bonusCoins: 0 });
    addUser("9000000013", "u13", 0);
    const created = svc.createTransaction({ mobile: "9000000013", userId: "u13", packageId: pkg.id, method: "upi", utr: "UTR-RACE-1" });
    // Simulate several "simultaneous" callbacks/admin clicks hitting the
    // same transaction id back-to-back (Node's single-threaded event loop
    // makes this a fair stand-in for a race within one process).
    const results = [];
    for (let i = 0; i < 5; i++) results.push(svc.approveTransaction(created.transaction.id, "admin_" + i));
    const successCount = results.filter((r) => !r.error).length;
    assert(successCount === 1, "exactly one of five rapid approve calls actually credits coins; the rest are no-ops");
    assert(findUserByUserId("u13").user.coins === 1000, "final balance reflects only a single credit, not five");
}

console.log("=== 14. Package/settings admin surface enforces valid input (defense in depth for route-level validation) ===");
{
    const { svc } = makeHarness();
    const badPrice = svc.createPackage({ priceINR: -5, coins: 100 }, "admin_x");
    assert(badPrice.error === "invalid-price", "negative package price rejected");
    const badCoins = svc.createPackage({ priceINR: 10, coins: 0 }, "admin_x");
    assert(badCoins.error === "invalid-coins", "zero/invalid coin amount rejected");
    const badRange = svc.updateSettings({ minAmountINR: 100, maxAmountINR: 50 }, "admin_x");
    assert(badRange.error === "invalid-max", "max amount below min amount rejected");
}

console.log("=== 15. Recharge disabled by admin -> no new requests accepted, existing wallet untouched ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    // enabled defaults to false — do NOT call enablePayments()
    const pkg = makePackage(svc);
    addUser("9000000015", "u15", 40);
    const created = svc.createTransaction({ mobile: "9000000015", userId: "u15", packageId: pkg.id, method: "upi", utr: "UTR-DISABLED-1" });
    assert(created.error === "payment-disabled", "recharge is refused while the admin has it turned off");
    assert(findUserByUserId("u15").user.coins === 40, "existing balance is completely untouched");
}

console.log("=== 16. Inactive/deleted package can no longer be used for a new request ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    svc.updatePackage(pkg.id, { active: false }, "admin_x");
    addUser("9000000016", "u16", 0);
    const created = svc.createTransaction({ mobile: "9000000016", userId: "u16", packageId: pkg.id, method: "upi", utr: "UTR-INACTIVE-1" });
    assert(created.error === "invalid-package", "a deactivated package can't be used to start a new recharge");
}

// ========================================================================
// PHASE 5 — server-first order flow (createOrder / getOrderPaymentData /
// submitUtr). All additive: the tests above (createTransaction path) are
// untouched and still pass unmodified.
// ========================================================================

console.log("=== 17. Server-first order: PENDING order created before any UTR exists, with a server-issued orderId ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000017", "u17", 0);
    const order = svc.createOrder({ mobile: "9000000017", userId: "u17", packageId: pkg.id, method: "upi" });
    assert(!order.error, "order creation succeeds with no UTR supplied");
    assert(order.transaction.status === "PENDING", "a freshly created order starts PENDING");
    assert(order.transaction.utr === null, "no UTR exists yet on a freshly created order");
    assert(typeof order.transaction.id === "string" && order.transaction.id.length > 0, "server issues a real orderId");
}

console.log("=== 18. Coins remain unchanged while a server-first order is PENDING (before UTR submission) ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000018", "u18", 77);
    svc.createOrder({ mobile: "9000000018", userId: "u18", packageId: pkg.id, method: "upi" });
    assert(findUserByUserId("u18").user.coins === 77, "balance is completely untouched by order creation alone");
}

console.log("=== 19. UPI deep link / QR payment data for an order carries the order's exact amount and the server orderId as reference ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc, { priceINR: 250, coins: 2500, bonusCoins: 0 });
    addUser("9000000019", "u19", 0);
    const order = svc.createOrder({ mobile: "9000000019", userId: "u19", packageId: pkg.id, method: "phonepe" }).transaction;
    const data = await svc.getOrderPaymentData(order.id, "9000000019");
    assert(!data.error, "payment data resolves for the order's own creator");
    assert(data.upiLink && data.upiLink.startsWith("phonepe://pay?"), "deep link uses the phonepe:// scheme for the method chosen at order-creation time");
    assert(data.upiLink.includes("am=250"), "deep link amount matches the order's exact price, not anything client-suppliable");
    assert(data.upiLink.includes(`tr=${order.id}`), "deep link's transaction reference is the server orderId, not a client-generated string");
    assert(data.orderId === order.id, "returned orderId matches the order that was created");
    // qrDataUrl may be null in an environment where the optional 'qrcode'
    // package hasn't been installed yet (see rechargeService.js's
    // loadQrLib()) — that's a valid, safe degrade, not a failure. If it
    // IS present, it must be a real embeddable image.
    assert(data.qrDataUrl === null || (typeof data.qrDataUrl === "string" && data.qrDataUrl.startsWith("data:image/")), "dynamic QR is either a valid embeddable data URL, or explicitly null (safe fallback to the static admin QR)");
}

console.log("=== 20. Payment data cannot be fetched for someone else's order (ownership enforced) ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000020", "u20", 0);
    addUser("9000000021", "u21", 0);
    const order = svc.createOrder({ mobile: "9000000020", userId: "u20", packageId: pkg.id, method: "upi" }).transaction;
    const stolen = await svc.getOrderPaymentData(order.id, "9000000021");
    assert(stolen.error === "forbidden", "a different user's mobile cannot read another user's order payment data");
}

console.log("=== 21. Server-first flow: submitUtr moves PENDING -> PAYMENT_SUBMITTED, coins still unchanged ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000022", "u22", 15);
    const order = svc.createOrder({ mobile: "9000000022", userId: "u22", packageId: pkg.id, method: "upi" }).transaction;
    const submitted = svc.submitUtr({ mobile: "9000000022", id: order.id, utr: "UTR-SERVERFIRST-1" });
    assert(!submitted.error, "UTR submission on a valid PENDING order succeeds");
    assert(submitted.transaction.status === "PAYMENT_SUBMITTED", "order moves from PENDING to PAYMENT_SUBMITTED once UTR is attached");
    assert(submitted.transaction.utr === "UTR-SERVERFIRST-1", "the submitted UTR is recorded on the order");
    assert(findUserByUserId("u22").user.coins === 15, "coins are still unchanged — submitting a UTR never credits by itself");
}

console.log("=== 22. Full server-first happy path: PENDING -> PAYMENT_SUBMITTED -> admin approves -> PAID, coins credited exactly once ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc, { priceINR: 300, coins: 3000, bonusCoins: 300 });
    addUser("9000000023", "u23", 0);
    const order = svc.createOrder({ mobile: "9000000023", userId: "u23", packageId: pkg.id, method: "gpay" }).transaction;
    svc.submitUtr({ mobile: "9000000023", id: order.id, utr: "UTR-SERVERFIRST-HAPPY" });
    const approved = svc.approveTransaction(order.id, "admin_owner");
    assert(approved.transaction.status === "PAID", "admin approval marks the server-first order PAID");
    assert(findUserByUserId("u23").user.coins === 3300, "coins credited exactly once (3000+300)");
    // Re-approving (double-click / retried admin request) must still be a no-op.
    const secondApprove = svc.approveTransaction(order.id, "admin_owner");
    assert(secondApprove.error === "not-pending", "re-approving an already-PAID server-first order is rejected, not double-credited");
    assert(findUserByUserId("u23").user.coins === 3300, "balance is unchanged after the redundant approval attempt");
}

console.log("=== 23. Server-first order can be rejected by admin -> REJECTED, coins never credited ===");
{
    const { svc, addUser, findUserByUserId } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000024", "u24", 5);
    const order = svc.createOrder({ mobile: "9000000024", userId: "u24", packageId: pkg.id, method: "upi" }).transaction;
    svc.submitUtr({ mobile: "9000000024", id: order.id, utr: "UTR-SERVERFIRST-REJECT" });
    const rejected = svc.rejectTransaction(order.id, "admin_owner", "UTR not found in bank statement");
    assert(rejected.transaction.status === "REJECTED", "server-first order can be rejected after UTR submission");
    assert(findUserByUserId("u24").user.coins === 5, "rejected server-first order never credits coins");
}

console.log("=== 24. A server-first order can still be cancelled by its owner even after UTR submission (pre-terminal) ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000025", "u25", 0);
    const order = svc.createOrder({ mobile: "9000000025", userId: "u25", packageId: pkg.id, method: "upi" }).transaction;
    svc.submitUtr({ mobile: "9000000025", id: order.id, utr: "UTR-SERVERFIRST-CANCEL" });
    const cancelled = svc.cancelTransaction("9000000025", order.id);
    assert(cancelled.transaction.status === "CANCELLED", "a PAYMENT_SUBMITTED server-first order (not just plain PENDING) can still be cancelled by its owner");
}

console.log("=== 25. Duplicate UTR across the server-first flow is blocked at submission, same guarantee as the old flow ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000026", "u26", 0);
    const order1 = svc.createOrder({ mobile: "9000000026", userId: "u26", packageId: pkg.id, method: "upi" }).transaction;
    svc.submitUtr({ mobile: "9000000026", id: order1.id, utr: "UTR-SERVERFIRST-DUPE" });
    const order2 = svc.createOrder({ mobile: "9000000026", userId: "u26", packageId: pkg.id, method: "upi" }).transaction;
    const dupe = svc.submitUtr({ mobile: "9000000026", id: order2.id, utr: "UTR-SERVERFIRST-DUPE" });
    assert(dupe.error === "duplicate-utr", "the same UTR+method can't be attached to a second live server-first order");
}

console.log("=== 26. submitUtr enforces order ownership and PENDING-only state, same as the rest of the module ===");
{
    const { svc, addUser } = makeHarness();
    enablePayments(svc);
    const pkg = makePackage(svc);
    addUser("9000000027", "u27", 0);
    addUser("9000000028", "u28", 0);
    const order = svc.createOrder({ mobile: "9000000027", userId: "u27", packageId: pkg.id, method: "upi" }).transaction;
    const stolen = svc.submitUtr({ mobile: "9000000028", id: order.id, utr: "UTR-SERVERFIRST-STEAL" });
    assert(stolen.error === "forbidden", "a different user's mobile cannot submit a UTR against someone else's order");
    svc.submitUtr({ mobile: "9000000027", id: order.id, utr: "UTR-SERVERFIRST-ONCE" });
    const again = svc.submitUtr({ mobile: "9000000027", id: order.id, utr: "UTR-SERVERFIRST-AGAIN" });
    assert(again.error === "not-pending", "a UTR can't be submitted twice against the same order once it's already PAYMENT_SUBMITTED");
}

console.log("\n==================================================");
console.log(`rechargeService.test.js: ${pass} passed, ${fail} failed`);
console.log("==================================================");
if (fail > 0) process.exit(1);

})();
