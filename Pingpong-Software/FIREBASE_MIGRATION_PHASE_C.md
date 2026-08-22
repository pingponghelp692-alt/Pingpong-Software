# Firebase Auth Migration — Phase C (Complete)

## যা করা হয়েছে

**public/index.html**
- Password login card ও "Create Password" card **UI থেকে সরানো হয়েছে**
- Mobile Number + OTP card একই ডিজাইন/CSS class-এ রাখা হয়েছে (শুধু ভেতরের
  ওয়্যারিং বদলেছে — এখন Firebase Phone Auth ব্যবহার করে)
- নতুন "Continue with Google" বাটন যোগ (একই auth-card-এর নিচে, "or" divider সহ)
- একটা invisible `#recaptcha-container` যোগ (Firebase Phone Auth-এর জন্য
  আবশ্যক — এটা দৃশ্যমান নয়, ডিজাইন বদলায় না)
- Firebase compat SDK (`firebase-app-compat.js`, `firebase-auth-compat.js`)
  ও নতুন `firebaseClient.js` script tag যোগ

**public/firebaseClient.js (নতুন ফাইল)**
- আপনার দেওয়া `firebaseConfig` দিয়ে init
- `sendPhoneOtp()`, `verifyPhoneOtp()`, `signInWithGoogle()` — এই তিনটা
  ফাংশন `window.ppFirebaseAuth`-এ export করে, app.js এগুলো কল করে

**public/app.js**
- পুরনো password-login handlers (`btn-password-login`, `btn-create-password`
  ইত্যাদি) সরানো হয়েছে — কারণ সংশ্লিষ্ট UI element-ই আর নেই
- `btn-send-otp` → এখন `ppFirebaseAuth.sendPhoneOtp()` কল করে (পুরনো
  `/api/auth/send-otp` আর কল হয় না)
- `btn-verify-otp` → এখন `ppFirebaseAuth.verifyPhoneOtp()` দিয়ে OTP
  confirm করে, তারপর `/api/auth/firebase-login`-এ idToken পাঠায়
- নতুন `btn-google-login` → `ppFirebaseAuth.signInWithGoogle()` →
  `/api/auth/firebase-login`
- **Login সফল হওয়ার পরের পুরো path অপরিবর্তিত**: `saveSession()`,
  `connectSocket()`, `enterApp()` — ঠিক আগের মতোই। তাই refresh/reconnect-এর
  পরে auto-login, room rejoin, socket auth — সবকিছু আগের মতোই কাজ করবে,
  কোনো পরিবর্তন লাগেনি।

**public/style.css**
- শুধু নতুন divider ও Google বাটনের জন্য ছোট কিছু CSS যোগ, existing কোনো
  rule পরিবর্তন হয়নি

## অপরিবর্তিত (verify করে দেখুন কিছু ভাঙেনি)
- Room, Coin, Lucky Fruit, Teen Patti, AI, Admin Panel, Ranking, Profile —
  কোনো কোড এই Phase-এ ছোঁয়া হয়নি
- Server-side পুরনো `/api/auth/send-otp`, `/api/auth/verify-otp`,
  `/api/auth/set-password`, password hash logic — এখনো সার্ভারে আছে
  (শুধু client আর এগুলো কল করছে না)। Phase E-তে আপনার অনুমোদনে সরানো হবে।

## Firebase Console-এ যা enable থাকতে হবে (Test করার আগে)
1. Authentication → Sign-in method → **Phone** enable
2. Authentication → Sign-in method → **Google** enable
3. Authentication → Settings → Authorized domains-এ আপনার সার্ভারের
   ডোমেইন/localhost যোগ করা আছে কিনা চেক করুন (নাহলে popup/otp কাজ করবে না)
4. সার্ভারে Phase A-এর `.env` (service account) কনফিগার করা থাকতে হবে —
   নাহলে client থেকে idToken গেলেও `/api/auth/firebase-login` reject করবে

## Test Checklist (Phase D-এ যাওয়ার আগে)
- [ ] Phone number দিয়ে OTP send/verify → login হয়
- [ ] একই নাম্বার যেটা আগে পুরনো OTP সিস্টেমে সাইনআপ করেছিল, সেটা দিয়ে
      Firebase লগইন করলে **পুরনো account/coins** ফিরে আসে (নতুন account
      তৈরি হয় না)
- [ ] Google Sign-In → নতুন/existing account সঠিকভাবে কাজ করে
- [ ] Refresh করলে লগইন থাকে
- [ ] Reconnect (নেটওয়ার্ক অফ/অন) করলে সেশন থাকে, socket auth কাজ করে
- [ ] Coin/Lucky Fruit/Teen Patti/Room/AI/Admin panel — কিছু ভাঙেনি
