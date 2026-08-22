// ==================================================
// PHASE 11 — SHORT-TTL READ CACHE (additive)
// ==================================================
// Deliberately narrow scope: this is NOT a general-purpose cache layer,
// and it is NOT used anywhere that touches wallet/coin/diamond logic,
// RBAC decisions, approval state, or ban state — using a cache for any
// of those would risk serving stale data for something that must always
// be exactly correct (e.g. "is this user banned right now"). It's only
// applied to read-heavy, aggregate/reporting endpoints where a few
// seconds of staleness is invisible to the admin looking at a chart
// (analyticsHub.js's revenue aggregation, the one endpoint in this app
// that does real per-request computation over a bounded-but-nontrivial
// array — see that file's own comments).
//
// Expires purely by time (TTL) — never manually invalidated by a write
// elsewhere, which is what keeps this safe to drop in without tracing
// every code path that could change the underlying data: it can never
// go stale for longer than TTL_MS, full stop.

const store = new Map(); // key -> { value, expiresAt }

/**
 * Returns a cached value for `key` if still within TTL, otherwise calls
 * `computeFn()`, caches the result, and returns it.
 * @param {string} key
 * @param {() => any} computeFn
 * @param {number} ttlMs
 */
function cached(key, computeFn, ttlMs = 15_000) {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = computeFn();
    store.set(key, { value, expiresAt: now + ttlMs });
    return value;
}

// Periodic sweep so the Map doesn't grow forever from one-off keys.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (entry.expiresAt <= now) store.delete(key);
    }
}, 5 * 60 * 1000).unref();

module.exports = { cached };
