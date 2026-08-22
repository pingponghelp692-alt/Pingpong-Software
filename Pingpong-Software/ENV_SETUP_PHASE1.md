# .env setup — Phase 1 (LiveKit / Vapi / Firebase / AI)

Copy `.env.example` to `.env` and fill these in. Never commit `.env` — it's already
excluded from this delivered ZIP, same as always.

## LiveKit (voice SFU)
```
LIVEKIT_URL=wss://YOUR-PROJECT.livekit.cloud
LIVEKIT_API_KEY=YOUR_LIVEKIT_API_KEY
LIVEKIT_API_SECRET=YOUR_LIVEKIT_API_SECRET
VOICE_MODE=sfu
```
Get these from the LiveKit Cloud dashboard (Settings → Keys) for your own project.
Paste real values only into your own `.env` on your device — never into chat, a
doc file, or anything that ends up in a delivered ZIP. If a LiveKit key/secret has
ever been pasted into a chat or screenshot, treat it as compromised and regenerate
a fresh one from the dashboard before using it.

## Vapi (Robin voice support)
```
VAPI_PUBLIC_KEY=REPLACE_WITH_VAPI_PUBLIC_KEY
VAPI_ASSISTANT_ID=3ec88d92-7146-4531-a26d-b790edf51f70
VAPI_DEMO_URL=https://vapi.ai/?demo=true&shareKey=f3ac552d-b25f-4afc-98a0-b64eeab0fc16&assistantId=3ec88d92-7146-4531-a26d-b790edf51f70
```
These are already the values baked into `server.js` as defaults too, so Robin will
work even without setting them explicitly — but setting them in `.env` is still
correct practice (keeps `server.js` free of environment-specific values).

## Firebase Admin SDK — CORRECTED (this was wrong in the earlier version of this file)
`security/firebaseAuth.js` reads credentials in this exact priority order:
1. `FIREBASE_SERVICE_ACCOUNT_BASE64` — the **whole service-account JSON file,
   base64-encoded, as one line**. This is what the login error you saw is asking for
   by name, and it's exactly the format of what you already pasted in chat earlier.
2. `FIREBASE_SERVICE_ACCOUNT_JSON` — the raw JSON as one line (alternative to #1).
3. `GOOGLE_APPLICATION_CREDENTIALS` — a filesystem path to the JSON file (only
   works if that file exists on disk; this is what I incorrectly told you to use
   before — it's a valid fallback, but not the primary/simplest option, and I hadn't
   actually checked `firebaseAuth.js` yet when I wrote it).

**To fix it**, add ONE line to your `.env`:
```
FIREBASE_SERVICE_ACCOUNT_BASE64=<the base64 string from Firebase Console>
```
The project ID in that service account must be `ping-pong-voice-chat-24a27` — the
code checks this explicitly at startup and logs a clear warning if it's from the
wrong Firebase project (a common silent cause of login failing even when the token
itself verifies fine).

You already pasted this exact base64 value in this chat earlier — I decoded and
saved it locally but did not put it in this ZIP or repeat it here (I don't re-echo
secrets). You can paste that same value into `.env` yourself. If you'd rather not
reuse a credential that went through chat, regenerate a fresh one from
**Firebase Console → Project Settings → Service Accounts → Generate new private
key**, then base64-encode that new file yourself, e.g. on Termux:
```
base64 -w0 firebase-service-account.json
```
and paste the output as the value of `FIREBASE_SERVICE_ACCOUNT_BASE64`.

Once set, restart the server — you should see in the logs:
```
🔥 Firebase Admin SDK initialized (project: ping-pong-voice-chat-24a27) — Firebase login endpoint is live.
```

## AI (Gemini/OpenAI) — you have not provided these yet
```
AI_PROVIDER=gemini
GEMINI_API_KEY=<your real key>
# optional automatic fallback if Gemini fails:
OPENAI_API_KEY=<your real key>
AI_FALLBACK_PROVIDER=openai
```
Without at least `GEMINI_API_KEY` (or `OPENAI_API_KEY` with `AI_PROVIDER=openai`),
Room 101 text replies will always show the safe fallback message, not a real AI
answer — this is expected/by design, not a bug, until a key is added.

## Startup (unchanged)
```
cd pingpong_final_work
npm install
npm run start
```
