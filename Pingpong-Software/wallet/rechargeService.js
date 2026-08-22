// ==================================================
// RECHARGE / PAYMENT -> COIN SYSTEM (2026-08-16)
// ==================================================
// Additive, self-contained module — same initX({deps}) dependency-
// injection pattern as svip.js / otpService.js / rechargeWithdrawApproval.js.
// Does NOT touch or replace the existing admin-initiated Recharge/Withdraw
// approval workflow in rechargeWithdrawApproval.js (that stays exactly as
// it was, for the case an Admin manually credits a user off-platform).
// This module is the separate USER-INITIATED flow: a user picks a
// package, pays an Owner-configured UPI ID themselves, submits the
// UTR/reference they got from their own UPI app, and an Admin verifies
// and approves it from the Admin Panel.
//
// WHY THIS IS A MANUAL/ADMIN-APPROVAL FLOW, NOT AN AUTOMATIC ONE:
// No PhonePe/Google Pay/UPI *merchant API* credentials exist anywhere in
// this project's env/config — only a personal UPI ID the Owner configures
// to receive payments into their own bank account. There is no
// PSP webhook, no signature to verify, no way for this server to ever
// confirm a payment happened on its own. Any code path that marked a
// transaction "PAID" without a human checking the actual bank/UPI app
// would be exactly the "fake payment success" the spec explicitly
// forbids. So: PhonePe / Google Pay / UPI in the UI are three *deep-link
// options for paying the same configured UPI ID* — not three separate
// payment gateway integrations — and every transaction starts and stays
// PENDING until an Admin with payment:approve looks at the real UTR and
// approves or rejects it. See docs/PAYMENT_RECHARGE_SYSTEM.md.
//
// Security properties:
//   - Coins are only ever credited from approveTransaction() below — no
//     other code path in this module touches user.coins.
//   - Idempotent: approveTransaction()/rejectTransaction() both guard on
//     `status === "PENDING"` before doing anything. A transaction that is
//     already PAID/REJECTED/CANCELLED is a no-op on a second call — so a
//     double-click, a retried admin request, or two admins racing on the
//     same record can never credit coins twice. The PENDING check and the
//     status write happen synchronously in the same tick (Node is
//     single-threaded per event-loop turn; there is no `await` between
//     the guard and the write), so two "simultaneous" calls in the same
//     process can't interleave between them either.
//   - Every credit is written to an append-only coin ledger with
//     userId, txnId, amount, balanceBefore, balanceAfter, timestamp,
//     source, and the deciding adminId — independent of the transaction
//     record itself, so the ledger can be reconciled against it.
//   - Package price/coins/bonus and all payment settings (UPI ID, enabled
//     methods, min/max amount, instructions) are Admin-Panel-only,
//     enforced by requirePermission("payment:manage") at the route level
//     in server.js — this module itself has no knowledge of HTTP/auth,
//     it only exposes plain functions the routes call.
//   - Every state-changing admin function takes an explicit adminId
//     parameter that server.js fills from req.adminAccount (never from
//     the request body), so the audit trail (decidedBy on the
//     transaction, adminId on the ledger entry) can't be spoofed by the
//     client.

const crypto = require("crypto");
const path = require("path");

