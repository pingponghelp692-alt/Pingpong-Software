// ==================================================
// LOCAL SMS GATEWAY — Termux:API (this device's own Android SIM)
// ==================================================
// Sends SMS through THIS device's own SIM via the Termux:API add-on. No
// cloud provider, no third-party SMS API — see sms/gateway.js. Full setup
// steps are in docs/LOCAL_SMS_GATEWAY.md; summary:
//
//   1. Install the "Termux:API" companion Android app (F-Droid build,
//      matching whichever Termux build — F-Droid or Play — the server
//      itself runs under; mismatched signing sources will not talk to
//      each other).
//   2. Inside Termux:  pkg install termux-api
//   3. Grant the SMS permission to the Termux:API app under Android
//      Settings -> Apps -> Termux:API -> Permissions (a headless/background
//      call will not trigger Android's runtime permission prompt itself).
//   4. A physical SIM with active SMS service must be present in the
//      device this server process runs on.
//
// This module NEVER reports success unless the underlying `termux-sms-send`
// command itself exits 0 — it does not simulate, assume, or fake delivery
// under any circumstance (per the self-hosted-OTP requirement: a failed
// send must never be treated as a delivered OTP).

const { execFile } = require("child_process");
const util = require("util");
const execFileAsync = util.promisify(execFile);

const BIN = "termux-sms-send";

let availabilityChecked = false;
let available = false;

async function checkAvailable() {
    if (availabilityChecked) return available;
    availabilityChecked = true;
    try {
        // We only care whether the binary exists on PATH (ENOENT) — any
        // other exit behavior (e.g. printing usage because required args
        // are missing) still proves the binary itself is present.
        await execFileAsync(BIN, ["--help"], { timeout: 5000 }).catch((err) => {
            if (err && err.code === "ENOENT") throw err;
        });
        available = true;
    } catch (err) {
        available = false;
        if (err && err.code === "ENOENT") {
            console.error(
                `❌ [SMS-GATEWAY] "${BIN}" not found on PATH. Install Termux:API ` +
                `(pkg install termux-api) and the Termux:API companion app, then grant it ` +
                `SMS permission. See docs/LOCAL_SMS_GATEWAY.md for the full setup.`
            );
        } else {
            console.error(`❌ [SMS-GATEWAY] availability check for "${BIN}" failed:`, err.message);
        }
    }
    return available;
}

/**
 * @param {{to: string, message: string}} params
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendSms({ to, message }) {
    const ok = await checkAvailable();
    if (!ok) {
        return {
            success: false,
            error: "Local SMS gateway unavailable — Termux:API is not installed/configured on this device"
        };
    }
    try {
        // Arguments are passed as an array to execFile (not a shell
        // string), so the destination number or message content can never
        // be used for shell/command injection regardless of what either
        // one contains.
        await execFileAsync(BIN, ["-n", String(to), String(message)], { timeout: 20_000 });
        // Deliberately do not log `message` — it contains the plaintext OTP.
        console.log("[otp] SMS gateway accepted");
        return { success: true };
    } catch (err) {
        console.error(`❌ [SMS-GATEWAY] ${BIN} failed:`, err.message);
        return {
            success: false,
            error: "SMS send failed — check SIM presence, signal, and Termux:API SMS permission on the gateway device"
        };
    }
}

module.exports = { sendSms, checkAvailable };
