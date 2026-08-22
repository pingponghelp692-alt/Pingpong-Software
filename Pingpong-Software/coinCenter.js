// ==================================================
// Admin Coin Center — Backend Core (additive module)
// ==================================================
// Self-contained, like svip.js — does not modify any existing wallet/gift
// logic. server.js wires this in by calling initCoinCenter({...}) once and
// exposing a few new /api/admin/coin-center/* routes.
//
// Covers the spec:
//   - System coin balance (a virtual pool admins draw from)
//   - Send coins directly to a user, with reason/note
//   - Every transfer logged (own audit log + reuses existing logTransaction
//     so it also shows up in the user's normal wallet history)
//   - User's transaction history shows "Coin Center", never an admin name
//   - Real-time wallet push (reuses existing pushWalletUpdate) + a
//     dedicated real-time notification event
//   - Validation: amount must be a positive integer; rejects if system
//     balance is insufficient
//   - Idempotency: a request with a requestId that was already processed
//     returns the original result instead of crediting twice

const path = require("path");

function initCoinCenter({ DATA_FOLDER, safeRead, safeWrite, io, socketsByUserId, emitToUser: crossInstanceEmitToUser, findUserByUserId, saveUsers, users, logTransaction, pushWalletUpdate, levelFromCoins, clampCoinBalance, normalizeMobile }) {
    // AUDIT FIX (Phase 13, wallet/economy audit, 2026-07-28): every coin
    // credit in this module now runs through the same ceiling/overflow
    // guard server.js applies everywhere else (admin edit, game rewards,
    // treasure rewards). Falls back to a local equivalent if this module is
    // ever wired up without the dependency, so it can never silently no-op.
    const clampCoins = typeof clampCoinBalance === "function" ? clampCoinBalance : (userId, coins) => {
        if (!Number.isFinite(coins) || coins < 0) return 0;
        return Math.min(Math.floor(coins), 100000000000);
    };
    const STATE_FILE = path.join(DATA_FOLDER, "coin_center.json");

    const DEFAULT_STATE = {
        systemBalance: 100000000, // placeholder starting pool — adjust via setSystemBalance()
        log: [], // audit log of every send + balance-set admin action
        processedRequests: {}, // requestId -> { result, time }  (idempotency cache)
        // Agency-style "Coin Center" operator accounts: Admin picks any
        // existing User ID and turns it into a Coin Center. That user can
        // then, from their own app panel, send coins to specific users out
        // of their own allocated balance (topped up by Admin out of the
        // system pool above). Only Admin Panel can create/remove/
        // enable/disable these — never self-service.
        accounts: {} // userId -> { userId, name, balance, enabled, createdAt, createdBy, log: [] }
    };

    let state = safeRead(STATE_FILE, DEFAULT_STATE);
    if (typeof state.systemBalance !== "number") state.systemBalance = DEFAULT_STATE.systemBalance;
    if (!Array.isArray(state.log)) state.log = [];
    if (!state.processedRequests || typeof state.processedRequests !== "object") state.processedRequests = {};
    if (!state.accounts || typeof state.accounts !== "object") state.accounts = {};
    // Backfill in case of an older state file / mid-flight schema upgrade.
    Object.values(state.accounts).forEach((a) => {
        if (typeof a.balance !== "number") a.balance = 0;
        if (typeof a.enabled !== "boolean") a.enabled = true;
        if (!Array.isArray(a.log)) a.log = [];
    });
    safeWrite(STATE_FILE, state);

    function save() {
        // Idempotency cache doesn't need to grow forever — keep the most
        // recent 2000 entries, which is far more than enough for retry
        // windows in practice.
        const entries = Object.entries(state.processedRequests);
        if (entries.length > 2000) {
            entries.sort((a, b) => new Date(a[1].time) - new Date(b[1].time));
            state.processedRequests = Object.fromEntries(entries.slice(entries.length - 2000));
        }
        if (state.log.length > 10000) state.log = state.log.slice(-10000);
        safeWrite(STATE_FILE, state);
    }

    function getSystemBalance() { return state.systemBalance; }

    function setSystemBalance(amount, adminUsername) {
        const n = Number(amount);
        if (!Number.isFinite(n) || n < 0) return { success: false, message: "Provide a valid amount" };
        const prev = state.systemBalance;
        state.systemBalance = Math.floor(n);
        state.log.push({ type: "balance_set", adminUsername, prevBalance: prev, newBalance: state.systemBalance, time: new Date().toISOString() });
        save();
        return { success: true, systemBalance: state.systemBalance };
    }

    function findUserByIdOrMobile(query) {
        if (!query) return null;
        const byId = findUserByUserId(String(query).trim());
        if (byId) return byId;
        const mobile = String(query).trim();
        if (users[mobile]) return { mobile, user: users[mobile] };
        // Fallback: an admin may type the number with spaces/dashes/+91
        // etc. — resolve it the same way every other lookup in the app
        // does, instead of only matching an exact canonical-key string.
        // Never applied to "google:" keys (normalizeMobile would mangle
        // those, and this fallback only fires when the exact-key check
        // above already missed, which google keys never rely on here).
        if (typeof normalizeMobile === "function" && !mobile.startsWith("google:")) {
            const canonical = normalizeMobile(mobile);
            if (canonical && users[canonical]) return { mobile: canonical, user: users[canonical] };
        }
        return null;
    }

    // GAP #1 — delegates to server.js's cross-instance-safe emitToUser()
    // when injected, falling back to the old local-socket path otherwise
    // (e.g. a test that doesn't supply it).
    function emitToUser(userId, event, payload) {
        if (typeof crossInstanceEmitToUser === "function") { crossInstanceEmitToUser(userId, event, payload); return; }
        const sid = socketsByUserId[userId];
        if (sid) io.to(sid).emit(event, payload);
    }

    // Core action: send `amount` coins from the system pool to targetUserId.
    function sendCoins({ targetUserId, amount, reason, adminUsername, requestId }) {
        // ---- Idempotency: replay a previously-processed request instead of
        // crediting twice (covers double-clicks / retried network calls
        // that resend the same requestId). ----
        if (requestId && state.processedRequests[requestId]) {
            return Object.assign({}, state.processedRequests[requestId].result, { replayed: true });
        }

        const n = Number(amount);
        if (!Number.isInteger(n) || n <= 0) {
            const result = { success: false, message: "Provide a valid amount (positive integer)" };
            if (requestId) { state.processedRequests[requestId] = { result, time: new Date().toISOString() }; save(); }
            return result;
        }

        const found = findUserByUserId(targetUserId);
        if (!found) {
            const result = { success: false, message: "User not found" };
            if (requestId) { state.processedRequests[requestId] = { result, time: new Date().toISOString() }; save(); }
            return result;
        }

        if (state.systemBalance < n) {
            const result = { success: false, message: "Insufficient System balance" };
            if (requestId) { state.processedRequests[requestId] = { result, time: new Date().toISOString() }; save(); }
            return result;
        }

        // ---- Apply the credit ----
        found.user.coins = clampCoins(found.user.userId, (found.user.coins || 0) + n, "coin-center");
        // LEVEL SYSTEM UPGRADE 2026-08-04: removed — Coin Center credits no longer bump user.level (level now only changes via a room gift SEND, see idLevel.js).
        state.systemBalance -= n;
        saveUsers();

        const cleanReason = (reason || "").toString().trim().slice(0, 200);
        // Reuses the existing wallet-transactions mechanism so this shows up
        // in the user's normal transaction history exactly like any other
        // entry — with the source shown as "Coin Center", never the admin's
        // own name/username.
        logTransaction(targetUserId, "coins", n, cleanReason ? `Coin Center: ${cleanReason}` : "Coin Center");

        const entry = {
            id: "cc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
            requestId: requestId || null,
            targetUserId,
            targetName: found.user.name,
            amount: n,
            reason: cleanReason,
            adminUsername: adminUsername || "admin",
            systemBalanceAfter: state.systemBalance,
            time: new Date().toISOString()
        };
        state.log.push(entry);

        const result = { success: true, coins: found.user.coins, systemBalance: state.systemBalance, entry };
        if (requestId) state.processedRequests[requestId] = { result, time: new Date().toISOString() };
        save();

        // ---- Real-time push: balance (reuses the app's existing wallet-
        // update mechanism) + a dedicated Coin Center notification. ----
        if (typeof pushWalletUpdate === "function") pushWalletUpdate(targetUserId);
        emitToUser(targetUserId, "coin-center-notification", {
            amount: n,
            reason: cleanReason || null,
            time: entry.time,
            newBalance: found.user.coins
        });

        return result;
    }

    // Same as sendCoins, but for several recipients at once (admin selects
    // multiple users, one amount + one reason, one click). Reuses sendCoins
    // per-recipient — so every existing guarantee (system balance check,
    // audit log entry, "Coin Center" wallet history label, real-time push)
    // applies to each recipient exactly the same as a single send. The
    // requestId here is a BULK-level key: replaying it returns the original
    // combined result instead of re-crediting everyone a second time.
    function sendCoinsBulk({ targetUserIds, amount, reason, adminUsername, requestId }) {
        if (requestId && state.processedRequests[requestId]) {
            return Object.assign({}, state.processedRequests[requestId].result, { replayed: true });
        }
        const ids = Array.isArray(targetUserIds) ? [...new Set(targetUserIds.filter(Boolean))] : [];
        if (!ids.length) {
            const result = { success: false, message: "Select at least one user" };
            if (requestId) { state.processedRequests[requestId] = { result, time: new Date().toISOString() }; save(); }
            return result;
        }

        const results = ids.map((targetUserId) => ({ targetUserId, ...sendCoins({ targetUserId, amount, reason, adminUsername }) }));
        const successCount = results.filter((r) => r.success).length;
        const result = {
            success: successCount > 0,
            successCount,
            failCount: results.length - successCount,
            results,
            systemBalance: state.systemBalance,
        };
        if (requestId) { state.processedRequests[requestId] = { result, time: new Date().toISOString() }; save(); }
        return result;
    }

    function getLog(limit = 100) {
        return state.log.slice().reverse().slice(0, limit);
    }

    // ==================================================
    // COIN CENTER ACCOUNTS (Agency-style operators)
    // ==================================================
    // Admin-only lifecycle: create / remove / enable / disable. Once
    // created, the designated User ID sees a "Coin Center" panel in their
    // own app and can send coins to specific users out of the balance
    // Admin has allocated them.

    function listAccounts() {
        return Object.values(state.accounts).map((a) => {
            const found = findUserByUserId(a.userId);
            return {
                userId: a.userId,
                name: found ? found.user.name : a.name || a.userId,
                mobile: found ? found.mobile : null,
                balance: a.balance,
                enabled: a.enabled,
                createdAt: a.createdAt,
                createdBy: a.createdBy,
                sentTotal: (a.log || []).filter((e) => e.type === "send").reduce((s, e) => s + e.amount, 0)
            };
        });
    }

    function createAccount(userId, adminUsername) {
        const found = findUserByUserId(userId);
        if (!found) return { success: false, message: "User not found" };
        if (state.accounts[userId]) return { success: false, message: "This User ID is already a Coin Center" };
        state.accounts[userId] = {
            userId,
            name: found.user.name,
            balance: 0,
            enabled: true,
            createdAt: new Date().toISOString(),
            createdBy: adminUsername || "admin",
            log: []
        };
        found.user.isCoinCenter = true;
        saveUsers();
        save();
        return { success: true, account: state.accounts[userId] };
    }

    function removeAccount(userId) {
        if (!state.accounts[userId]) return { success: false, message: "Not found" };
        delete state.accounts[userId];
        const found = findUserByUserId(userId);
        if (found) { found.user.isCoinCenter = false; saveUsers(); }
        save();
        return { success: true };
    }

    function setAccountEnabled(userId, enabled) {
        const acc = state.accounts[userId];
        if (!acc) return { success: false, message: "Not found" };
        acc.enabled = !!enabled;
        save();
        return { success: true, account: acc };
    }

    // Moves coins from the shared system pool into a specific operator's
    // own balance — same pool the direct admin-send feature above draws
    // from, so total coins in the economy stay consistently tracked in one
    // place.
    function topUpAccount(userId, amount, adminUsername) {
        const acc = state.accounts[userId];
        if (!acc) return { success: false, message: "Not found" };
        const n = Number(amount);
        if (!Number.isInteger(n) || n <= 0) return { success: false, message: "Provide a valid amount (positive integer)" };
        if (state.systemBalance < n) return { success: false, message: "Insufficient System balance" };
        state.systemBalance -= n;
        acc.balance += n;
        acc.log.push({ type: "topup", amount: n, adminUsername: adminUsername || "admin", time: new Date().toISOString() });
        state.log.push({ type: "account_topup", userId, amount: n, adminUsername: adminUsername || "admin", time: new Date().toISOString() });
        save();
        return { success: true, account: acc, systemBalance: state.systemBalance };
    }

    function myAccount(userId) {
        const acc = state.accounts[userId];
        if (!acc) return null;
        return { userId: acc.userId, balance: acc.balance, enabled: acc.enabled };
    }

    // The operator's own send — identical guarantees to sendCoins() above
    // (idempotent via requestId, logs to the recipient's wallet history as
    // "Coin Center", real-time push) but draws from the operator's own
    // allocated balance instead of the shared system pool, and requires
    // the account to exist + be enabled.
    function accountSendCoins({ operatorUserId, targetUserId, amount, reason, requestId }) {
        const acc = state.accounts[operatorUserId];
        if (requestId && acc && acc.processedRequests && acc.processedRequests[requestId]) {
            return Object.assign({}, acc.processedRequests[requestId], { replayed: true });
        }
        if (!acc) return { success: false, message: "You are not registered as a Coin Center" };
        if (!acc.enabled) return { success: false, message: "Your Coin Center is currently inactive" };

        const n = Number(amount);
        if (!Number.isInteger(n) || n <= 0) return { success: false, message: "Provide a valid amount (positive integer)" };

        const found = findUserByUserId(targetUserId);
        if (!found) return { success: false, message: "User not found" };

        if (acc.balance < n) return { success: false, message: "Your Coin Center balance is insufficient" };

        acc.balance -= n;
        found.user.coins = clampCoins(found.user.userId, (found.user.coins || 0) + n, "coin-center");
        // LEVEL SYSTEM UPGRADE 2026-08-04: removed — Coin Center credits no longer bump user.level (level now only changes via a room gift SEND, see idLevel.js).
        saveUsers();

        const cleanReason = (reason || "").toString().trim().slice(0, 200);
        logTransaction(targetUserId, "coins", n, cleanReason ? `Coin Center: ${cleanReason}` : "Coin Center");

        const entry = {
            id: "ccop_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
            requestId: requestId || null,
            type: "send",
            targetUserId,
            targetName: found.user.name,
            amount: n,
            reason: cleanReason,
            balanceAfter: acc.balance,
            time: new Date().toISOString()
        };
        acc.log.push(entry);
        state.log.push(Object.assign({ operatorUserId }, entry));
        const result = { success: true, balance: acc.balance, entry };
        if (requestId) {
            if (!acc.processedRequests) acc.processedRequests = {};
            acc.processedRequests[requestId] = result;
        }
        save();

        if (typeof pushWalletUpdate === "function") pushWalletUpdate(targetUserId);
        emitToUser(targetUserId, "coin-center-notification", {
            amount: n, reason: cleanReason || null, time: entry.time, newBalance: found.user.coins
        });

        return result;
    }

    function getAccountLog(userId, limit = 100) {
        const acc = state.accounts[userId];
        if (!acc) return [];
        return (acc.log || []).slice().reverse().slice(0, limit);
    }

    return {
        getSystemBalance,
        setSystemBalance,
        findUserByIdOrMobile,
        sendCoins,
        sendCoinsBulk,
        getLog,
        listAccounts,
        createAccount,
        removeAccount,
        setAccountEnabled,
        topUpAccount,
        myAccount,
        accountSendCoins,
        getAccountLog
    };
}

module.exports = { initCoinCenter };