function initRechargeService({ DATA_FOLDER, safeRead, safeWrite, findUserByUserId, saveUsers, logTransaction, pushWalletUpdate, clampCoinBalance } = {}) {
    if (!DATA_FOLDER || !safeRead || !safeWrite || !findUserByUserId || !saveUsers) {
        throw new Error("initRechargeService requires { DATA_FOLDER, safeRead, safeWrite, findUserByUserId, saveUsers, ... }");
    }
    const _logTransaction = typeof logTransaction === "function" ? logTransaction : () => {};
    const _pushWalletUpdate = typeof pushWalletUpdate === "function" ? pushWalletUpdate : () => {};
    const _clampCoinBalance = typeof clampCoinBalance === "function"
        ? clampCoinBalance
        : (userId, coins) => (Number.isFinite(coins) && coins >= 0 ? Math.floor(coins) : 0);

    const SETTINGS_FILE = path.join(DATA_FOLDER, "paymentSettings.json");
    const PACKAGES_FILE = path.join(DATA_FOLDER, "rechargePackages.json");
    const TXN_FILE = path.join(DATA_FOLDER, "rechargeTransactions.json");
    const LEDGER_FILE = path.join(DATA_FOLDER, "coinLedger.json");

    const METHODS = ["upi", "phonepe", "gpay"];
    const TERMINAL_STATUSES = ["PAID", "FAILED", "CANCELLED", "REJECTED", "REFUNDED"];

    function defaultSettings() {
        return {
            enabled: true,
            upiId: "labib3@axl",
            receiverName: "PingPong",
            qrImageUrl: "",
            methods: { upi: true, phonepe: true, gpay: true },
            minAmountINR: 10,
            maxAmountINR: 10000,
            instructions: "",
            updatedAt: null,
            updatedBy: null
        };
    }

    let settings = Object.assign(defaultSettings(), safeRead(SETTINGS_FILE, {}));
// Final payment destination configured by the owner. If an older settings file
// has no UPI destination, initialize it so the real PhonePe/UPI deep link works.
if (!settings.upiId) settings.upiId = "labib3@axl";
if (!settings.receiverName) settings.receiverName = "PingPong";
if (settings.upiId === "labib3@axl") settings.enabled = true;
let packages = safeRead(PACKAGES_FILE, []);
    let transactions = safeRead(TXN_FILE, []);
    let ledger = safeRead(LEDGER_FILE, []);

    function persistSettings() { safeWrite(SETTINGS_FILE, settings, { immediate: true }); }
    function persistPackages() { safeWrite(PACKAGES_FILE, packages, { immediate: true }); }
    function persistTxns(opts) { safeWrite(TXN_FILE, transactions, opts || { immediate: false }); }
    function persistLedger() { safeWrite(LEDGER_FILE, ledger, { immediate: true }); }

    function genId(prefix) {
        return prefix + "_" + Date.now().toString(36) + "_" + crypto.randomBytes(5).toString("hex");
    }

    // ================= Admin: payment settings =================
    function getSettings() { return { ...settings }; }

    // Only the subset a logged-in USER is allowed to see (no internal
    // audit fields like updatedBy).
    function getPublicSettings() {
        return {
            enabled: settings.enabled,
            upiId: settings.upiId,
            receiverName: settings.receiverName,
            qrImageUrl: settings.qrImageUrl,
            methods: { ...settings.methods },
            minAmountINR: settings.minAmountINR,
            maxAmountINR: settings.maxAmountINR,
            instructions: settings.instructions
        };
    }

    function updateSettings(patch, adminId) {
        if (!patch || typeof patch !== "object") return { error: "invalid-body", message: "Invalid settings payload" };
        const before = { ...settings };
        if (typeof patch.enabled === "boolean") settings.enabled = patch.enabled;
        if (typeof patch.upiId === "string") settings.upiId = patch.upiId.trim().slice(0, 100);
        if (typeof patch.receiverName === "string") settings.receiverName = patch.receiverName.trim().slice(0, 100);
        if (typeof patch.qrImageUrl === "string") settings.qrImageUrl = patch.qrImageUrl.trim().slice(0, 500);
        if (patch.methods && typeof patch.methods === "object") {
            settings.methods = {
                upi: !!patch.methods.upi,
                phonepe: !!patch.methods.phonepe,
                gpay: !!patch.methods.gpay
            };
        }
        if (patch.minAmountINR !== undefined) {
            const v = Number(patch.minAmountINR);
            if (!Number.isFinite(v) || v <= 0) return { error: "invalid-min", message: "Invalid minimum amount" };
            settings.minAmountINR = Math.floor(v);
        }
        if (patch.maxAmountINR !== undefined) {
            const v = Number(patch.maxAmountINR);
            if (!Number.isFinite(v) || v < settings.minAmountINR) return { error: "invalid-max", message: "Maximum amount must be >= minimum amount" };
            settings.maxAmountINR = Math.floor(v);
        }
        if (typeof patch.instructions === "string") settings.instructions = patch.instructions.slice(0, 2000);
        settings.updatedAt = new Date().toISOString();
        settings.updatedBy = adminId || null;
        persistSettings();
        return { before, after: { ...settings } };
    }

    // ================= Admin: recharge packages =================
    function listPackagesAdmin() {
        return [...packages].sort((a, b) => a.order - b.order);
    }

    // What the logged-in user's Wallet -> Recharge screen actually sees:
    // active packages only, no admin-only fields.
    function listPackagesPublic() {
        return packages
            .filter((p) => p.active)
            .sort((a, b) => a.order - b.order)
            .map((p) => ({
                id: p.id,
                priceINR: p.priceINR,
                coins: p.coins,
                bonusCoins: p.bonusCoins || 0,
                totalCoins: p.coins + (p.bonusCoins || 0),
                label: p.label || null
            }));
    }

    function createPackage(body, adminId) {
        const priceINR = Number(body && body.priceINR);
        const coins = Number(body && body.coins);
        const bonusCoins = Number(body && body.bonusCoins) || 0;
        if (!Number.isFinite(priceINR) || priceINR <= 0) return { error: "invalid-price", message: "Provide a valid price (INR)" };
        if (!Number.isFinite(coins) || coins <= 0) return { error: "invalid-coins", message: "Provide a valid coin amount" };
        const pkg = {
            id: genId("pkg"),
            priceINR,
            coins: Math.floor(coins),
            bonusCoins: Math.max(0, Math.floor(bonusCoins)),
            label: ((body && body.label) || "").trim().slice(0, 60) || null,
            active: !body || body.active !== false,
            order: Number.isFinite(Number(body && body.order)) ? Number(body.order) : packages.length,
            createdAt: new Date().toISOString(),
            createdBy: adminId || null
        };
        packages.push(pkg);
        persistPackages();
        return { package: pkg };
    }

    function updatePackage(id, patch, adminId) {
        const pkg = packages.find((p) => p.id === id);
        if (!pkg) return { error: "not-found", message: "Package not found" };
        if (patch.priceINR !== undefined) {
            const v = Number(patch.priceINR);
            if (!Number.isFinite(v) || v <= 0) return { error: "invalid-price", message: "Provide a valid price (INR)" };
            pkg.priceINR = v;
        }
        if (patch.coins !== undefined) {
            const v = Number(patch.coins);
            if (!Number.isFinite(v) || v <= 0) return { error: "invalid-coins", message: "Provide a valid coin amount" };
            pkg.coins = Math.floor(v);
        }
        if (patch.bonusCoins !== undefined) {
            const v = Number(patch.bonusCoins);
            pkg.bonusCoins = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
        }
        if (patch.label !== undefined) pkg.label = String(patch.label).trim().slice(0, 60) || null;
        if (patch.active !== undefined) pkg.active = !!patch.active;
        if (patch.order !== undefined && Number.isFinite(Number(patch.order))) pkg.order = Number(patch.order);
        pkg.updatedAt = new Date().toISOString();
        pkg.updatedBy = adminId || null;
        persistPackages();
        return { package: pkg };
    }

    function deletePackage(id) {
        const idx = packages.findIndex((p) => p.id === id);
        if (idx === -1) return { error: "not-found", message: "Package not found" };
        const [removed] = packages.splice(idx, 1);
        persistPackages();
        return { package: removed };
    }

    function reorderPackages(orderedIds) {
        if (!Array.isArray(orderedIds)) return { error: "invalid-body" };
        orderedIds.forEach((id, i) => {
            const pkg = packages.find((p) => p.id === id);
            if (pkg) pkg.order = i;
        });
        persistPackages();
        return { packages: listPackagesAdmin() };
    }

    // ================= User: create a recharge request =================
    // Never credits coins itself — always lands as PENDING. The client
    // must never be told "payment verified" from this function's result.
    function createTransaction({ mobile, userId, packageId, method, utr }) {
        if (!settings.enabled) return { error: "payment-disabled", message: "Recharge is temporarily unavailable" };
        if (!mobile || !userId) return { error: "unauthenticated", message: "Login required" };
        const pkg = packages.find((p) => p.id === packageId && p.active);
        if (!pkg) return { error: "invalid-package", message: "Selected package is not available" };
        if (pkg.priceINR < settings.minAmountINR || pkg.priceINR > settings.maxAmountINR) {
            return { error: "amount-out-of-range", message: "This package is outside the currently allowed recharge range" };
        }
        if (!METHODS.includes(method) || !settings.methods[method]) {
            return { error: "invalid-method", message: "Selected payment method is not available" };
        }
        const cleanUtr = String(utr || "").trim();
        if (cleanUtr.length < 4 || cleanUtr.length > 64) {
            return { error: "invalid-utr", message: "Enter a valid Transaction ID / UTR (4-64 characters)" };
        }
        // Block resubmitting the exact same UTR+method while a prior
        // submission of it is still live (PENDING or already PAID) — this
        // is a submission-time guard on top of the approval-time
        // idempotency guard in approveTransaction(), not a replacement
        // for it: this stops an honest duplicate double-submit from even
        // reaching an admin queue twice; the approval-time guard is what
        // actually makes double-crediting impossible.
        const dupe = transactions.find((t) => t.utr === cleanUtr && t.method === method && (t.status === "PENDING" || t.status === "PAID"));
        if (dupe) return { error: "duplicate-utr", message: "This Transaction ID has already been submitted", existingId: dupe.id };

        const totalCoins = pkg.coins + (pkg.bonusCoins || 0);
        const txn = {
            id: genId("rcg"),
            userId, mobile,
            packageId: pkg.id, priceINR: pkg.priceINR, coins: pkg.coins, bonusCoins: pkg.bonusCoins || 0, totalCoins,
            method, utr: cleanUtr,
            status: "PENDING",
            createdAt: new Date().toISOString(),
            decidedAt: null, decidedBy: null, reason: null
        };
        transactions.push(txn);
        persistTxns({ immediate: true });
        return { transaction: txn };
    }

    // User may cancel their own still-pending request (e.g. they backed
    // out of the payment app without paying).
    function cancelTransaction(mobile, id) {
        const txn = transactions.find((t) => t.id === id);
        if (!txn) return { error: "not-found" };
        if (txn.mobile !== mobile) return { error: "forbidden" };
        // PHASE 5 FIX: a server-first order can also be sitting in
        // PAYMENT_SUBMITTED (UTR already sent, awaiting admin) — that must
        // remain cancellable too, same as plain PENDING. Only a terminal
        // status (already PAID/REJECTED/etc.) can no longer be cancelled.
        if (TERMINAL_STATUSES.includes(txn.status)) return { error: "not-pending", message: `Transaction is already ${txn.status}` };
        txn.status = "CANCELLED";
        txn.decidedAt = new Date().toISOString();
        persistTxns({ immediate: true });
        return { transaction: txn };
    }

    // ================= PHASE 5 — server-first order flow =================
    // ==================================================
    // Added 2026-08-16 per the master fix spec, item §15 ("Payment order
    // must be server controlled") and item §14 ("dynamic per-order QR").
    // This is purely ADDITIVE — createTransaction()/cancelTransaction()
    // above are completely untouched (beyond cancelTransaction's terminal-
    // status check above, which only WIDENS what it accepts, it never
    // narrows). Existing callers/tests of createTransaction() keep working
    // exactly as before.
    //
    // Required flow (spec-mandated order):
    //   createOrder()        -> PENDING order, server-issued id, no UTR yet
    //   getOrderPaymentData()-> UPI deep link + dynamic QR for THAT order,
    //                           computed fresh from current settings each
    //                           call (never cached/stale) — id/amount are
    //                           baked into the deep link itself, so a payer
    //                           can never end up paying to the wrong amount
    //                           or losing the reference.
    //   submitUtr()           -> PENDING -> PAYMENT_SUBMITTED once the user
    //                           reports what they actually paid with
    //   approveTransaction()  -> PAYMENT_SUBMITTED -> PAID, coins credited
    //                           exactly once (unchanged — same idempotency
    //                           guard as before, PAYMENT_SUBMITTED is just
    //                           another non-terminal status to it)
    //   rejectTransaction()   -> PAYMENT_SUBMITTED -> REJECTED (unchanged)
    //
    // Coins are still ONLY ever credited inside approveTransaction() — this
    // section adds zero new coin-crediting code paths.

    // Step 1: create the PENDING order BEFORE any UPI app is opened. The
    // returned txn.id is the one and only authoritative payment reference
    // from this point forward — it is what gets embedded in the UPI deep
    // link's `tr` field and in the QR, and it is what the user must quote
    // if they contact support. No client-generated reference is ever
    // trusted for anything that touches money.
    function createOrder({ mobile, userId, packageId, method }) {
        if (!settings.enabled) return { error: "payment-disabled", message: "Recharge is temporarily unavailable" };
        if (!mobile || !userId) return { error: "unauthenticated", message: "Login required" };
        const pkg = packages.find((p) => p.id === packageId && p.active);
        if (!pkg) return { error: "invalid-package", message: "Selected package is not available" };
        if (pkg.priceINR < settings.minAmountINR || pkg.priceINR > settings.maxAmountINR) {
            return { error: "amount-out-of-range", message: "This package is outside the currently allowed recharge range" };
        }
        if (!METHODS.includes(method) || !settings.methods[method]) {
            return { error: "invalid-method", message: "Selected payment method is not available" };
        }
        if (!settings.upiId) return { error: "upi-not-configured", message: "Payment is not configured yet — contact support" };

        const totalCoins = pkg.coins + (pkg.bonusCoins || 0);
        const txn = {
            id: genId("rcg"),
            userId, mobile,
            packageId: pkg.id, priceINR: pkg.priceINR, coins: pkg.coins, bonusCoins: pkg.bonusCoins || 0, totalCoins,
            method, utr: null,
            status: "PENDING", // PENDING (no UTR yet) -> PAYMENT_SUBMITTED (UTR in) -> PAID/REJECTED
            createdAt: new Date().toISOString(),
            utrSubmittedAt: null,
            decidedAt: null, decidedBy: null, reason: null
        };
        transactions.push(txn);
        persistTxns({ immediate: true });
        return { transaction: txn };
    }

    // Builds the UPI deep link for a given (already-created) order. Same
    // upi://pay / phonepe://pay / tez://upi/pay shapes the client used to
    // build itself — moved server-side so the amount/reference embedded in
    // it always comes from the authoritative order record, never from
    // anything the client could have tampered with in transit.
    function buildOrderUpiLink(txn, method) {
        if (!settings.upiId || !txn) return null;
        const params = new URLSearchParams({
            pa: settings.upiId,
            pn: settings.receiverName || "PingPong",
            am: String(txn.priceINR),
            cu: "INR",
            tn: `PingPong Recharge - ${txn.totalCoins} Coins`,
            tr: txn.id // server order id — the ONE authoritative reference
        }).toString();
        const m = method || txn.method;
        if (m === "phonepe") return `phonepe://pay?${params}`;
        if (m === "paytm") return `paytmmp://pay?${params}`;
        if (m === "gpay") return `tez://upi/pay?${params}`;
        return `upi://pay?${params}`;
    }

    // Lazy/optional dependency: the 'qrcode' npm package (added to
    // package.json's dependencies — installed via the project's normal
    // `npm install`, never fetched from a CDN into the payment page itself,
    // per the spec's explicit "do not load an untrusted external script
    // directly from the payment page" requirement). If the environment
    // hasn't run `npm install` yet, this degrades to qrDataUrl: null and
    // the client falls back to the admin-uploaded static QR image — never
    // a hard failure of the recharge flow.
    let qrLib, qrLibLoadAttempted = false;
    function loadQrLib() {
        if (qrLibLoadAttempted) return qrLib;
        qrLibLoadAttempted = true;
        try { qrLib = require("qrcode"); } catch (e) {
            console.warn("[rechargeService] 'qrcode' package not installed — dynamic per-order QR disabled, admin-configured static QR image will be used instead. Run `npm install` to enable dynamic QR.");
            qrLib = null;
        }
        return qrLib;
    }

    // Step 2: everything the payment screen needs for THIS order, computed
    // fresh every call (never cached) so it always reflects current
    // settings and can never go stale mid-flow. Ownership-checked so one
    // user can never pull another user's order's payment data.
    async function getOrderPaymentData(id, mobile) {
        const txn = transactions.find((t) => t.id === id);
        if (!txn) return { error: "not-found", message: "Order not found" };
        if (txn.mobile !== mobile) return { error: "forbidden", message: "This order does not belong to you" };
        if (TERMINAL_STATUSES.includes(txn.status)) return { error: "not-pending", message: `Order is already ${txn.status}` };

        const upiLink = buildOrderUpiLink(txn, txn.method);
        let qrDataUrl = null;
        const lib = loadQrLib();
        if (lib && upiLink) {
            try {
                qrDataUrl = await lib.toDataURL(upiLink, { margin: 1, width: 320 });
            } catch (e) {
                console.warn("[rechargeService] dynamic QR generation failed for order", txn.id, e && e.message);
                qrDataUrl = null; // falls back to static QR client-side, never a hard error
            }
        }
        return {
            orderId: txn.id,
            upiLink,
            qrDataUrl, // data:image/png;base64,... or null (client falls back to settings.qrImageUrl)
            upiId: settings.upiId,
            receiverName: settings.receiverName,
            amountINR: txn.priceINR,
            totalCoins: txn.totalCoins,
            method: txn.method,
            status: txn.status
        };
    }

    // Step 3: the user reports what they actually paid with. This is the
    // ONLY place a UTR gets attached to a server-first order, and it never
    // credits coins itself — it only moves PENDING -> PAYMENT_SUBMITTED so
    // the order shows up in the admin approval queue. Coins still only
    // ever come from approveTransaction().
    function submitUtr({ mobile, id, utr }) {
        const txn = transactions.find((t) => t.id === id);
        if (!txn) return { error: "not-found", message: "Order not found" };
        if (txn.mobile !== mobile) return { error: "forbidden", message: "This order does not belong to you" };
        if (txn.status !== "PENDING") return { error: "not-pending", message: `Order is already ${txn.status}`, transaction: txn };
        const cleanUtr = String(utr || "").trim();
        if (cleanUtr.length < 4 || cleanUtr.length > 64) {
            return { error: "invalid-utr", message: "Enter a valid Transaction ID / UTR (4-64 characters)" };
        }
        // Same duplicate-UTR guard as createTransaction(), extended to
        // cover PAYMENT_SUBMITTED (the server-first flow's equivalent of
        // that path's PENDING) alongside PAID.
        const dupe = transactions.find((t) => t.id !== txn.id && t.utr === cleanUtr && t.method === txn.method && (t.status === "PAYMENT_SUBMITTED" || t.status === "PENDING" || t.status === "PAID"));
        if (dupe) return { error: "duplicate-utr", message: "This Transaction ID has already been submitted", existingId: dupe.id };
        txn.utr = cleanUtr;
        txn.status = "PAYMENT_SUBMITTED";
        txn.utrSubmittedAt = new Date().toISOString();
        persistTxns({ immediate: true });
        return { transaction: txn };
    }

    // ================= Admin: approve / reject (idempotent) =================
    function approveTransaction(id, adminId) {
        const txn = transactions.find((t) => t.id === id);
        if (!txn) return { error: "not-found", message: "Transaction not found" };
        // IDEMPOTENCY GUARD — the entire point of this module's safety
        // story. Only a PENDING transaction can ever be approved. Once
        // this check passes, the status is flipped to PAID and persisted
        // BEFORE the coin credit happens, so even a hard crash between
        // these two lines can only ever leave a PAID txn with no matching
        // ledger entry (a visible, reconcilable gap — safe to re-credit
        // manually after checking the ledger) rather than a PENDING txn
        // that could be approved again for a second credit.
        if (TERMINAL_STATUSES.includes(txn.status)) {
            return { error: "not-pending", message: `Transaction is already ${txn.status}`, transaction: txn };
        }
        const found = findUserByUserId(txn.userId);
        if (!found) return { error: "user-not-found", message: "User no longer exists" };

        txn.status = "PAID";
        txn.decidedAt = new Date().toISOString();
        txn.decidedBy = adminId || null;
        persistTxns({ immediate: true });

        const balanceBefore = found.user.coins || 0;
        const balanceAfter = _clampCoinBalance(txn.userId, balanceBefore + txn.totalCoins, "recharge-approve");
        found.user.coins = balanceAfter;
        saveUsers({ immediate: true });

        const ledgerEntry = {
            id: genId("ldg"),
            userId: txn.userId, mobile: txn.mobile,
            txnId: txn.id, amountCoins: txn.totalCoins,
            balanceBefore, balanceAfter,
            source: "recharge",
            timestamp: new Date().toISOString(),
            adminId: adminId || null
        };
        ledger.push(ledgerEntry);
        persistLedger();

        _logTransaction(txn.userId, "coins", txn.totalCoins, `Recharge approved (${txn.id}, ₹${txn.priceINR} via ${txn.method}, UTR ${txn.utr})`);
        _pushWalletUpdate(txn.userId);

        return { transaction: txn, ledgerEntry };
    }

    function rejectTransaction(id, adminId, reason) {
        const txn = transactions.find((t) => t.id === id);
        if (!txn) return { error: "not-found", message: "Transaction not found" };
        if (TERMINAL_STATUSES.includes(txn.status)) {
            return { error: "not-pending", message: `Transaction is already ${txn.status}`, transaction: txn };
        }
        txn.status = "REJECTED";
        txn.decidedAt = new Date().toISOString();
        txn.decidedBy = adminId || null;
        txn.reason = (reason || "").trim().slice(0, 300) || null;
        persistTxns({ immediate: true });
        return { transaction: txn };
    }

    // ================= Listing =================
    function listTransactionsAdmin(filters = {}) {
        let list = [...transactions];
        if (filters.status) list = list.filter((t) => t.status === filters.status);
        if (filters.method) list = list.filter((t) => t.method === filters.method);
        if (filters.userId) list = list.filter((t) => t.userId === filters.userId);
        if (filters.mobile) list = list.filter((t) => t.mobile === filters.mobile);
        if (filters.q) {
            const q = String(filters.q).toLowerCase();
            list = list.filter((t) =>
                (t.utr || "").toLowerCase().includes(q) ||
                (t.id || "").toLowerCase().includes(q) ||
                (t.userId || "").toLowerCase().includes(q)
            );
        }
        if (filters.minAmount !== undefined) list = list.filter((t) => t.priceINR >= Number(filters.minAmount));
        if (filters.maxAmount !== undefined) list = list.filter((t) => t.priceINR <= Number(filters.maxAmount));
        if (filters.fromDate) list = list.filter((t) => new Date(t.createdAt) >= new Date(filters.fromDate));
        if (filters.toDate) list = list.filter((t) => new Date(t.createdAt) <= new Date(filters.toDate));
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const page = Math.max(1, parseInt(filters.page, 10) || 1);
        const pageSize = Math.min(100, Math.max(1, parseInt(filters.pageSize, 10) || 20));
        const total = list.length;
        const start = (page - 1) * pageSize;
        return { items: list.slice(start, start + pageSize), total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
    }

    function getUserHistory(mobile) {
        return transactions
            .filter((t) => t.mobile === mobile)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    function getLedgerForUser(userId) {
        return ledger.filter((l) => l.userId === userId).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }

    return {
        getSettings, getPublicSettings, updateSettings,
        listPackagesAdmin, listPackagesPublic, createPackage, updatePackage, deletePackage, reorderPackages,
        createTransaction, cancelTransaction, approveTransaction, rejectTransaction,
        createOrder, getOrderPaymentData, submitUtr,
        listTransactionsAdmin, getUserHistory, getLedgerForUser,
        METHODS
    };
}

module.exports = { initRechargeService };
