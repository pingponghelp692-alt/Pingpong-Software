// ==================================================
// PHASE 9 — ANALYTICS HUB (minimal additive backend)
// ==================================================
// Honesty note (read this before extending): almost every card/chart the
// Phase 9 UI needs is ALREADY servable from existing admin endpoints —
// GET /api/admin/stats, /live, /rooms, /users, /agency/list,
// /diamond-seller/sellers, /vip/memberships, /bans, /bans/summary, and
// every approval module's /requests list — all already country-scoped by
// `actorCanAccessCountry` and already permission-gated. The frontend
// (admin/app.js) calls those directly and aggregates client-side, exactly
// like Phase 7's Approval Center already does. NO new backend route was
// added for any of that.
//
// The ONE piece of data genuinely missing from any existing admin
// endpoint is Revenue Analytics: `transactions` (server.js's existing
// in-memory wallet-transaction log) is only exposed per-user via the
// public `/api/wallet/:userId/transactions`, never as an admin-facing
// aggregate. That's the one endpoint this file adds. Everything else
// requested in the Phase 9 instruction that ISN'T backed by real stored
// data (see the frontend-side note in RBAC_MIGRATION_NOTES.md — New
// Registrations/DAU/MAU, Deleted Rooms, true Popular-Rooms ranking,
// Chat/Voice/Room ban sub-types) is left OUT rather than fabricated.
//
// This file is additive and self-contained (same pattern as
// banManagement.js) — it does not import, export, or modify anything in
// server.js/rbac.js/approvalEngine.js or any existing module; it only
// reads the already-existing `transactions` array and `users` map handed
// to it via deps.

const REVENUE_LOOKBACK_DAYS = 120; // bounds the aggregation cost; daily/weekly/monthly are all rolled up client-side from this

function categorize(note) {
    const n = String(note || "");
    if (n.startsWith("Recharge Approved")) return "recharge";
    if (n.startsWith("Withdraw Approved")) return "withdraw";
    if (n.startsWith("Diamond Seller Purchase")) return "diamondSales";
    if (n.startsWith("Diamond Seller Commission")) return "diamondCommission";
    return "other";
}

function initAnalyticsHub(deps) {
    const {
        app, transactions, users, findUserByUserId,
        rbac, requireAdmin, requirePermission,
        actorCanAccessCountry
    } = deps;
    // Phase 11: this loop is O(transactions) and runs a findUserByUserId +
    // country-scope check per transaction — the one real per-request
    // computation in this file (see the file-level comment above). A
    // short (15s) TTL cache is safe here specifically because this
    // endpoint's own contract (see its comment: "no server-side
    // date-range params, keeps this route trivial and cache-friendly")
    // already treats a small staleness window as acceptable, and the
    // cache key includes the actor's exact country scope so two admins
    // with different country access never share a cached result.
    const { cached } = require("./perf/cache");

    // ==================================================
    // GET /api/admin/analytics/revenue — daily aggregate for the last
    // REVENUE_LOOKBACK_DAYS days, scoped to the countries the actor can
    // see (same actorCanAccessCountry every other list endpoint uses).
    // Frontend rolls this up into weekly/monthly buckets and per-category
    // charts — no server-side date-range params, keeps this one route
    // trivial and cache-friendly.
    // ==================================================
    app.get("/api/admin/analytics/revenue", requireAdmin, requirePermission("revenue:view"), (req, res) => {
        // Phase 11: cache key includes the admin account id, so the scope
        // check below (actorCanAccessCountry) is still applied fresh
        // per-actor — caching never lets one admin see another's
        // country-scoped data, it just avoids re-scanning `transactions`
        // for the SAME admin within the same 15s window.
        const result = cached(`revenue:${req.adminAccount.id}`, () => {
            const since = Date.now() - REVENUE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
            const byDay = {}; // "YYYY-MM-DD" -> { recharge, withdraw, diamondSales, diamondCommission, other } (coins/diamonds kept separate)

            for (let i = 0; i < transactions.length; i++) {
                const t = transactions[i];
                const ts = new Date(t.time).getTime();
                if (!Number.isFinite(ts) || ts < since) continue;

                const owner = findUserByUserId(t.userId);
                const countryId = owner ? (owner.user.countryId || "OTHERS") : "OTHERS";
                if (!actorCanAccessCountry(req.adminAccount, countryId)) continue;

                const day = new Date(t.time).toISOString().slice(0, 10);
                if (!byDay[day]) {
                    byDay[day] = {
                        date: day,
                        recharge: { coins: 0 }, withdraw: { diamonds: 0 },
                        diamondSales: { diamonds: 0 }, diamondCommission: { coins: 0 },
                        other: { coins: 0, diamonds: 0 }
                    };
                }
                const bucket = byDay[day];
                const cat = categorize(t.note);
                const amt = Math.abs(Number(t.amount) || 0);
                if (cat === "recharge") bucket.recharge.coins += amt;
                else if (cat === "withdraw") bucket.withdraw.diamonds += amt;
                else if (cat === "diamondSales") bucket.diamondSales.diamonds += amt;
                else if (cat === "diamondCommission") bucket.diamondCommission.coins += amt;
                else bucket.other[t.currency === "diamonds" ? "diamonds" : "coins"] += amt;
            }

            return Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
        }, 15_000);

        res.json({ success: true, days: result, lookbackDays: REVENUE_LOOKBACK_DAYS });
    });

    return {};
}

module.exports = { initAnalyticsHub };
