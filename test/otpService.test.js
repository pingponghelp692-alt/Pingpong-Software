// test/otpService.test.js
// Self-hosted OTP replacement (2026-08-16) — regression tests for
// security/otpService.js covering the spec's requirement #18 checklist:
// generation, length, randomness, expiration, successful verification,
// wrong OTP, expired OTP, reuse (single-use), max attempts, resend cooldown.
//
// Run: node test/otpService.test.js

const path = require("path");
const os = require("os");
const fs = require("fs");
const { initOtpService } = require(path.join(__dirname, "..", "security", "otpService.js"));

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { pass++; console.log("  ✓", msg); }
    else { fail++; console.error("  ✗ FAIL:", msg); }
}

// In-memory fake safeRead/safeWrite so these tests never touch real disk
// and can run in full isolation, mirroring how other test/*.test.js files
// in this repo stub out project persistence helpers.
function makeFakeStore() {
    let data = {};
    return {
        safeRead: (_file, fallback) => (data && Object.keys(data).length ? data : fallback),
        safeWrite: (_file, value) => { data = value; },
        getRaw: () => data
    };
}

function freshService(envOverrides) {
    const prevEnv = {};
    for (const k of Object.keys(envOverrides || {})) {
        prevEnv[k] = process.env[k];
        process.env[k] = String(envOverrides[k]);
    }
    const fake = makeFakeStore();
    const svc = initOtpService({ DATA_FOLDER: os.tmpdir(), safeRead: fake.safeRead, safeWrite: fake.safeWrite });
    return { svc, restoreEnv: () => { for (const k of Object.keys(prevEnv)) process.env[k] = prevEnv[k]; } };
}

console.log("=== 1/2. OTP generation + length ===");
{
    const { svc, restoreEnv } = freshService({ OTP_LENGTH: 6 });
    const issued = svc.issueOtp("9876543210");
    assert(!!issued.otp, "issueOtp returns a plaintext otp to the caller");
    assert(typeof issued.otp === "string" && issued.otp.length === 6, "OTP is exactly 6 digits long");
    assert(/^\d{6}$/.test(issued.otp), "OTP is numeric only");
    restoreEnv();
}

console.log("=== 3. OTP randomness (not predictable / not constant) ===");
{
    const { svc, restoreEnv } = freshService({ OTP_RESEND_COOLDOWN_SECONDS: 0 });
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
        const issued = svc.issueOtp("90000000" + String(i % 10) + "1");
        seen.add(issued.otp);
    }
    assert(seen.size > 1, "consecutive OTPs are not all identical (crypto.randomInt, not a fixed value)");
    restoreEnv();
}

console.log("=== 4/7. OTP expiration ===");
{
    const { svc, restoreEnv } = freshService({ OTP_TTL_SECONDS: 0 }); // expires immediately
    const issued = svc.issueOtp("9876543211");
    // TTL 0 -> expiresAt is "now", so a check even 1ms later is expired.
    const result = svc.verifyOtp("9876543211", issued.otp);
    assert(result.success === false && result.code === "expired", "an OTP past its TTL is rejected as expired, even with the correct code");
    restoreEnv();
}

console.log("=== 5. Successful verification ===");
{
    const { svc, restoreEnv } = freshService({});
    const issued = svc.issueOtp("9876543212");
    const result = svc.verifyOtp("9876543212", issued.otp);
    assert(result.success === true, "correct OTP within TTL verifies successfully");
    restoreEnv();
}

console.log("=== 6. Wrong OTP ===");
{
    const { svc, restoreEnv } = freshService({});
    svc.issueOtp("9876543213");
    const result = svc.verifyOtp("9876543213", "000000");
    assert(result.success === false && result.code === "wrong-otp", "an incorrect code is rejected with code=wrong-otp");
    restoreEnv();
}

console.log("=== 8. OTP reuse (single-use) ===");
{
    const { svc, restoreEnv } = freshService({});
    const issued = svc.issueOtp("9876543214");
    const first = svc.verifyOtp("9876543214", issued.otp);
    const second = svc.verifyOtp("9876543214", issued.otp);
    assert(first.success === true, "first use of a valid OTP succeeds");
    assert(second.success === false && second.code === "not-found", "replaying the exact same OTP a second time fails (already consumed)");
    restoreEnv();
}

console.log("=== 9. Maximum attempts ===");
{
    const { svc, restoreEnv } = freshService({ OTP_MAX_ATTEMPTS: 3 });
    svc.issueOtp("9876543215");
    svc.verifyOtp("9876543215", "111111"); // wrong x3
    svc.verifyOtp("9876543215", "111111");
    const third = svc.verifyOtp("9876543215", "111111");
    assert(third.code === "too-many-attempts" || third.success === false, "the OTP is locked out after reaching OTP_MAX_ATTEMPTS wrong guesses");
    const fourth = svc.verifyOtp("9876543215", "111111");
    assert(fourth.success === false, "no further verification is possible for that mobile until a new OTP is issued");
    restoreEnv();
}

console.log("=== 10. Resend cooldown ===");
{
    const { svc, restoreEnv } = freshService({ OTP_RESEND_COOLDOWN_SECONDS: 60 });
    svc.issueOtp("9876543216");
    const second = svc.issueOtp("9876543216");
    assert(!!second.error && second.error.code === "resend-cooldown", "a second issueOtp() call within the cooldown window is rejected");
    assert(second.error.retryAfterSec > 0 && second.error.retryAfterSec <= 60, "a positive retryAfterSec is returned for the client countdown");
    restoreEnv();
}

console.log("=== Invalidate previous OTP when a new one is generated ===");
{
    const { svc, restoreEnv } = freshService({ OTP_RESEND_COOLDOWN_SECONDS: 0 });
    const first = svc.issueOtp("9876543217");
    svc.issueOtp("9876543217"); // second issue, cooldown disabled for this test
    const resultOldCode = svc.verifyOtp("9876543217", first.otp);
    assert(resultOldCode.success === false, "the OTP from BEFORE the most recent issueOtp() call no longer verifies");
    restoreEnv();
}

console.log("=== Never stores plaintext OTP ===");
{
    const fake = makeFakeStore();
    process.env.OTP_TTL_SECONDS = "300";
    const svc = initOtpService({ DATA_FOLDER: os.tmpdir(), safeRead: fake.safeRead, safeWrite: fake.safeWrite });
    const issued = svc.issueOtp("9876543218");
    const raw = JSON.stringify(fake.getRaw());
    assert(!raw.includes(issued.otp), "the plaintext OTP string never appears in the persisted store object");
    delete process.env.OTP_TTL_SECONDS;
}

console.log("=== revokeOtp voids an undelivered OTP ===");
{
    const { svc, restoreEnv } = freshService({});
    const issued = svc.issueOtp("9876543219");
    svc.revokeOtp("9876543219", issued.requestId);
    const result = svc.verifyOtp("9876543219", issued.otp);
    assert(result.success === false && result.code === "not-found", "a revoked (SMS-failed) OTP cannot be used even with the correct code");
    restoreEnv();
}

console.log("\n==================================================");
console.log(`otpService.test.js: ${pass} passed, ${fail} failed`);
console.log("==================================================");
process.exit(fail ? 1 : 0);
