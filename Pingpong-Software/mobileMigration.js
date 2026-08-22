// ==================================================
// MOBILE ACCOUNT MIGRATION + DUPLICATE MERGE (Production Hotfix, Firebase build)
// ==================================================
// Scope, per the hotfix spec: fix accounts that were keyed under an
// old / un-normalized mobile format (e.g. "+91 98765-43210", "091987654310",
// "9876543210 ") before normalizeMobile() became the single source of
// truth for phone-keyed accounts. This module does NOT touch Firebase
// Authentication, login flow, tokens, or Google-linked accounts
// (users["google:<uid>"] keys are always left completely alone).
//
// What it does, once at boot, before any route/socket touches `users`:
//   1. For every phone-shaped key that isn't already the canonical
//      normalizeMobile() form, compute its canonical key.
//   2. Group all raw keys that resolve to the same canonical key.
//   3. If there's only one raw key for a canonical mobile: rename it in
//      place (old key removed, same object now lives under the canonical
//      key). No data changed, nothing archived — this is a pure rename.
//   4. If there are two or more (a real duplicate — same phone number,
//      different account records): keep the "richer" record under the
//      canonical key, archive the other one(s) in full to
//      data/archived_duplicate_accounts.json (never deleted), and log
//      the merge decision.
//   5. Never deletes user data. Never touches a "google:" key. Never
//      mutates economy/business logic — it only decides which raw key
//      an existing user object lives under.
//
// Idempotent by construction: after one run, every phone account key in
// `users` IS its own canonical form, so a second run finds nothing left
// to migrate and is a fast no-op.

function isGoogleKey(key) {
    return typeof key === "string" && key.startsWith("google:");
}

// Same normalization contract as server.js's normalizeMobile(): last 10
// digits, non-digits stripped. Passed in rather than re-implemented so
// there is exactly one definition of "canonical" in the whole app.
function canonicalOf(key, normalizeMobile) {
    return normalizeMobile(key);
}

// Richer account wins. Score is intentionally simple and transparent
// (not economy logic — just "which record has more real activity/data
// worth keeping as the primary one"), and every input is defensively
// coerced since accounts from different app eras can be missing fields.
function richnessScore(u) {
    if (!u || typeof u !== "object") return -1;
    let score = 0;
    score += Number(u.diamonds) || 0;
    score += (Array.isArray(u.followersList) ? u.followersList.length : 0) * 25;
    score += (Array.isArray(u.followingList) ? u.followingList.length : 0) * 5;
    score += (Array.isArray(u.frameInventory) ? u.frameInventory.length : 0) * 10;
    score += (Array.isArray(u.vehicleInventory) ? u.vehicleInventory.length : 0) * 10;
    score += (Array.isArray(u.recentRooms) ? u.recentRooms.length : 0) * 2;
    if (u.photo) score += 50;
    if (u.verified) score += 100;
    if (u.profile_completed) score += 10;
    if (u.name && String(u.name).trim() && !/^user\d*$/i.test(String(u.name).trim())) score += 20;
    if (u.userId) score += 5;
    // Recency as a tiebreaker only — never the primary signal, so an old
    // rich account still beats a brand-new empty one.
    const lastActive = Number(u.lastDailyRewardAt) || Number(u.lastWeeklyRewardAt) || 0;
    score += Math.min(lastActive / 1e10, 5); // tiny, bounded nudge
    return score;
}

/**
 * Mutates `users` IN PLACE (same object reference other modules already
 * hold on to) and returns a summary. Caller is responsible for persisting
 * the result (saveUsers) and for logging the summary.
 */
function runMobileMigration(users, { normalizeMobile, DATA_FOLDER, safeRead, safeWrite, path }) {
    const ARCHIVE_FILE = path.join(DATA_FOLDER, "archived_duplicate_accounts.json");
    const summary = { renamed: 0, merged: 0, archivedCount: 0, skipped: 0 };

    // Group every phone-shaped key by its canonical form.
    const groups = new Map(); // canonicalKey -> [rawKey, ...]
    for (const rawKey of Object.keys(users)) {
        if (isGoogleKey(rawKey)) continue; // never touch Firebase/Google-linked accounts
        const canonical = canonicalOf(rawKey, normalizeMobile);
        if (!canonical || canonical.length !== 10) {
            // Not a recognizable phone key (corrupt/legacy/manual edit) —
            // leave it exactly as-is rather than guessing.
            summary.skipped++;
            continue;
        }
        if (!groups.has(canonical)) groups.set(canonical, []);
        groups.get(canonical).push(rawKey);
    }

    const archivedThisRun = [];

    for (const [canonical, rawKeys] of groups) {
        if (rawKeys.length === 1 && rawKeys[0] === canonical) {
            continue; // already canonical, already a single account — nothing to do (idempotent no-op)
        }

        // Pick the winner among all raw keys mapping to this canonical mobile.
        let winnerKey = rawKeys[0];
        let winnerScore = richnessScore(users[winnerKey]);
        for (const k of rawKeys.slice(1)) {
            const s = richnessScore(users[k]);
            if (s > winnerScore) { winnerKey = k; winnerScore = s; }
        }

        const isRealDuplicate = rawKeys.length > 1;
        const winnerUser = users[winnerKey];

        // Archive every losing record (full snapshot, nothing dropped).
        for (const k of rawKeys) {
            if (k === winnerKey) continue;
            archivedThisRun.push({
                archivedAt: new Date().toISOString(),
                reason: "duplicate_mobile_merge",
                canonicalMobile: canonical,
                originalKey: k,
                keptKey: winnerKey,
                userSnapshot: users[k]
            });
            delete users[k];
            summary.archivedCount++;
        }

        // Move the winner to the canonical key if it isn't already there.
        if (winnerKey !== canonical) {
            users[canonical] = winnerUser;
            delete users[winnerKey];
        }

        if (isRealDuplicate) summary.merged++; else summary.renamed++;
    }

    if (archivedThisRun.length) {
        const existingArchive = safeRead(ARCHIVE_FILE, []);
        const merged = Array.isArray(existingArchive) ? existingArchive.concat(archivedThisRun) : archivedThisRun;
        // Immediate, synchronous-style write (small file, runs once at boot,
        // must be on disk before the server starts accepting traffic) —
        // same safeWrite() used everywhere else, just forced non-debounced.
        safeWrite(ARCHIVE_FILE, merged, { immediate: true });
    }

    return summary;
}

module.exports = { runMobileMigration };
