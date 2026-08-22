# Phase D — Testing & Verification Tracker

⚠️ আমার sandbox-এ network নেই এবং real Firebase project/live server/আসল
ফোন নাম্বার এক্সেস নেই — তাই এই লাইভ টেস্টগুলো আমি নিজে চালাতে পারি না।
এই ফাইলটা আপনার টেস্টের জন্য একটা checklist/log হিসেবে ব্যবহার করুন;
কোনোটা fail করলে সেই লাইনে ফলাফল/error message লিখে আমাকে পাঠান, আমি
diagnose করব।

## যা আমি ইতিমধ্যে static code audit করে যাচাই করেছি (Phase D-এর প্রস্তুতি)
- ✅ `public/index.html`/`app.js`-এ আর কোথাও পুরনো password-login element
  (`step-password-login`, `pw-login-*`, `cp-mobile` ইত্যাদি) reference নেই
  — dangling listener crash হবে না
- ✅ `admin/app.js`-এর `login-password` field সম্পূর্ণ আলাদা, separate
  Admin RBAC login সিস্টেম — Phase C touch করেনি
- ✅ `security/validation.js`-এর `isValidMobile()` কোথাও enforce করা হয়
  না (imported কিন্তু unused) — তাই Google-only account-এর জন্য যে
  synthetic key ব্যবহার হয় (`google:<uid>`, ১০-ডিজিট নয়) সেটা কোনো hidden
  format-validation-এ আটকাবে না
- ✅ Old `/api/auth/send-otp` / `verify-otp` / `set-password` server.js-এ
  অক্ষত আছে, client আর কল করে না

## Authentication Tests
- [ ] Firebase Phone OTP Login
- [ ] Google Sign-In
- [ ] Logout
- [ ] Auto Login after Refresh
- [ ] Auto Login after Reconnect
- [ ] Invalid Token Handling (মেয়াদ শেষ/ভুল idToken পাঠালে সঠিক error আসে)
- [ ] Expired Token Handling

## Existing User Tests
- [ ] Existing User Login (পুরনো OTP-accounted নাম্বার Firebase দিয়ে লগইন)
- [ ] Existing Coin Restore
- [ ] Existing Profile Restore
- [ ] Existing Room Restore
- [ ] Existing Friends Restore

## Game / Feature Tests
- [ ] Lucky Fruit
- [ ] Teen Patti
- [ ] Coin Update
- [ ] Ranking
- [ ] Gift
- [ ] Live Room
- [ ] Socket.IO
- [ ] AI Assistant
- [ ] Admin Panel

## Security Tests
- [ ] Firebase ID Token Verification (invalid signature reject হয়)
- [ ] Unauthorized Request Block
- [ ] Session Expiry
- [ ] Reconnect Authentication

## Phase E — এখনো LOCKED
নিচেরগুলো আপনার explicit "Approve" ছাড়া ছোঁয়া হবে না:
- Password Authentication
- OTP Backend (`send-otp`/`verify-otp`)
- Password Hash Logic
- Legacy Authentication ফাইল/কোড
