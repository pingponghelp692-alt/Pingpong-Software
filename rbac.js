/* ==========================================================================
   PingPong RBAC (Role Based Access Control) — Enterprise Admin Layer
   ==========================================================================
   Standalone, additive module. Does NOT touch users/rooms/gifts/wallet/AI
   Core logic. Only concern: WHO can log into the admin panel, WHAT role/
   country they belong to, and WHICH menus/API actions they're allowed to
   use. server.js wires this in via requireAdmin()/requirePermission() and
   the existing single-admin login is migrated to the "owner" role
   (see ensureOwnerAccount below) — nothing about that login breaks.

   Storage: flat JSON files under data/ (same atomic-write pattern as the
   rest of the app), so no new DB dependency is introduced.
   ========================================================================== */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function makeStore(dataFolder) {
    const ACCOUNTS_FILE = path.join(dataFolder, "admin_accounts.json");
    const LOGS_FILE = path.join(dataFolder, "admin_logs.json");

    function safeWrite(file, data) {
        const tmpFile = file + ".tmp";
        try {
            fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
            fs.renameSync(tmpFile, file);
        } catch (err) {
            console.error(`❌ [rbac] Failed to write ${file}:`, err.message);
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
        }
    }
    function safeRead(file, fallback) {
        try {
            if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (err) {
            console.error(`❌ [rbac] Failed to read ${file}, using fallback:`, err.message);
        }
        return fallback;
    }

    // ---------------------------------------------------------------------
    // Roles (final hierarchy)
    // ---------------------------------------------------------------------
    const ROLES = {
        OWNER: "owner",
        GLOBAL_SUPER_ADMIN: "global_super_admin",
        COUNTRY_SUPER_ADMIN: "country_super_admin",
        COUNTRY_MANAGER: "country_manager",
        ADMIN: "admin",
        MODERATOR: "moderator"
    };
    const ROLE_RANK = { // lower number = more powerful; used for "can this role create that role" checks
        [ROLES.OWNER]: 0,
        [ROLES.GLOBAL_SUPER_ADMIN]: 1,
        [ROLES.COUNTRY_SUPER_ADMIN]: 2,
        [ROLES.COUNTRY_MANAGER]: 3,
        [ROLES.ADMIN]: 4,
        [ROLES.MODERATOR]: 5
    };
    // Who is allowed to create which role. Owner can create anyone.
    const CAN_CREATE = {
        [ROLES.OWNER]: [ROLES.GLOBAL_SUPER_ADMIN, ROLES.COUNTRY_SUPER_ADMIN, ROLES.COUNTRY_MANAGER, ROLES.ADMIN, ROLES.MODERATOR],
        [ROLES.GLOBAL_SUPER_ADMIN]: [ROLES.COUNTRY_SUPER_ADMIN, ROLES.COUNTRY_MANAGER, ROLES.ADMIN, ROLES.MODERATOR],
        [ROLES.COUNTRY_SUPER_ADMIN]: [ROLES.COUNTRY_MANAGER, ROLES.ADMIN, ROLES.MODERATOR],
        [ROLES.COUNTRY_MANAGER]: [ROLES.ADMIN, ROLES.MODERATOR],
        [ROLES.ADMIN]: [ROLES.MODERATOR],
        [ROLES.MODERATOR]: []
    };

    const COUNTRIES = [
        { id: "IN", name: "India", superAdminSlots: 2, adminSlots: 6 },
        { id: "BD", name: "Bangladesh", superAdminSlots: 2, adminSlots: 6 },
        { id: "PK", name: "Pakistan", superAdminSlots: 2, adminSlots: 6 },
        { id: "AR", name: "Arabic Countries", superAdminSlots: 2, adminSlots: 6 },
        { id: "OTHERS", name: "Other Countries", superAdminSlots: 2, adminSlots: 6 }
    ];
    const COUNTRY_IDS = COUNTRIES.map((c) => c.id);

    // ---------------------------------------------------------------------
    // Permissions — module:action strings. Add new ones here as new
    // modules are gated; nothing else needs to change.
    // ---------------------------------------------------------------------
    const PERMISSIONS = [
        "dashboard:view",
        "users:view", "users:edit", "users:mute", "users:ban", "users:unban", "users:delete", "users:coin-edit", "users:verify",
        "rooms:view", "rooms:lock", "rooms:unlock", "rooms:delete", "rooms:seat-manage",
        "rooms:kick-user", "rooms:mute-user", "rooms:seat-lock",
        "economy:view",
        "coin-center:view", "coin-center:send",
        "recharge:view", "recharge:verify", "recharge:submit", "recharge:review", "recharge:approve",
        "withdraw:view", "withdraw:approve", "withdraw:submit", "withdraw:review",
        "frames:view", "frames:manage", "frames:submit", "frames:review", "frames:approve",
        "namefx:view", "namefx:approve", "namefx:submit", "namefx:review",
        "tags:manage", "svip-tags:manage",
        "gifts:manage", "gifts:view", "gifts:submit", "gifts:review", "gifts:approve", "video-gifts:manage",
        "agencies:view", "agencies:submit", "agencies:review", "agencies:approve", "agencies:manage",
        "diamond-seller:view", "diamond-seller:approve", "diamond-seller:submit", "diamond-seller:review", "diamond-seller:suspend",
        "coin-seller:view", "coin-seller:manage", // Wallet "Coin Seller List" — separate, simpler module from diamond-seller above (see coinSellers.js)
        "announce:send",
        "chest:manage",
        "theme-library:manage",
        "events:manage", "events:execute",
        "vip:view", "vip:approve", "vip:submit", "vip:review",
        "ban:view", "ban:submit", "ban:review", "ban:approve", "ban:appeal-review", "ban:appeal-decide",
        "badges:manage",
        "fraud:manage", "device-ban:manage", "ip-ban:manage",
        "reports:view", "reports:handle",
        "country:manage",
        "role:manage",
        "security:view-logs", "security:server-settings",
        "revenue:view",
        "ai-core:view", "ai-core:manage",
        "support-tickets:manage",
        "godpower:manage", // existing "Super Admin" (God Power) section — unrelated name-collision, left as-is
        "banners:manage", // Home Banner System — Owner-only, see NON_OWNER_ONLY below
        "vehicles:manage", // Vehicle Entry System (add-on) — catalog + direct user assignment, see vehicles.js
        "level:manage", // Level Management (ID Level System Upgrade, 2026-08-04) — config + per-group themes, see idLevel.js
        "callhosting:manage", // Call Hosting System — host approval, rates, reports, revenue, targets, see callHosting.js
        "voice-sfu:manage", // SFU voice provider admin (health snapshot, force-kick a participant) — Phase 3 Step 3.2, see voice_sfu/index.js. Does not affect the existing mesh voice path or any of its permissions.
        "merchant:view", "merchant:manage", // Merchant Directory (integration_update/merchant), rbac_extension stage — see that module's README
        "relationships:manage", // Friendship/CP visual settings (size/opacity/animation/position + custom PNG asset), see friendshipCp.js
        "payment:manage", // Payment/Recharge Settings + Package CRUD (UPI ID, methods, min/max, packages) — see wallet/rechargeService.js
        "payment:view", "payment:approve" // Recharge Records — view the queue / approve-or-reject a user-submitted UTR
    ];

    // Default permission sets per role. Owner is implicit "all" and isn't
    // stored (see hasPermission below), so it's future-proof against new
    // permissions being added later without needing a migration.
    const NON_OWNER_ONLY = ["country:manage", "role:manage", "security:server-settings", "banners:manage"];
    const ALL_EXCEPT_OWNER_ONLY = PERMISSIONS.filter((p) => !NON_OWNER_ONLY.includes(p));

    const DEFAULT_ROLE_PERMISSIONS = {
        [ROLES.GLOBAL_SUPER_ADMIN]: ALL_EXCEPT_OWNER_ONLY,
        [ROLES.COUNTRY_SUPER_ADMIN]: ALL_EXCEPT_OWNER_ONLY,
        [ROLES.COUNTRY_MANAGER]: [
            "dashboard:view", "users:view", "rooms:view", "rooms:lock", "rooms:unlock",
            "agencies:view", "agencies:manage", "agencies:review", "diamond-seller:view", "diamond-seller:review", "announce:send",
            "events:manage", "events:execute", "vip:view", "vip:review", "reports:view", "reports:handle",
            "support-tickets:manage", "revenue:view", "recharge:view", "recharge:review", "withdraw:view", "withdraw:review",
            "namefx:review", "frames:review", "gifts:view", "gifts:review",
            "ban:view", "ban:review", "ban:appeal-review",
            "merchant:view", "merchant:manage", // mirrors the agencies:view+agencies:manage grant just above — Country Manager can fully manage merchants in their own country
            "payment:view", "payment:approve" // can review/approve-reject user recharge submissions, but not change UPI ID/packages (payment:manage stays Global/Country Super Admin+Owner only, same asymmetry as country:manage)
        ],
        [ROLES.ADMIN]: [
            "dashboard:view", "users:view", "users:mute", "users:ban", "users:unban",
            "rooms:view", "rooms:lock", "rooms:unlock", "rooms:seat-manage",
            "rooms:kick-user", "rooms:mute-user", "rooms:seat-lock",
            "agencies:view", "agencies:submit", "diamond-seller:view", "diamond-seller:submit",
            "vip:view", "vip:submit", "namefx:view", "namefx:submit", "frames:view", "frames:submit",
            "gifts:view", "gifts:submit", "recharge:view", "recharge:submit", "withdraw:view", "withdraw:submit",
            "reports:view", "reports:handle", "events:execute", "support-tickets:manage",
            "ban:view", "ban:submit",
            "merchant:view", // mirrors agencies:view just above — Admin can see merchants but not create/edit/suspend them (that's Country Manager+, same asymmetry as agencies:manage)
            "payment:view" // can see the recharge queue but not approve/reject (that's Country Manager+) or change settings/packages (Owner/Super Admin only)
        ],
        // Moderator (RBAC Phase 3 — Moderator Room Restriction): default set
        // matches the approved SRS's allowed-action list exactly. Two SRS
        // items ("Mic Lock/Unlock", "Queue Management") don't map to any
        // permission here on purpose — this codebase has no separate "mic
        // lock" concept (seat lock covers it) and no Queue feature exists
        // at all yet, so no permission is fabricated for it. See
        // MODERATOR_MAX_PERMISSIONS below for the hard cap that keeps this
        // set from ever being widened, even by an Owner's custom grant.
        [ROLES.MODERATOR]: [
            "rooms:view", "rooms:seat-lock", "rooms:kick-user", "rooms:mute-user",
            "reports:view", "reports:handle"
        ]
    };

    // Hard cap on what a Moderator account may ever hold, regardless of
    // DEFAULT_ROLE_PERMISSIONS or a custom `permissions` grant an Owner/
    // Global Super Admin makes through updateAccount(). This directly
    // enforces SRS item 5 ("Moderator must not be able to: Delete Room,
    // Edit Room Settings, Manage Wallet, ... Access Country Management,
    // Access Role & Permission Management, Access AI Core, Access
    // Security/Logs") at the data layer, not just via the default list —
    // so it can't be bypassed by an admin-panel misclick or a future bug
    // in the Role & Country screen.
    const MODERATOR_MAX_PERMISSIONS = [
        "rooms:view", "rooms:seat-lock", "rooms:kick-user", "rooms:mute-user",
        "reports:view", "reports:handle"
    ];
    function clampPermissionsForRole(role, permissions) {
        const list = Array.isArray(permissions) ? permissions.filter((p) => PERMISSIONS.includes(p)) : [];
        if (role === ROLES.MODERATOR) return list.filter((p) => MODERATOR_MAX_PERMISSIONS.includes(p));
        return list;
    }

    // ---------------------------------------------------------------------
    // Account storage
    // ---------------------------------------------------------------------
    let accounts = safeRead(ACCOUNTS_FILE, []); // [{id, username, passwordHash, salt, fullName, role, countryId, assignedRoomIds, permissions, status, createdBy, createdAt, lastLoginAt}]
    let logs = safeRead(LOGS_FILE, []); // [{id, adminId, adminUsername, action, targetType, targetId, countryId, meta, ip, timestamp}]

    function saveAccounts() { safeWrite(ACCOUNTS_FILE, accounts); }
    function saveLogs() { safeWrite(LOGS_FILE, logs); }

    function hashPassword(password, salt) {
        salt = salt || crypto.randomBytes(16).toString("hex");
        const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
        return { hash, salt };
    }
    function verifyPassword(password, salt, hash) {
        const attempt = crypto.scryptSync(String(password), salt, 64).toString("hex");
        try {
            return crypto.timingSafeEqual(Buffer.from(attempt, "hex"), Buffer.from(hash, "hex"));
        } catch (_) {
            return false;
        }
    }

    // Migration: on first boot, turn the existing single ADMIN_USERNAME/
    // ADMIN_PASSWORD into an "owner" account if no owner exists yet. The
    // legacy env-based login keeps working (see server.js login route) —
    // this just also gives that account a first-class RBAC identity so
    // it can create Global/Country Super Admins etc.
    function ensureOwnerAccount(username, password) {
        let owner = accounts.find((a) => a.role === ROLES.OWNER);
        if (owner) return owner;
        const { hash, salt } = hashPassword(password);
        owner = {
            id: "owner-" + crypto.randomBytes(6).toString("hex"),
            username,
            passwordHash: hash,
            salt,
            fullName: "Owner",
            role: ROLES.OWNER,
            countryId: null,
            assignedRoomIds: [],
            permissions: [], // owner = implicit all, not stored
            status: "active",
            createdBy: null,
            createdAt: new Date().toISOString(),
            lastLoginAt: null
        };
        accounts.push(owner);
        saveAccounts();
        return owner;
    }

    function findByUsername(username) {
        return accounts.find((a) => a.username.toLowerCase() === String(username || "").toLowerCase());
    }
    function findById(id) {
        return accounts.find((a) => a.id === id);
    }

    function verifyLogin(username, password) {
        const acc = findByUsername(username);
        if (!acc) return null;
        if (acc.status !== "active") return null;
        if (!verifyPassword(password, acc.salt, acc.passwordHash)) return null;
        acc.lastLoginAt = new Date().toISOString();
        saveAccounts();
        return acc;
    }

    function effectivePermissions(acc) {
        if (!acc) return [];
        if (acc.role === ROLES.OWNER) return PERMISSIONS.slice(); // implicit all
        return acc.permissions && acc.permissions.length ? acc.permissions : (DEFAULT_ROLE_PERMISSIONS[acc.role] || []);
    }

    function hasPermission(acc, permission) {
        if (!acc) return false;
        if (acc.role === ROLES.OWNER) return true;
        return effectivePermissions(acc).includes(permission);
    }

    // Scope check: can `actor` manage/view data belonging to `countryId`?
    function inScope(actor, countryId) {
        if (!actor) return false;
        if (actor.role === ROLES.OWNER || actor.role === ROLES.GLOBAL_SUPER_ADMIN) return true;
        if (!countryId) return true; // country-agnostic resource
        return actor.countryId === countryId;
    }

    // Moderator Room Restriction (RBAC Phase 3, SRS items 1-3): a Moderator
    // may only operate on rooms listed in their own assignedRoomIds. Every
    // other role's room access is already governed by country scope
    // (see inScope/actorCanAccessCountry in server.js) and is untouched by
    // this — it only ever narrows a Moderator, never widens anyone else.
    function inRoomScope(actor, roomId) {
        if (!actor) return false;
        if (actor.role === ROLES.OWNER) return true;
        if (actor.role !== ROLES.MODERATOR) return true; // handled by country scope elsewhere
        if (!roomId) return false;
        return Array.isArray(actor.assignedRoomIds) && actor.assignedRoomIds.includes(roomId);
    }

    function canCreateRole(actorRole, targetRole) {
        return (CAN_CREATE[actorRole] || []).includes(targetRole);
    }

    function createAccount({ creator, username, password, fullName, role, countryId, assignedRoomIds, permissions }) {
        if (!ROLE_RANK.hasOwnProperty(role)) return { success: false, message: "Invalid role" };
        if (!canCreateRole(creator.role, role)) return { success: false, message: "No permission to create this role" };
        if (role !== ROLES.OWNER && role !== ROLES.GLOBAL_SUPER_ADMIN && role !== ROLES.MODERATOR) {
            if (!COUNTRY_IDS.includes(countryId)) return { success: false, message: "A valid Country must be provided" };
        }
        // Non-global creators can only create within their own country
        if (creator.role !== ROLES.OWNER && creator.role !== ROLES.GLOBAL_SUPER_ADMIN) {
            if (countryId && countryId !== creator.countryId) return { success: false, message: "Cannot create an account outside your own country" };
        }
        // Slot limits for super_admin / admin per country
        if (countryId) {
            const countryDef = COUNTRIES.find((c) => c.id === countryId);
            const existingOfRole = accounts.filter((a) => a.countryId === countryId && a.role === role && a.status === "active").length;
            if (role === ROLES.COUNTRY_SUPER_ADMIN && existingOfRole >= countryDef.superAdminSlots) {
                return { success: false, message: `${countryDef.name} Super Admin slots are full (${countryDef.superAdminSlots})` };
            }
            if (role === ROLES.COUNTRY_MANAGER && existingOfRole >= 1) {
                return { success: false, message: `${countryDef.name} already has a Country Manager` };
            }
            if (role === ROLES.ADMIN && existingOfRole >= countryDef.adminSlots) {
                return { success: false, message: `${countryDef.name} Admin slots are full (${countryDef.adminSlots})` };
            }
        }
        if (findByUsername(username)) return { success: false, message: "Username already exists" };

        const { hash, salt } = hashPassword(password);
        const acc = {
            id: role + "-" + crypto.randomBytes(6).toString("hex"),
            username,
            passwordHash: hash,
            salt,
            fullName: fullName || username,
            role,
            countryId: (role === ROLES.OWNER || role === ROLES.GLOBAL_SUPER_ADMIN) ? null : (countryId || null),
            assignedRoomIds: role === ROLES.MODERATOR ? (assignedRoomIds || []) : [],
            permissions: clampPermissionsForRole(role, permissions),
            status: "active",
            createdBy: creator.id,
            createdAt: new Date().toISOString(),
            lastLoginAt: null
        };
        accounts.push(acc);
        saveAccounts();
        return { success: true, account: sanitize(acc) };
    }

    function updateAccount(actor, id, updates) {
        const acc = findById(id);
        if (!acc) return { success: false, message: "Account not found" };
        if (acc.role === ROLES.OWNER && actor.role !== ROLES.OWNER) return { success: false, message: "Permission denied" };
        if (actor.role !== ROLES.OWNER && actor.role !== ROLES.GLOBAL_SUPER_ADMIN && acc.countryId !== actor.countryId) {
            return { success: false, message: "Cannot edit an account outside your own country" };
        }
        if (updates.permissions) acc.permissions = clampPermissionsForRole(acc.role, updates.permissions);
        if (updates.status && ["active", "suspended"].includes(updates.status)) acc.status = updates.status;
        if (updates.fullName) acc.fullName = updates.fullName;
        if (updates.password) { const { hash, salt } = hashPassword(updates.password); acc.passwordHash = hash; acc.salt = salt; }
        if (updates.assignedRoomIds && acc.role === ROLES.MODERATOR) acc.assignedRoomIds = updates.assignedRoomIds;
        saveAccounts();
        return { success: true, account: sanitize(acc) };
    }

    function deleteAccount(actor, id) {
        const acc = findById(id);
        if (!acc) return { success: false, message: "Account not found" };
        if (acc.role === ROLES.OWNER) return { success: false, message: "Owner account cannot be deleted" };
        if (actor.role !== ROLES.OWNER && actor.role !== ROLES.GLOBAL_SUPER_ADMIN && acc.countryId !== actor.countryId) {
            return { success: false, message: "Permission denied" };
        }
        accounts = accounts.filter((a) => a.id !== id);
        saveAccounts();
        return { success: true };
    }

    function listAccounts(actor) {
        let list = accounts;
        if (actor.role !== ROLES.OWNER && actor.role !== ROLES.GLOBAL_SUPER_ADMIN) {
            list = list.filter((a) => a.countryId === actor.countryId);
        }
        return list.map(sanitize);
    }

    function sanitize(acc) {
        const { passwordHash, salt, ...rest } = acc;
        return rest;
    }

    // ---------------------------------------------------------------------
    // Audit Log (RBAC Phase 4) — append-only. Every field the approved SRS
    // asks for is captured here; logAction() is intentionally the ONLY way
    // to add an entry (no updateLog/deleteLog is exported), and this module
    // never exposes a way to mutate or remove an existing entry — that's
    // what "append-only / immutable" means at the code level. `meta` is
    // kept for backward-compatibility with earlier call sites that already
    // passed ad-hoc extra data; new call sites should prefer `before`/
    // `after` for state changes.
    // ---------------------------------------------------------------------
    function logAction({ admin, action, module, targetType, targetId, before, after, meta, ip, userAgent, result, failureReason }) {
        logs.push({
            id: crypto.randomBytes(8).toString("hex"),
            timestamp: new Date().toISOString(),
            adminId: admin ? admin.id : null,
            adminUsername: admin ? admin.username : "system",
            role: admin ? admin.role : null,
            countryId: admin ? admin.countryId : null,
            ip: ip || null,
            userAgent: userAgent || null,
            action,
            module: module || null,
            targetType: targetType || null,
            targetId: targetId || null,
            before: before !== undefined ? before : null,
            after: after !== undefined ? after : null,
            result: result === "failed" ? "failed" : "success",
            failureReason: failureReason || null,
            meta: meta || null
        });
        // Keep the log file from growing unbounded; trim to last 50k entries.
        if (logs.length > 50000) logs = logs.slice(logs.length - 50000);
        saveLogs();
    }

    // Item 6: scope enforcement for who may even call listLogs/exportLogs.
    // Owner → everything. Global Super Admin → everything (per approved
    // SRS, Global Super Admin has the same "all except owner-only" reach
    // as every other module). Country-scoped roles → only their own
    // country's entries. Moderator never reaches here in practice because
    // `security:view-logs` isn't in DEFAULT_ROLE_PERMISSIONS[MODERATOR] and
    // MODERATOR_MAX_PERMISSIONS hard-caps it out even if an Owner tried to
    // grant it by hand (see clampPermissionsForRole) — but this function
    // enforces country-scoping defensively regardless of how it's called.
    function scopedLogs(actor) {
        if (actor.role === ROLES.OWNER || actor.role === ROLES.GLOBAL_SUPER_ADMIN) return logs;
        return logs.filter((l) => l.countryId === actor.countryId);
    }

    // Item 4/5: filtering + pagination + search over the actor's scoped log
    // set. Returns { entries, total, page, pageSize } so the caller can
    // render pagination controls; `total` is the filtered count (not the
    // unfiltered log size).
    function listLogs(actor, opts) {
        opts = opts || {};
        let list = scopedLogs(actor);

        if (opts.dateFrom) { const t = new Date(opts.dateFrom).getTime(); if (!isNaN(t)) list = list.filter((l) => new Date(l.timestamp).getTime() >= t); }
        if (opts.dateTo) { const t = new Date(opts.dateTo).getTime(); if (!isNaN(t)) list = list.filter((l) => new Date(l.timestamp).getTime() <= t); }
        if (opts.countryId) list = list.filter((l) => l.countryId === opts.countryId);
        if (opts.role) list = list.filter((l) => l.role === opts.role);
        if (opts.module) list = list.filter((l) => l.module === opts.module);
        if (opts.action) list = list.filter((l) => l.action === opts.action);
        if (opts.result) list = list.filter((l) => l.result === opts.result);
        if (opts.adminId) list = list.filter((l) => l.adminId === opts.adminId);
        if (opts.adminUsername) list = list.filter((l) => (l.adminUsername || "").toLowerCase() === String(opts.adminUsername).toLowerCase());
        if (opts.targetId) list = list.filter((l) => l.targetId === opts.targetId);
        if (opts.targetType) list = list.filter((l) => l.targetType === opts.targetType);
        if (opts.search) {
            const q = String(opts.search).toLowerCase();
            list = list.filter((l) =>
                (l.action || "").toLowerCase().includes(q) ||
                (l.adminUsername || "").toLowerCase().includes(q) ||
                (l.targetId || "").toLowerCase().includes(q) ||
                (l.module || "").toLowerCase().includes(q) ||
                (l.failureReason || "").toLowerCase().includes(q)
            );
        }

        list = list.slice().reverse(); // newest first
        const total = list.length;
        const page = Math.max(1, parseInt(opts.page) || 1);
        const pageSize = Math.min(500, Math.max(1, parseInt(opts.pageSize) || 50));
        const start = (page - 1) * pageSize;
        const entries = list.slice(start, start + pageSize);
        return { entries, total, page, pageSize };
    }

    // Item 3: "Only Owner can export logs." Returns the actor's full scoped
    // set (no pagination — export is meant to be a complete dump), or null
    // if the actor isn't the Owner. Kept separate from listLogs (rather
    // than an opts.export flag) so the owner-only rule can't accidentally
    // be bypassed by a caller that forgets to check the role.
    function exportLogs(actor, opts) {
        if (actor.role !== ROLES.OWNER) return null;
        opts = opts || {};
        const big = listLogs(actor, Object.assign({}, opts, { page: 1, pageSize: 1000000 }));
        return big.entries;
    }

    // Menu visibility for the admin panel sidebar — maps each existing
    // section (data-section value in admin/index.html) to the permission
    // that unlocks it. If a role lacks the permission, app.js hides the
    // sidebar button entirely.
    const SECTION_PERMISSIONS = {
        "dashboard": "dashboard:view",
        "users": "users:view",
        "rooms": "rooms:view",
        "economy": "economy:view",
        "coin-center": "coin-center:view",
        "frames": "frames:view",
        "tags": "tags:manage",
        "name-effects": "namefx:view",
        "svip-tags": "svip-tags:manage",
        "gift-manager": "gifts:manage",
        "video-gifts": "video-gifts:manage",
        "vehicles": "vehicles:manage",
        "agencies": "agencies:view",
        "announce": "announce:send",
        "chest": "chest:manage",
        "theme-library": "theme-library:manage",
        "banner-management": "banners:manage",
        "super-admin": "godpower:manage",
        "ai-core": "ai-core:view",
        "role-management": "role:manage", // new section
        "ban-management": "ban:view", // Phase 8 — new section
        "coin-sellers": "coin-seller:view", // Wallet "Coin Seller List" management
        "level-management": "level:manage", // ID Level System Upgrade, 2026-08-04
        "badge-management": "badges:manage", // Premium Badge System (Blue Diamond V), see badges.js — permission already existed in PERMISSIONS above, unused until now
        "call-hosting": "callhosting:manage", // Call Hosting System, see callHosting.js
        "merchants": "merchant:view", // Merchant Directory (integration_update/merchant), rbac_extension stage
        "voice-sfu": "voice-sfu:manage", // PHASE 3, STEP 3.6 — SFU voice provider dashboard (readiness/health/rollout), see voice_sfu/index.js. Permission itself already existed since Step 3.2; this just surfaces a sidebar section for it.
        "relationship-settings": "relationships:manage", // Friendship/CP visual settings, see friendshipCp.js
        "payment-recharge": "payment:view" // Payment/Recharge Settings + Packages + Records, see wallet/rechargeService.js. Lowest-bar permission (payment:view) gates section visibility; payment:manage/payment:approve gate individual actions inside it (checked client-side via myAdminProfile.permissions, enforced server-side by each route's own requirePermission)
    };

    return {
        ROLES, ROLE_RANK, CAN_CREATE, COUNTRIES, COUNTRY_IDS, PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, SECTION_PERMISSIONS,
        MODERATOR_MAX_PERMISSIONS,
        ensureOwnerAccount, findByUsername, findById, verifyLogin, effectivePermissions, hasPermission, inScope, inRoomScope,
        canCreateRole, createAccount, updateAccount, deleteAccount, listAccounts, sanitize, logAction, listLogs, exportLogs
    };
}

module.exports = { makeStore };
