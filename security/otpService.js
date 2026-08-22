// ==================================================
// SELF-HOSTED OTP SERVICE (2026-08-16)
// ==================================================
// Replaces Firebase Phone Auth AND the old insecure Math.random()/
// console.log OTP store. Additive, self-contained module — same
// initX({deps}) dependency-injection pattern as svip.js/banManagement.js.
// server.js calls initOtpService({ DATA_FOLDER, safeRead, safeWrite }) once
// and wires the returned functions into /api/auth/send-otp and
// /api/auth/verify-otp. This module does not know about Express, sockets,
// users, or SMS delivery — it only owns OTP lifecycle. Delivery is a
// separate concern (see sms/gateway.js).
//
// Security properties:
//   - OTP generated with crypto.randomInt — never Math.random()
//   - only a salted HMAC-SHA256 hash of the OTP is ever stored/persisted —
//     the plaintext OTP exists only in memory for the single instant it is
//     generated and handed to the caller (to pass to the SMS gateway); it
//     is never logged, never returned in any HTTP response, never written
//     to disk
//   - 5 minute default expiry (OTP_TTL_SECONDS), single-use — deleted the
//     moment it is verified successfully OR a new one is issued for the
//     same mobile
//   - resend cooldown (default 60s, OTP_RESEND_COOLDOWN_SECONDS) — separate
//     from the IP/mobile request-rate limiter already applied at the route
//     level (security/rateLimiter.js otpLimiter)
//   - max attempts per OTP (default 5, OTP_MAX_ATTEMPTS) — on top of the
//     existing security/bruteForce.js progressive lockout already wired
//     into /api/auth/verify-otp
//   - constant-time hash comparison (crypto.timingSafeEqual)
//   - restart-safe: persisted through this project's existing atomic
//     temp-file-then-rename safeWrite/safeRead helpers (perf/writeQueue.js),
//     same pattern every other stateful module in this codebase uses —
//     NOT a plain in-memory object that a Termux/Android process kill would
//     silently wipe
//   - auto-purged: a periodic sweep removes expired records so this file
//     never grows unbounded; nothing is stored permanently

const crypto = require("crypto");
const path = require("path");

