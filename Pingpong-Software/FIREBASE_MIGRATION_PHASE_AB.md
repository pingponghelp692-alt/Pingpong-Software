# Firebase Auth Migration — Phase A + B (Complete)

## যা করা হয়েছে (Additive Only)

**Phase A — server/security/firebaseAuth.js (নতুন ফাইল)**
- Firebase Admin SDK init, env var থেকে service account লোড করে (কখনো কোড/গিটে না)
- firebase-admin ইনস্টল না থাকলে বা কনফিগার না থাকলে সার্ভার ক্র্যাশ করবে না —
  শুধু warning log করবে এবং `/api/auth/firebase-login` reject করবে; বাকি সব
  (পুরনো OTP/password login সহ) স্বাভাবিক থাকবে।

**Phase B — server.js-এ নতুন endpoint**
- `POST /api/auth/firebase-login` — body: `{ idToken }`
- পুরনো `/api/auth/send-otp` ও `/api/auth/verify-otp` **অপরিবর্তিত**, একদম
  স্পর্শ করা হয়নি।
- Phone Auth হলে existing `normalizeMobile()` দিয়েই key বানায় — মানে পুরনো
  OTP সিস্টেমে সাইনআপ করা কোনো ইউজার একই নাম্বার দিয়ে Firebase দিয়ে লগইন
  করলে **একই account, একই coins/diamonds/profile** পাবে, ডুপ্লিকেট হবে না।
- Google Sign-In (phone নেই এমন) হলে `google:<uid>` synthetic key ব্যবহার
  করে, ম্যাপিং `data/firebaseLinks.json`-এ রাখে (audit trail-এর জন্য)।
- নতুন ইউজার হলে ঠিক verify-otp-এর মতোই defaults (100 coins, starting
  diamonds ইত্যাদি) দিয়ে তৈরি হয়।
- Login সফল হলে একই `authToken` (existing `userAuth.issueToken`) রিটার্ন
  করে — তাই session/reconnect/socket auth flow-এ কোনো পরিবর্তন লাগবে না।

## আপনার এখন যা করতে হবে (আমার sandbox-এ network নেই)

1. সার্ভারে: `npm install` (package.json-এ `firebase-admin` যোগ করা আছে)
2. Firebase Console → Project Settings → Service Accounts → Generate new
   private key → JSON ডাউনলোড
3. সেই JSON **গিটে কমিট করবেন না** (`.gitignore`-এ যোগ করা আছে)। `.env`-এ
   base64 বা raw JSON বসান — দেখুন `.env.example`
4. Firebase Console-এ Authentication → Sign-in method → Phone ও Google
   দুটো provider enable করুন
5. সার্ভার রিস্টার্ট করলে লগে দেখবেন:
   - `🔥 Firebase Admin SDK initialized` (সফল হলে), অথবা
   - `⚠️ Firebase Admin SDK NOT initialized (...)` (কনফিগার বাকি থাকলে —
     এতে বাকি সার্ভার চলতেই থাকবে)
6. টেস্ট করতে পারেন: `POST /api/auth/firebase-login` একটা বৈধ Firebase
   ID token দিয়ে (client-side Firebase SDK বসানোর আগেও Postman/curl দিয়ে
   টেস্ট করা যায়, client-side Firebase Auth দিয়ে console থেকে token
   জেনারেট করে)।

## পরবর্তী ধাপ (Phase C)

Client-side (`public/index.html` + `app.js`): Firebase SDK যোগ, Phone OTP
+ "Continue with Google" বাটন, পুরনো login UI পাশে রেখেই। এটা শুরু করার
আগে ওপরের সার্ভার-সাইড সেটআপ (ধাপ 1–5) কনফার্ম করুন, যাতে client টেস্ট
করার সময় backend আসলে কাজ করে।

## এখনো অপরিবর্তিত (Phase E পর্যন্ত থাকবে)
- `/api/auth/send-otp`, `/api/auth/verify-otp`, `/api/auth/set-password`
- Password hash logic (`hashPassword`/`verifyPassword`)
- বাকি সব: Room, Coin, Lucky Fruit, Teen Patti, AI, Admin Panel, Ranking — কিছুই ছোঁয়া হয়নি
