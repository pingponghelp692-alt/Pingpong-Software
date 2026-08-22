// ==================================================
// ID Level System (1–N) — Backend Core (additive module)
// ==================================================
// UPGRADE (2026-08-04, "ID Level System Upgrade" spec). This is the SAME
// module/spec lineage as the 2026-07-29 rewrite — not a new/second level
// system. What changed in this pass, per the customer's explicit
// requirements:
//
//   1. The progression formula (starting value / growth multiplier / max
//      level) is now a persisted, admin-editable CONFIG instead of three
//      hardcoded constants. Default matches the customer's exact example:
//      Level 1 = 10,000, Level 2 = 50,000, Level 3 = 250,000, Level 4 =
//      1,250,000 — i.e. requirement(n) = startingValue *
//      growthMultiplier^(n-1) for every n, one single formula.
//   2. Levels are grouped in tens (1–9, 10–19, 20–29, ... "100+") and each
//      group carries an admin-uploadable THEME (badge PNG, icon PNG,
//      border PNG, background/gradient, text color, glow) — persisted and
//      cached in memory, never re-read from disk per-request.
//   3. getLevelInfo() now returns the current + next-group theme so the
//      Profile Page / Gift Box can render the badge/colors/progress
//      without a second round trip.
//
// Everything from the previous rewrite is unchanged and still true: level
// only ever increases from a successful room gift SEND (recordGiftSent(),
// called at the exact 3 call sites in server.js after a Gift/Video Gift
// coin spend succeeds inside a room) — nothing else may call it. Checked
// and confirmed to never call this: recharge, coin purchase, admin
// coin/wallet edits, daily/login/referral rewards, chests, games, receiving
// gifts/diamonds, coin exchange, agency rewards, VIP/vehicle purchases,
// background jobs, manual DB edits — and, newly relevant to this pass, the
// wealth-tier `user.level` field that server.js/coinCenter.js/
// diamondSeller.js/rechargeWithdrawApproval.js used to independently
// recompute from raw coin BALANCE on every coin-changing event. That was a
// second, parallel "level" that changed on login/recharge/admin-grant/
// daily-reward/etc — exactly the "level increases automatically" bug this
// spec asks to remove.
//
// Per "modify the existing system, don't create a new one": this module
// doesn't introduce a second field. recordGiftSent() below mirrors its
// result onto `user.level` (see mirrorToLegacyLevelField), so every
// existing UI element that already reads `user.level`/`me.level` (Profile
// chip, Gift Panel card, User Popup, Visitor Card, Room seat badges,
// Ranking, etc.) automatically starts showing the real, gift-send-only ID
// Level without those ~20 display call sites needing to change. The old
// wealth-tier formula (Math.floor(coins/200)+1) and its call sites that
// recomputed on every coin change have been deleted at the source — search
// server.js/coinCenter.js/diamondSeller.js/rechargeWithdrawApproval.js for
// "LEVEL SYSTEM UPGRADE 2026-08-04".
//
// lifetimeGiftSent: unchanged — increases only via recordGiftSent(), never
// decreases/resets, pure running total, this module is the sole writer.
//
// Level Lock: unchanged — idLevel (and the mirrored user.level) only ever
// increases. A future admin edit to the config can never silently lower a
// user's already-reached level.

const path = require("path");