function initOtpService({ DATA_FOLDER, safeRead, safeWrite } = {}) {
    if (!DATA_FOLDER || !safeRead || !safeWrite) {
        throw new Error("initOtpService requires { DATA_FOLDER, safeRead, safeWrite }");
    }

    const OTP_FILE = path.join(DATA_FOLDER, "otpStore.json");

    function envInt(name, fallback) {
        const raw = process.env[name];
        if (raw === undefined || raw === "") return fallback;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : fallback;
    }

    const OTP_LENGTH = envInt("OTP_LENGTH", 6);
    const OTP_TTL_MS = envInt("OTP_TTL_SECONDS", 300) * 1000;
    const OTP_MAX_ATTEMPTS = envInt("OTP_MAX_ATTEMPTS", 5);
    const RESEND_COOLDOWN_MS = envInt("OTP_RESEND_COOLDOWN_SECONDS", 60) * 1000;

    // mobile -> { hash, salt, expiresAt, attempts, createdAt, requestId }
    // NOTE: values here are hashes only — see hashOtp() below. Nothing in
    // this object is ever the plaintext OTP.
    let store = safeRead(OTP_FILE, {});

    function persist(opts) {
        safeWrite(OTP_FILE, store, opts || { immediate: false });
    }

    function purgeExpired() {
        const now = Date.now();
        let changed = false;
        for (const mobile in store) {
            if (store[mobile].expiresAt <= now) {
                delete store[mobile];
                changed = true;
            }
        }
        if (changed) persist({ immediate: false });
    }
    setInterval(purgeExpired, 60 * 1000).unref();

    function hashOtp(otp, salt) {
        return crypto.createHmac("sha256", salt).update(String(otp)).digest("hex");
    }

    function constantTimeEqual(hexA, hexB) {
        try {
            const bufA = Buffer.from(String(hexA), "hex");
            const bufB = Buffer.from(String(hexB), "hex");
            if (bufA.length !== bufB.length) return false;
            return crypto.timingSafeEqual(bufA, bufB);
        } catch (err) {
            return false;
        }
    }

    // crypto.randomInt(max) — cryptographically secure, uniform, and the
    // exact function the project's Lucky Fruit/Fruit Wheel RNG fix already
    // standardized on elsewhere in this codebase. Never Math.random().
    function generateNumericOtp(length) {
        const max = 10 ** length;
        const n = crypto.randomInt(0, max);
        return String(n).padStart(length, "0");
    }

    // Never log a full phone number next to OTP activity — masked form only.
    function maskMobile(mobile) {
        const s = String(mobile || "");
        if (s.length <= 4) return "*".repeat(s.length);
        return "*".repeat(s.length - 4) + s.slice(-4);
    }

    /** Returns { ok:true } or { ok:false, code:"resend-cooldown", retryAfterSec }. */
    function checkResendCooldown(mobile) {
        const rec = store[mobile];
        if (!rec) return { ok: true };
        const elapsed = Date.now() - rec.createdAt;
        if (elapsed < RESEND_COOLDOWN_MS) {
            return { ok: false, code: "resend-cooldown", retryAfterSec: Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000) };
        }
        return { ok: true };
    }

    /**
     * Generates and stores a new OTP for `mobile`, invalidating any
     * previous one for the same number (one active OTP per mobile at a
     * time). Does NOT send it anywhere — the caller (server.js) is
     * responsible for handing `otp` to the SMS gateway and must only tell
     * the client "OTP sent" once delivery has actually succeeded; on
     * delivery failure the caller should call revokeOtp() below.
     *
     * Returns either:
     *   { otp, requestId }                              on success
     *   { error: { code:"resend-cooldown", retryAfterSec } }  if still cooling down
     */
    function issueOtp(mobile) {
        const cooldown = checkResendCooldown(mobile);
        if (!cooldown.ok) return { error: cooldown };

        const otp = generateNumericOtp(OTP_LENGTH);
        const salt = crypto.randomBytes(16).toString("hex");
        const requestId = crypto.randomBytes(12).toString("hex");
        store[mobile] = {
            hash: hashOtp(otp, salt),
            salt,
            expiresAt: Date.now() + OTP_TTL_MS,
            attempts: 0,
            createdAt: Date.now(),
            requestId
        };
        // Immediate (not debounced) write: an OTP is high-value/low-frequency
        // (rate-limited to a handful per 10 minutes per number, see
        // security/rateLimiter.js otpLimiter), and this server can run on a
        // Termux/Android process that gets killed without a graceful
        // SIGTERM — the same restart-safety reasoning already applied to
        // new-account creation in server.js.
        persist({ immediate: true });
        console.log(`[otp] OTP generated for ${maskMobile(mobile)} (requestId=${requestId}, ttl=${Math.round(OTP_TTL_MS / 1000)}s)`);
        return { otp, requestId };
    }

    /**
     * Verifies `submittedOtp` against the stored record for `mobile`.
     * Returns { success:true } or { success:false, code, attemptsLeft? }
     * where code is one of: "not-found" | "expired" | "too-many-attempts" | "wrong-otp"
     */
    function verifyOtp(mobile, submittedOtp) {
        const rec = store[mobile];
        if (!rec) return { success: false, code: "not-found" };

        if (rec.expiresAt <= Date.now()) {
            delete store[mobile];
            persist({ immediate: false });
            return { success: false, code: "expired" };
        }
        if (rec.attempts >= OTP_MAX_ATTEMPTS) {
            delete store[mobile];
            persist({ immediate: false });
            return { success: false, code: "too-many-attempts" };
        }

        const candidateHash = hashOtp(submittedOtp, rec.salt);
        if (!constantTimeEqual(candidateHash, rec.hash)) {
            rec.attempts += 1;
            persist({ immediate: false });
            return { success: false, code: "wrong-otp", attemptsLeft: Math.max(0, OTP_MAX_ATTEMPTS - rec.attempts) };
        }

        // Single-use: invalidate immediately on success so this exact code
        // can never be replayed, even within its remaining TTL window.
        delete store[mobile];
        persist({ immediate: true });
        console.log(`[otp] verification successful for ${maskMobile(mobile)} (requestId=${rec.requestId})`);
        return { success: true };
    }

    /**
     * Voids an issued-but-undelivered OTP (e.g. the SMS gateway reported a
     * send failure). Optional requestId guards against racily revoking a
     * *newer* OTP that may have been issued for the same mobile in the
     * meantime.
     */
    function revokeOtp(mobile, requestId) {
        const rec = store[mobile];
        if (rec && (!requestId || rec.requestId === requestId)) {
            delete store[mobile];
            persist({ immediate: true });
        }
    }

    return {
        issueOtp,
        verifyOtp,
        revokeOtp,
        checkResendCooldown,
        maskMobile,
        OTP_LENGTH,
        OTP_TTL_MS,
        OTP_MAX_ATTEMPTS,
        RESEND_COOLDOWN_MS
    };
}

module.exports = { initOtpService };
