// SMS gateway: local Android SIM or remote Termux SMS server

const localGateway = require("./localGateway");

const MODE = (process.env.SMS_GATEWAY_MODE || "local").trim().toLowerCase();
const REMOTE_URL = (process.env.SMS_GATEWAY_URL || "").trim().replace(/\/+$/, "");
const REMOTE_SECRET = (process.env.SMS_GATEWAY_SECRET || "").trim();

async function sendRemoteSms({ to, message }) {
    if (!REMOTE_URL) return { success: false, error: "SMS_GATEWAY_URL is not configured" };
    if (!REMOTE_SECRET) return { success: false, error: "SMS_GATEWAY_SECRET is not configured" };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(REMOTE_URL + "/send-otp", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-secret": REMOTE_SECRET
            },
            body: JSON.stringify({ phone: to, message }),
            signal: controller.signal
        });

        let data = {};
        try { data = await response.json(); } catch (_) {}

        if (!response.ok || data.ok !== true) {
            return {
                success: false,
                error: data.error || ("Remote SMS gateway returned HTTP " + response.status)
            };
        }

        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: error.name === "AbortError"
                ? "Remote SMS gateway timeout"
                : error.message
        };
    } finally {
        clearTimeout(timeout);
    }
}

async function sendSms({ to, message }) {
    if (!to || !message) {
        return { success: false, error: "Missing destination number or message" };
    }

    switch (MODE) {
        case "local":
            return localGateway.sendSms({ to, message });

        case "remote":
            return sendRemoteSms({ to, message });

        default:
            return {
                success: false,
                error: 'Unknown SMS_GATEWAY_MODE "' + MODE + '" — use "local" or "remote"'
            };
    }
}

module.exports = { sendSms };
