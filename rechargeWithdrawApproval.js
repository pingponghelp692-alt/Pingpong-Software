// ==================================================
// PHASE 6 — RECHARGE / WITHDRAW APPROVAL WORKFLOW (item 2 of Phase 6 SRS,
// step 7 of the development sequence)
// ==================================================
// Two parallel workflows on the shared approvalEngine (see
// approvalEngine.js). Does NOT touch or replace the existing simple
// diamond<->coin Exchange system (GET /api/admin/exchanges,
// POST /api/admin/exchanges/:id/decide, gated by withdraw:view/approve) —
// that stays exactly as it was. This is a SEPARATE, additive multi-level
// state machine for admin-recorded manual Recharge (crediting coins to a
// user after an off-platform payment, e.g. mobile banking) and manual
// Withdraw (deducting diamonds from a user for an off-platform payout),
// per the approved SRS:
//
//   Admin           -> Submit   (recharge:submit / withdraw:submit)
//   Country Manager -> Review   (recharge:review / withdraw:review)
//   Super Admin     -> Approve  (recharge:approve / withdraw:approve —
//                                 withdraw:approve already existed from
//                                 Phase 2, reused as-is)
//   Owner           -> Override (any transition, any status)
//
// The wallet mutation (coins credited / diamonds deducted) only ever
// happens at the moment of approval (onApprove hook below) — never at
// submit or review time — so nothing touches a user's balance until a
// Super Admin (or Owner) has actually signed off.

const { createApprovalWorkflow } = require("./approvalEngine.js");

function initRechargeWithdrawApproval(deps) {
    const {
        app, DATA_FOLDER, safeRead, safeWrite,
        findUserByUserId, saveUsers, logTransaction, pushWalletUpdate, levelFromCoins,
        io, socketsByUserId, emitToUser,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry, countryDeniedResponse, reqUserAgent
    } = deps;
    const clampCoins = typeof deps.clampCoinBalance === "function" ? deps.clampCoinBalance : (userId, coins) => {
        if (!Number.isFinite(coins) || coins < 0) return 0;
        return Math.min(Math.floor(coins), 100000000000);
    };

    const engineDeps = { app, DATA_FOLDER, safeRead, safeWrite, rbac, requireAdmin, requirePermission, actorCanAccessCountry, countryDeniedResponse, reqUserAgent };

    // GAP #1 — cross-instance-safe via emitToUser()
    function notifyUser(record, event) {
        emitToUser(record.userId, "approval-notification", {
            domain: record.domain, requestId: record.requestId, status: record.status, event,
            amount: record.amount, currency: record.currency, note: record.decisionNote || record.reviewNote || null
        });
    }

    // ==================================================
    // RECHARGE — Admin submits an amount of coins to credit a user after
    // confirming an off-platform payment (payment reference kept as a
    // manual note field, matched against real receipts by the Admin
    // before submitting — this module doesn't integrate a payment
    // gateway, it's the manual/administrative recharge path the SRS asks
    // for).
    // ==================================================
    const recharge = createApprovalWorkflow({
        deps: engineDeps,
        domain: "recharge",
        fileName: "recharge_requests.json",
        basePath: "/api/admin/recharge/requests",
        idPrefix: "rcq_",
        permissions: { view: "recharge:view", submit: "recharge:submit", review: "recharge:review", approve: "recharge:approve" },
        extraSearchFields: ["paymentRef"],
        validateSubmit(body) {
            const found = findUserByUserId(body.userId);
            if (!found) return { ok: false, message: "Provide a valid User ID" };
            const amount = Number(body.amount);
            if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: "Provide a valid Coin amount" };
            return {
                ok: true,
                userId: body.userId,
                countryId: found.user.countryId || "OTHERS",
                data: { domain: "recharge", currency: "coins", amount, paymentRef: (body.paymentRef || "").trim() || null }
            };
        },
        onApprove(record) {
            const found = findUserByUserId(record.userId);
            if (!found) return { ok: false, message: "User no longer exists" };
            found.user.coins = clampCoins(record.userId, (found.user.coins || 0) + record.amount, "recharge-approve");
            // LEVEL SYSTEM UPGRADE 2026-08-04: removed — an approved recharge
            // no longer bumps user.level (level now only changes via a room
            // gift SEND, see idLevel.js).
            saveUsers();
            logTransaction(record.userId, "coins", record.amount, "Recharge Approved (" + record.requestId + ")");
            pushWalletUpdate(record.userId);
            return { ok: true, extra: { balanceAfter: found.user.coins } };
        },
        onNotify: notifyUser
    });

    // ==================================================
    // WITHDRAW — Admin submits a diamond amount a user wants to cash out.
    // Sufficiency is checked at approval time (not submit time), since a
    // user's balance can change while the request sits in review.
    // ==================================================
    const withdraw = createApprovalWorkflow({
        deps: engineDeps,
        domain: "withdraw",
        fileName: "withdraw_requests.json",
        basePath: "/api/admin/withdraw/requests",
        idPrefix: "wdq_",
        permissions: { view: "withdraw:view", submit: "withdraw:submit", review: "withdraw:review", approve: "withdraw:approve" },
        extraSearchFields: ["payoutRef"],
        validateSubmit(body) {
            const found = findUserByUserId(body.userId);
            if (!found) return { ok: false, message: "Provide a valid User ID" };
            const amount = Number(body.amount);
            if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: "Provide a valid Diamond amount" };
            return {
                ok: true,
                userId: body.userId,
                countryId: found.user.countryId || "OTHERS",
                data: { domain: "withdraw", currency: "diamonds", amount, payoutRef: (body.payoutRef || "").trim() || null }
            };
        },
        onApprove(record) {
            const found = findUserByUserId(record.userId);
            if (!found) return { ok: false, message: "User no longer exists" };
            if ((found.user.diamonds || 0) < record.amount) return { ok: false, message: "User doesn't have sufficient Diamonds (current: " + (found.user.diamonds || 0) + ")" };
            found.user.diamonds -= record.amount;
            saveUsers();
            logTransaction(record.userId, "diamonds", -record.amount, "Withdraw Approved (" + record.requestId + ")");
            pushWalletUpdate(record.userId);
            return { ok: true, extra: { balanceAfter: found.user.diamonds } };
        },
        onNotify: notifyUser
    });

    return { recharge, withdraw };
}

module.exports = { initRechargeWithdrawApproval };
