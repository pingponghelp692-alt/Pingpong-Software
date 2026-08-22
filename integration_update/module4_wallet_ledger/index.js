/* ==========================================================================
   Module 4 — Wallet Ledger — Package Entry Point
   ==========================================================================
   Follows the same standalone "attach()" convention as
   integration_update/country_permission and integration_update/merchant:
   this folder is never required automatically by server.js, and nothing
   in it touches server.js's live user.coins / user.diamonds / logTransaction
   code paths. It only becomes active if/when something explicitly calls
   attach() below.

   WHY THIS STAYS UN-WIRED FOR NOW (see FINAL_INTEGRATION_REPORT.md at the
   project root for the full reasoning):
   server.js's wallet mutations (coinCenter.js, diamondSeller.js,
   callHosting.js, gifts, recharge/withdraw approval, daily/weekly rewards,
   treasure chest, instant exchange — 10+ call sites) are currently backed
   by the in-memory user object + logTransaction()/saveUsers(), not
   Postgres. This module's wallet/index.js is a separate, Postgres-backed,
   ledgered, idempotent implementation that was built and audited in
   isolation and has never been called from a real request handler.

   Flipping wallet authority over to this module means: standing up real
   Postgres for it, migrating every existing user's live coins/diamonds
   balances into module4_wallet_balances, and rewriting every one of those
   10+ call sites in the same change — a real data migration, not a code
   merge. Doing that inside this integration pass, without a live Postgres
   instance to test against and without a migration plan for existing
   balances, is exactly the kind of destructive, unverified change the
   integration brief said not to make. So: the module ships complete,
   tested (against a mock Postgres — see test/), and ready — but inactive.

   USAGE, WHEN A FUTURE STAGE DECIDES TO CUT OVER:
       const module4Wallet = require("./integration_update/module4_wallet_ledger")
           .attach({ pgPool, clampCoinBalance, clampDiamondBalance, redisPool });

       // module4Wallet.wallet.credit(userId, "coins", amount, txnId, note)
       // module4Wallet.wallet.debit(...)
       // module4Wallet.wallet.transferBetweenUsers(...)
       // See wallet/index.js and docs/MODULE4_FINAL_AUDIT_REPORT.md for the
       // full API and the accounting guarantees it makes.
   ========================================================================== */

const wallet = require("./wallet/index.js");
const connectionFactory = require("./redis/connectionFactory.js");
const roomState = require("./redis/roomState.js");
const routing = require("./redis/routing.js");
const userProfile = require("./redis/userProfile.js");
const lock = require("./redis/lock.js");
const keyspace = require("./redis/keyspace.js");

// deps: { pgPool, clampCoinBalance, clampDiamondBalance, redisPool }
// clampCoinBalance/clampDiamondBalance should be server.js's real
// functions (see server.js line ~4782) — passing them in is what makes
// this module's ceiling policy match the live app's instead of inventing
// its own, per wallet/index.js's own header comment.
async function attach(deps = {}) {
    const clampFn = deps.clampCoinBalance && deps.clampDiamondBalance
        ? (userId, balance, context, currency) =>
            currency === "diamonds"
                ? deps.clampDiamondBalance(userId, balance, context)
                : deps.clampCoinBalance(userId, balance, context)
        : undefined;

    await wallet.init({
        pgPool: deps.pgPool,
        redisPool: deps.redisPool,
        clampFn,
    });

    return {
        wallet,
        redis: { connectionFactory, roomState, routing, userProfile, lock, keyspace },
    };
}

module.exports = { attach, wallet, connectionFactory, roomState, routing, userProfile, lock, keyspace };