function initIdLevel({ io, socketsByUserId, emitToUser, findUserByUserId, DATA_FOLDER, safeRead, safeWrite }) {
    const LEVEL_CONFIG_FILE = path.join(DATA_FOLDER, "level_config.json");
    const LEVEL_THEMES_FILE = path.join(DATA_FOLDER, "level_themes.json");

    const DEFAULT_CONFIG = {
        startingValue: 10000,   // Level 1 requirement (customer spec default)
        growthMultiplier: 5,    // Each level's requirement = previous * this
        maxLevel: 100           // Admin-adjustable ceiling (spec examples: 100/200/500/1000)
    };

    function sanitizeConfig(raw) {
        const c = Object.assign({}, DEFAULT_CONFIG, raw && typeof raw === "object" ? raw : {});
        c.startingValue = Math.max(1, Math.round(Number(c.startingValue) || DEFAULT_CONFIG.startingValue));
        c.growthMultiplier = Math.max(1.01, Number(c.growthMultiplier) || DEFAULT_CONFIG.growthMultiplier);
        c.maxLevel = Math.min(1000, Math.max(1, Math.round(Number(c.maxLevel) || DEFAULT_CONFIG.maxLevel)));
        return c;
    }

    // ---- Config (persisted, admin-editable) ----
    let config = sanitizeConfig(safeRead(LEVEL_CONFIG_FILE, DEFAULT_CONFIG));

    // ---- Level Requirement Table (Lifetime Gift Sent), cached in memory ----
    // Single formula, no special-cased levels: requirement(n) = startingValue
    // * growthMultiplier^(n-1). Rebuilt only when config changes (see
    // updateConfig) — never recomputed per-request (perf requirement).
    function buildLevelTable(cfg) {
        const table = { 0: 0 };
        for (let lvl = 1; lvl <= cfg.maxLevel; lvl++) {
            table[lvl] = Math.round(cfg.startingValue * Math.pow(cfg.growthMultiplier, lvl - 1));
        }
        return table;
    }
    let LEVEL_TABLE = buildLevelTable(config);

    // ---- Level Groups (every 10 levels share one theme) ----
    // Group 0 = levels 1-9 (per spec's own example table, the first group is
    // nine levels, not ten — every group after that is a clean ten).
    function groupIndexForLevel(level) {
        if (level <= 0) return 0;
        if (level < 10) return 0;
        return Math.floor(level / 10);
    }
    function groupLabel(groupIndex) {
        if (groupIndex === 0) return "1-9";
        const start = groupIndex * 10;
        const end = start + 9;
        if (start >= 100) return `${start}+`;
        return `${start}-${end}`;
    }
    function groupCount(cfg) {
        return groupIndexForLevel(cfg.maxLevel) + 1;
    }

    // ---- Themes (persisted, admin-editable per group) ----
    // Fallback palette so a group that hasn't been customized yet still
    // looks intentional instead of "broken" — purely cosmetic defaults,
    // never written to disk unless an admin actually saves a theme.
    const FALLBACK_PALETTE = [
        { gradientFrom: "#8a8f98", gradientTo: "#5c6068", textColor: "#ffffff", glowColor: "#9aa0aa", glowEnabled: false },
        { gradientFrom: "#4fb0e8", gradientTo: "#2f7fc4", textColor: "#ffffff", glowColor: "#4fb0e8", glowEnabled: false },
        { gradientFrom: "#4fd39a", gradientTo: "#28a06e", textColor: "#ffffff", glowColor: "#4fd39a", glowEnabled: false },
        { gradientFrom: "#c9a24b", gradientTo: "#96771f", textColor: "#ffffff", glowColor: "#e8c76a", glowEnabled: true },
        { gradientFrom: "#b076e8", gradientTo: "#7a3fc0", textColor: "#ffffff", glowColor: "#b076e8", glowEnabled: true },
        { gradientFrom: "#e86f8f", gradientTo: "#c73a5e", textColor: "#ffffff", glowColor: "#e86f8f", glowEnabled: true },
        { gradientFrom: "#e8944f", gradientTo: "#c46b2f", textColor: "#ffffff", glowColor: "#e8944f", glowEnabled: true },
        { gradientFrom: "#e8d24f", gradientTo: "#c4a52f", textColor: "#111111", glowColor: "#e8d24f", glowEnabled: true },
        { gradientFrom: "#ff5b5b", gradientTo: "#c62828", textColor: "#ffffff", glowColor: "#ff5b5b", glowEnabled: true },
        { gradientFrom: "#ffffff", gradientTo: "#e0c76a", textColor: "#5c4400", glowColor: "#fff3c4", glowEnabled: true } // top tier / "100+"
    ];
    function defaultTheme(groupIndex) {
        const p = FALLBACK_PALETTE[Math.min(groupIndex, FALLBACK_PALETTE.length - 1)];
        return Object.assign({ badgeUrl: null, iconUrl: null, borderUrl: null, backgroundUrl: null, updatedAt: null, isDefault: true }, p);
    }

    let themes = safeRead(LEVEL_THEMES_FILE, {}); // { "<groupIndex>": {...theme fields} }
    function getTheme(groupIndex) {
        const stored = themes[String(groupIndex)];
        return stored ? Object.assign({}, defaultTheme(groupIndex), stored, { isDefault: false }) : defaultTheme(groupIndex);
    }
    function getAllThemes() {
        const n = groupCount(config);
        const out = [];
        for (let g = 0; g < n; g++) out.push(Object.assign({ groupIndex: g, label: groupLabel(g), levelRange: g === 0 ? [1, 9] : [g * 10, g * 10 + 9] }, getTheme(g)));
        return out;
    }
    function setGroupTheme(groupIndex, fields) {
        const g = Math.max(0, Math.round(Number(groupIndex) || 0));
        const existing = themes[String(g)] || {};
        const merged = Object.assign({}, existing);
        // Only accept known fields — never let arbitrary request body fields
        // get persisted into the theme file.
        const ALLOWED = ["badgeUrl", "iconUrl", "borderUrl", "backgroundUrl", "gradientFrom", "gradientTo", "textColor", "glowColor", "glowEnabled"];
        ALLOWED.forEach((k) => { if (fields[k] !== undefined) merged[k] = fields[k]; });
        merged.updatedAt = Date.now();
        themes[String(g)] = merged;
        safeWrite(LEVEL_THEMES_FILE, themes, { immediate: true });
        return getTheme(g);
    }

    // ---- Config read/update ----
    function getConfig() { return Object.assign({}, config, { groupCount: groupCount(config) }); }
    function updateConfig(partial) {
        config = sanitizeConfig(Object.assign({}, config, partial || {}));
        LEVEL_TABLE = buildLevelTable(config); // rebuild the cached table once, here — not per-request
        safeWrite(LEVEL_CONFIG_FILE, config, { immediate: true });
        return getConfig();
    }

    // Highest level whose requirement is <= lifetimeGiftSent. Supports
    // jumping multiple levels at once for a single large send.
    function levelFromLifetimeGiftSent(lifetimeGiftSent) {
        let level = 0;
        for (let lvl = 1; lvl <= config.maxLevel; lvl++) {
            if (lifetimeGiftSent >= LEVEL_TABLE[lvl]) level = lvl;
            else break;
        }
        return level;
    }

    // Single centralized place that turns (level, lifetimeGiftSent) into
    // every number + theme the Gift Box / Level Information screen needs.
    function buildLevelInfo(idLevelVal, lifetimeGiftSent) {
        const currentLevel = idLevelVal || 0;
        const nextLevel = currentLevel < config.maxLevel ? currentLevel + 1 : null;
        const currentLevelRequirement = LEVEL_TABLE[currentLevel] || 0;
        const nextLevelRequirement = nextLevel ? LEVEL_TABLE[nextLevel] : null;
        const giftNeededForNextLevel = nextLevel ? Math.max(0, nextLevelRequirement - lifetimeGiftSent) : 0;
        let progressPercent = 100;
        if (nextLevel) {
            const span = nextLevelRequirement - currentLevelRequirement;
            const into = lifetimeGiftSent - currentLevelRequirement;
            progressPercent = span > 0 ? Math.max(0, Math.min(100, Math.round((into / span) * 100))) : 100;
        }
        const currentGroup = groupIndexForLevel(Math.max(1, currentLevel));
        const nextGroup = nextLevel ? groupIndexForLevel(nextLevel) : currentGroup;
        return {
            currentLevel,
            lifetimeGiftSent,
            nextLevel,
            nextLevelRequirement,
            giftNeededForNextLevel,
            progressPercent,
            maxLevel: config.maxLevel,
            isMaxLevel: nextLevel === null,
            groupIndex: currentGroup,
            groupLabel: groupLabel(currentGroup),
            theme: getTheme(currentGroup),
            // Only a distinct "next badge preview" when the next level is
            // actually in a different group — no point previewing the same
            // theme the user already has.
            nextTheme: nextLevel && nextGroup !== currentGroup ? getTheme(nextGroup) : null,
            nextGroupLabel: nextLevel && nextGroup !== currentGroup ? groupLabel(nextGroup) : null
        };
    }

    // BACKWARD-COMPAT MIRROR (see the big comment at the top of this file):
    // keeps the legacy `user.level` field — which ~20 existing UI call
    // sites across the app already read — in sync with the real idLevel, so
    // none of those call sites need to change. Guarded so it can only ever
    // raise the value, matching the Level Lock guarantee on idLevel itself.
    function mirrorToLegacyLevelField(user, computedLevel) {
        if (!user) return;
        if (typeof user.level !== "number" || computedLevel > user.level) user.level = computedLevel;
    }

    // Call this once, right after a Gift/Video Gift coin spend has actually
    // succeeded INSIDE A ROOM (coins already deducted from sender, gift
    // already delivered). `giftValue` = coin value of that send. Idempotent
    // no-op if giftValue is falsy/non-positive.
    //
    // Concurrency: unchanged from the previous rewrite — Node.js runs this
    // (and the coin-deduction code right before it) synchronously with no
    // `await` in between, so there's no interleaving window.
    function recordGiftSent(userId, giftValue) {
        if (!giftValue || giftValue <= 0) return null;
        const found = findUserByUserId(userId);
        if (!found) return null;
        const user = found.user;

        user.lifetimeGiftSent = (user.lifetimeGiftSent || 0) + giftValue;
        const oldLevel = user.idLevel || 0;
        const computedLevel = levelFromLifetimeGiftSent(user.lifetimeGiftSent);

        if (computedLevel > oldLevel) {
            user.idLevel = computedLevel;
            mirrorToLegacyLevelField(user, computedLevel);
            const info = buildLevelInfo(computedLevel, user.lifetimeGiftSent);
            emitToUser(userId, "id-level-up", { ...info, previousLevel: oldLevel, leveledUp: true }); // GAP #1 — cross-instance-safe
            return { leveledUp: true, oldLevel, newLevel: computedLevel, ...info };
        }
        return { leveledUp: false, oldLevel, newLevel: oldLevel, ...buildLevelInfo(oldLevel, user.lifetimeGiftSent) };
    }

    // Read-only lookup for the Gift Box / Level Information / Profile
    // screens. Never mutates anything.
    function getLevelInfo(userId) {
        const found = findUserByUserId(userId);
        if (!found) return null;
        const user = found.user;
        return buildLevelInfo(user.idLevel || 0, user.lifetimeGiftSent || 0);
    }

    // ADMIN: recompute-and-broadcast after a theme save, so every online
    // user currently in that group sees their badge/colors update live with
    // no page reload — "Global Theme Update", the spec's headline
    // requirement. server.js's admin route calls this right after
    // setGroupTheme() persists.
    function broadcastThemeUpdate(groupIndex) {
        const theme = getTheme(groupIndex);
        io.emit("level-theme-update", { groupIndex, label: groupLabel(groupIndex), theme });
    }

    return {
        recordGiftSent, getLevelInfo, levelFromLifetimeGiftSent,
        getConfig, updateConfig,
        getAllThemes, getTheme, setGroupTheme, broadcastThemeUpdate,
        groupIndexForLevel, groupLabel,
        get LEVEL_TABLE() { return LEVEL_TABLE; }, // live getter — always the current cached table
        get MAX_LEVEL() { return config.maxLevel; }
    };
}

module.exports = { initIdLevel };
