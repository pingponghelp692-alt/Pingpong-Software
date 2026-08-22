const localGateway = require("./localGateway");

const MODE = (process.env.SMS_GATEWAY_MODE || "local").toLowerCase();
const REMOTE_URL = (process.env.SMS_GATEWAY_URL || "").replace(/\/+$/, "");
const SECRET = process.env.SMS_API_SECRET || "";

async function sendRemoteSms({ to, message }) {
    if (!REMOTE_URL) return { success: false, error: "SMS_GATEWAY_URL is not configured" };
    if (!SECRET) return { success: false, error: "SMS_API_SECRET is not configured" };

    try {
        const response = await fetch(`${REMOTE_URL}/send-sms`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${SECRET}`
            },
            body: JSON.stringify({ phone: String(to), message: String(message) }),
            signal: AbortSignal.timeout(25000)
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.success) {
            return {
                success: false,
                error: data.error || `Remote SMS gateway HTTP ${response.status}`
            };
        }

        console.log("[otp] Remote SMS gateway accepted");
        return { success: true };
    } catch (err) {
        console.error("[SMS-GATEWAY] Remote gateway failed:", err.message);
        return { success: false, error: "Remote SMS gateway unavailable" };
    }
}

async function sendSms({ to, message }) {
    if (!to || !message) {
        return { success: false, error: "Missing destination number or message" };
    }

    if (MODE === "remote") return sendRemoteSms({ to, message });
    if (MODE === "local") return localGateway.sendSms({ to, message });

    return { success: false, error: `Unknown SMS_GATEWAY_MODE "${MODE}"` };
}

module.exports = { sendSms };
