// ==================================================
// SMS GATEWAY — abstraction layer (2026-08-16)
// ==================================================
// This is the ONLY entry point the authentication system (server.js /
// security/otpService.js) is allowed to call for SMS delivery. It
// dispatches to a concrete provider based on SMS_GATEWAY_MODE.
//
// Only "local" is implemented — this server's own Android/Termux SIM (see
// localGateway.js). There is intentionally no cloud/third-party SMS API
// branch (no Twilio/MSG91/Vonage/AWS SNS/etc.) anywhere in this file or
// this project, per the self-hosted-OTP requirement. Do not add one without
// revisiting that requirement first.

const localGateway = require("./localGateway");

const MODE = process.env.SMS_GATEWAY_MODE || "local";

/**
 * @param {{to: string, message: string}} params - `to` should already be
 *   in the form the local gateway expects (e.g. "+919876543210").
 * @returns {Promise<{success: boolean, error?: string}>}
 *   `success` is true ONLY when the underlying gateway actually accepted
 *   the send request — this function never fabricates a success result.
 */
async function sendSms({ to, message }) {
    if (!to || !message) {
        return { success: false, error: "Missing destination number or message" };
    }
    switch (MODE) {
        case "local":
            return localGateway.sendSms({ to, message });
        default:
            return { success: false, error: `Unknown SMS_GATEWAY_MODE "${MODE}" — only "local" is implemented` };
    }
}

module.exports = { sendSms };
