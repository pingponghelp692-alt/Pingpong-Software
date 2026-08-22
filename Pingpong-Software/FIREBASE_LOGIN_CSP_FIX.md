# Firebase Phone OTP / Google Login — Critical Fix (Root Cause)

## Error
```
Cannot read properties of undefined (reading 'sendPhoneOtp')
Cannot read properties of undefined (reading 'signInWithGoogle')
```

## Root Cause (আসল কারণ — এটা app.js/firebaseClient.js-এর bug ছিল না)
`security/headers.js`-এ Phase 10-এ যোগ করা Content-Security-Policy-তে
`script-src`-এ `https://www.gstatic.com` (যেখান থেকে Firebase SDK লোড হয়)
এবং `https://apis.google.com` (Google Sign-In popup helper) allow করা
ছিল না। ব্রাউজার সেই `<script>` ট্যাগ **silently ব্লক** করে দেয়, ফলে
`firebase` global কখনো তৈরিই হয়নি। তখন `firebaseClient.js`-এর
`firebase.initializeApp(...)` লাইনে immediately থ্রো করে পুরো ফাইল বন্ধ
হয়ে যায় — ফাইলের একদম শেষ লাইন `window.ppFirebaseAuth = {...}` কখনো
রান হয়নি। app.js যখন `window.ppFirebaseAuth.sendPhoneOtp(...)` কল করে,
`ppFirebaseAuth` নিজেই undefined থাকায় ঠিক এই error আসছিল।

এই একই প্যাটার্নের bug আগে YouTube player আর dotLottie emoji reaction-এর
সময়ও হয়েছিল (কোডের কমেন্টেই লেখা আছে) — CSP প্রতিটা নতুন external
script/domain-এর জন্য explicit allowance চায়।

## Fix — `security/headers.js` (CSP আপডেট)
| Directive | নতুন যা যোগ হলো | কেন |
|---|---|---|
| `script-src` | `gstatic.com`, `apis.google.com` | Firebase SDK নিজে + Google Sign-In popup helper script |
| `img-src` | `gstatic.com`, `lh3.googleusercontent.com` | Google আইকন + Google profile photo |
| `frame-src` | `accounts.google.com`, `*.firebaseapp.com` | Google popup + invisible reCAPTCHA iframe |
| `connect-src` | `apis.google.com`, `securetoken.googleapis.com`, `www.googleapis.com`, `identitytoolkit.googleapis.com` | Firebase Auth SDK-এর নিজের REST কল (OTP send/verify, token verify/refresh) |

## Fix #2 — `public/firebaseClient.js` (defense-in-depth, hide নয়)
- এখন explicitly চেক করে `firebase` SDK আদৌ লোড হয়েছে কিনা
- SDK লোড/init ব্যর্থ হলে, `window.ppFirebaseAuth` তবুও সংজ্ঞায়িত থাকে,
  কিন্তু প্রতিটা ফাংশন কল করলে **স্পষ্ট, actionable error message**
  থ্রো করে (যেমন: "Firebase SDK did not load — check CSP...") — যেটা
  app.js-এর existing `toast(err.message)` দিয়ে UI-তে দেখা যাবে
- এটা কোনো mock/fallback/silent-catch **নয়** — root cause (CSP) আলাদাভাবে
  ফিক্স করা হয়েছে; এটা শুধু নিশ্চিত করে যে ভবিষ্যতে এই ক্লাসের কোনো bug
  হলে আবার cryptic "undefined" না দেখিয়ে সরাসরি কারণ বলবে

## Verify (আপনি টেস্ট করার সময়)
- ব্রাউজার DevTools → Console-এ আর `firebase is not defined` বা
  `Cannot read properties of undefined` আসবে না
- Console-এ `🔥 Firebase Admin SDK initialized` (server) এবং কোনো
  `🔥 [FIREBASE-CLIENT] Initialization failed` (client) না দেখলে বুঝবেন
  SDK ঠিকমতো লোড হয়েছে
- DevTools → Network tab-এ `firebase-app-compat.js`/`firebase-auth-compat.js`
  রিকোয়েস্ট 200 (ব্লকড/red না) কিনা দেখুন
- এরপর Phone OTP ও Google Login টেস্ট করুন — `PHASE_D_TEST_TRACKER.md`
  অনুযায়ী

## অপরিবর্তিত
Room, Coin, Lucky Fruit, Teen Patti, AI, Admin Panel, Ranking, existing
session flow (`saveSession`/`connectSocket`/`enterApp`) — কিছুই ছোঁয়া
হয়নি। CSP-তে শুধু allowance যোগ হয়েছে, কোনো existing directive সরানো বা
সংকুচিত করা হয়নি (YouTube/dotLottie allowances অক্ষত)।
