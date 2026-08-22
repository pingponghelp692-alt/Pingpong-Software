# Local SMS Gateway (Termux:API) — Setup

PingPong's mobile-number login now generates and verifies OTPs entirely on
this server (`security/otpService.js`) and delivers them exclusively through
**this device's own Android SIM**, using the Termux:API add-on
(`sms/localGateway.js`). No Firebase Phone Auth, no third-party SMS API
(Twilio/MSG91/Vonage/AWS SNS/etc.) is used anywhere in this flow.

## 1. Install the Termux:API companion app

Install **Termux:API** from **F-Droid** — not the Play Store. It must come
from the same source (F-Droid vs Play) as the Termux app running the
PingPong server itself, or the two apps cannot talk to each other.

- F-Droid: https://f-droid.org/packages/com.termux.api/

## 2. Install the CLI package inside Termux

```bash
pkg update
pkg install termux-api
```

This installs the `termux-sms-send` command that `sms/localGateway.js`
calls (via `execFile`, with arguments passed as an array — never a shell
string, so OTP text/phone numbers can't be used for command injection).

## 3. Grant the SMS permission

A headless/background call to `termux-sms-send` will **not** trigger
Android's runtime permission prompt. Grant it manually:

Android **Settings → Apps → Termux:API → Permissions → SMS → Allow**

## 4. Confirm a working SIM

The device must have an active SIM with SMS service. Test manually first:

```bash
termux-sms-send -n "+919876543210" "PingPong gateway test"
```

If that command fails, `sms/localGateway.js` will also fail — fix it at
this level before relying on the app.

## 5. Configure environment variables

In `.env` (see `.env.example`):

```
OTP_LENGTH=6
OTP_TTL_SECONDS=300
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SECONDS=60
SMS_GATEWAY_MODE=local
SMS_SENDER_NAME=PingPong
```

`SMS_GATEWAY_MODE=local` is currently the only implemented mode — no cloud
provider exists in this codebase.

## How it behaves when the gateway is unavailable

`sms/localGateway.js` checks whether `termux-sms-send` is on `PATH` before
every send, and `sms/gateway.js` / `security/otpService.js` **never**
report an OTP as delivered unless the command itself exits successfully.
If the gateway is down (Termux:API not installed, permission not granted,
no SIM, etc.), `/api/auth/send-otp` returns
`{ success: false, code: "sms-gateway-unavailable" }` and the OTP is
immediately invalidated server-side — the client is told to retry rather
than silently trusting a code that was never actually sent.

## Architecture

```
Browser (public/index.html + app.js)
        |  POST /api/auth/send-otp { mobile }
        v
server.js
        |  otpService.issueOtp(mobile)      security/otpService.js
        |  smsGateway.sendSms({to, message}) sms/gateway.js
        v
sms/localGateway.js
        |  termux-sms-send -n <to> <message>
        v
Termux:API  ->  Android SmsManager  ->  this device's SIM  ->  recipient
```

`sms/gateway.js` is the only entry point the auth code is allowed to call
for delivery — if a different delivery mechanism is ever needed, add a new
`SMS_GATEWAY_MODE` branch there rather than calling a provider directly
from `server.js` or `security/otpService.js`.
