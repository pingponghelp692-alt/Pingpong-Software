# Firebase Auth — Root Cause Fix (2026-08-03)

## যা যাচাই করা হয়েছে (আগে থেকেই ঠিক ছিল)
- `.env`-এর `FIREBASE_SERVICE_ACCOUNT_BASE64` decode করে যাচাই করেছি — এটা
  ঠিক আপনার নতুন আপলোড করা `...0d9c28cd48.json`-এর সাথে
  `private_key_id`/`project_id`/`client_email` হুবহু মিলে যায়। Admin SDK
  init কোনো সমস্যা নেই।
- `/api/auth/firebase-login` **আগে থেকেই** `verifyIdToken()`-এর পর স্বয়ংক্রিয়ভাবে
  local user তৈরি করে (কোনো fake/temporary user নেই), existing user-কে
  phone বা UID দিয়ে খুঁজে বের করে, এবং পুরনো OTP login-এর মতোই
  `authToken` + সম্পূর্ণ profile রিটার্ন করে।
- CSP (`security/headers.js`) আগে থেকেই `gstatic.com`, `apis.google.com`,
  `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` allow করে।
- Session restore / reconnect / socket auth flow অপরিবর্তিত এবং অক্ষত।

## যে আসল bug ফিক্স করা হলো (server.js)
`/api/auth/firebase-login`-এ identity resolution আগে শুধু
`decoded.phone_number`-এর presence দেখে ঠিক করত এটা Phone না Google
লগইন। এটা edge case-এ (account linking / claim timing) ভুল key-তে route
করাতে পারত — ফলাফল ঠিক আপনার দেখা উপসর্গ: Google Sign-In সফল হয় কিন্তু
পরে "User not found" দেখায়।

**Fix:** এখন `decoded.firebase.sign_in_provider` (আসল source of truth)
দিয়ে explicit branch করে —
- `provider === "phone"` → normalized phone number দিয়ে match/create
- অন্য যেকোনো provider (google.com ইত্যাদি) → Firebase UID দিয়ে match/create

প্রতিটা লগইনে এখন একটা diagnostic লগ লেখে:
```
🔍 [FIREBASE-AUTH] verified token: uid=..., provider=..., resolved key=..., existingUser=true/false
```
এটা ভবিষ্যতে এই ধরনের সমস্যা তাৎক্ষণিকভাবে ধরতে সাহায্য করবে।

## auth/internal-error (Phone OTP) — এটা কোডের bug নয়
এই এরর Firebase-এর REST call নিজেই reject করলে আসে, app.js/firebaseClient.js
কোড থেকে না। `public/firebaseClient.js`-এ এখন এই এররটা ধরলে আসল কারণ
সরাসরি দেখাবে (Bengali এ), কিন্তু **আসল ফিক্সটা আপনাকে Firebase Console/
Google Cloud Console-এ করতে হবে:**

1. **Authentication → Sign-in method** → Phone ✅ enabled, Google ✅ enabled
2. **Authentication → Settings → Authorized domains** — আপনার সার্ভার যে
   ডোমেইনে চলছে (Termux + ngrok/cloudflared tunnel হলে সেই exact ডোমেইন)
   এই তালিকায় আছে কিনা। `localhost` শুধু লোকাল টেস্টের জন্য যথেষ্ট, আসল
   ডিভাইস/ডোমেইনের জন্য না।
3. **Google Cloud Console → APIs & Services** → "Identity Toolkit API" এবং
   "Token Service API" enabled আছে কিনা।
4. **reCAPTCHA Enterprise** — যদি আপনার Cloud project-এ reCAPTCHA
   Enterprise API enabled থাকে, সেটা Firebase Authentication → Settings →
   SMS Toll Fraud Protection-এর সাথে link করা লাগবে, নাহলে disable করে
   classic reCAPTCHA-তে fallback করুন।
5. **Billing** — কিছু region-এ Phone Auth-এর জন্য Blaze (pay-as-you-go)
   plan লাগে; Spark (free) plan-এ কাজ নাও করতে পারে।

DevTools Console-এ এখন এই এররগুলো এলে ঠিক কোন settings চেক করতে হবে সেটা
সরাসরি দেখাবে (আগে শুধু "internal-error" দেখাতো)।

## Boot verification (honesty note)
আমার sandbox-এ network বন্ধ, তাই `npm install` বা `node server.js`
আসলেই চালিয়ে live boot test করতে পারিনি। কিন্তু:
- প্রতিটা `.js` ফাইল (`node --check`) syntax-valid ✅
- `.env`-এর credential ও uploaded service account key হুবহু মিলেছে ✅
- আপনার সার্ভারে রিস্টার্ট করার পর এই লগ দেখুন:
  ```
  🔥 Firebase Admin SDK initialized (project: ping-pong-voice-chat-24a27)
  ```
- লগইন টেস্ট করার সময় প্রতিটা attempt-এ এই নতুন লাইনটা দেখবেন সার্ভার
  কনসোলে (Phone বা Google, existingUser true/false):
  ```
  🔍 [FIREBASE-AUTH] verified token: uid=..., provider=..., resolved key=..., existingUser=...
  ```
  যদি Google লগইনের পরও `existingUser=false` বারবার আসে প্রতি লগইনে
  (একই uid-এর জন্য), সেটা মানে key তৈরি হচ্ছে কিন্তু save হচ্ছে না —
  তখন `data/firebaseLinks.json` ও `data/users.json` write permission
  চেক করুন (Termux storage permission)।

## পরিবর্তিত ফাইল
- `server.js` — identity resolution fix + diagnostic log
- `public/firebaseClient.js` — actionable error-code decoding
- `public/index.html` — firebaseClient.js cache-busting version bump

## অপরিবর্তিত
Room, Coin, Lucky Fruit, Teen Patti, AI, Admin Panel, Ranking, RBAC,
পুরনো OTP/password endpoints — কিছুই ছোঁয়া হয়নি।
