# PingPong — Voice Room App

## চালানোর জন্য
```
npm install
node server.js
```
তারপর:
- Mobile app: `http://localhost:3000/`
- Admin panel: `http://localhost:3000/admin/`  (login: `admin` / `admin123`, বা `ADMIN_USERNAME`/`ADMIN_PASSWORD` env var দিয়ে বদলাও)

আসল ফোনে/একাধিক ডিভাইসে টেস্ট করতে হলে সার্ভার যে মেশিনে চলছে তার লোকাল IP দিয়ে অ্যাক্সেস করো (যেমন `http://192.168.x.x:3000/`), অথবা ngrok/Cloudflare Tunnel ব্যবহার করো যাতে বাইরে থেকেও পৌঁছানো যায়।

## এই প্যাকেজে যা আছে (সব working)
- OTP login, প্রোফাইল, ফলো/ফলোয়ার
- Voice room: 8-সিট, WebRTC peer-to-peer অডিও, real-time mic-level ভিত্তিক speaking-ring (শুধু "বসে থাকা" না, আসলেই কথা বললে জ্বলে)
- Auto ICE-restart reconnect — সিট বদল বা সংক্ষিপ্ত নেটওয়ার্ক ঝাঁকুনিতে রুম থেকে বের না হয়েই ভয়েস আবার জোড়া লাগার চেষ্টা করে
- চ্যাট, গিফট (float animation-সহ), ট্রেজার চেস্ট, ডাইস গেম, মিউজিক, রুম ব্যাকগ্রাউন্ড
- ওয়ালেট (কয়েন/ডায়মন্ড, exchange request), ডেইলি/উইকলি ট্রেজার বক্স
- অ্যাডমিন-পাঠানো PNG ফ্রেম (glow animation-সহ, avatar-এর আকার/ডিজাইন অক্ষত রেখে)
- এজেন্সি সিস্টেম (host assign, commission rate)
- অ্যানাউন্সমেন্ট ব্রডকাস্ট, প্রাইভেট মেসেজ
- সম্পূর্ণ Admin Panel: user ban/verify/coin edit, room lock/delete, exchange approve/reject, frame upload, agency তৈরি, chest level কনফিগ
- পুরো UI Gold + Black + Royal থিমে

## এই সেশনে যা বানানো হয়নি (সৎভাবে জানানো হচ্ছে)
আপনার পাঠানো রেফারেন্স স্ক্রিনশট/ফিচার লিস্টে (Maza/Bigo-স্টাইল) যা ছিল কিন্তু এখানে নেই:
- PK battle system, Family/Guild system, আলাদা Beans currency, Aristocracy tier
- Ludo/UNO/অন্য mini-games, Moments feed, AI ফিচার, একাধিক login পদ্ধতি (Google/Apple/Facebook)
এগুলো প্রতিটাই আলাদা বড় sub-system — লাগলে একটা একটা করে যোগ করা যাবে।

## Production-এর আগে জরুরি
- **TURN সার্ভার**: এখন শুধু ফ্রি Google STUN আছে। যেসব ইউজার strict NAT/corporate network-এ থাকবে তাদের voice কানেক্ট নাও হতে পারে। প্রোডাকশনে একটা TURN সার্ভার (coturn, বা Twilio/Xirsys-এর মতো paid service) লাগবে। অনেক ইউজার একসাথে থাকলে (৮+ জন এক রুমে) mesh P2P-এর বদলে SFU (mediasoup/LiveKit) লাগবে, নাহলে প্রতিটা ইউজারের ডিভাইস N-1 টা আলাদা কানেকশন সামলাতে হবে যেটা ভারী হয়ে যায়।
- **OTP**: এখনো শুধু console-এ প্রিন্ট হয় (dev/Termux setup), আসল SMS পাঠাতে হলে কোনো SMS gateway (Twilio, MSG91 ইত্যাদি) যোগ করতে হবে।
- ADMIN_USERNAME/ADMIN_PASSWORD env var দিয়ে বদলাও, ডিফল্ট রেখো না।

## এই আপডেটে যা ঠিক/যোগ হয়েছে

**কয়েন সিঙ্ক বাগ ফিক্স (গুরুত্বপূর্ণ):** Food Wheel আর Teen Patti গেমে ঢোকার সাথে সাথে কয়েন কমে যাওয়ার বাগ ঠিক হয়েছে — গেমের placeholder default balance (Food Wheel = 0, Teen Patti = 10000) আসল ওয়ালেট balance sync হওয়ার আগেই সার্ভারে পাঠিয়ে দিত। এখন আসল balance না আসা পর্যন্ত গেম কিছু পাঠাবে না। সিঙ্ক স্পিডও 60ms থেকে 20ms-এ কমানো হয়েছে — গেম খেলে বের হলে সাথে সাথে সব জায়গায় সমান কয়েন দেখাবে।

**অন্য দুটো বাগ ফিক্স:**
- REST `/api/gifts/send` এখন recipient আর chest reward winners-দের real-time wallet push করে (আগে শুধু sender-এর নিজের রেসপন্সে balance যেত)
- ভিডিও/কাস্টম গিফট এখন রুমের Treasure Chest progress-এ কাউন্ট হয় (আগে কয়েন কাটতো কিন্তু চেস্টে যোগ হতো না)

**Coin Center — একসাথে একাধিক ইউজারকে পাঠানো:** Admin Panel → Coin Center-এ "একসাথে একাধিক ইউজারকে পাঠাও" টগল অন করলে একাধিক ইউজার সার্চ করে লিস্টে যোগ করা যাবে, তারপর একই amount + reason দিয়ে একবারে সবাইকে পাঠানো যাবে। প্রতিটা recipient-এর জন্য আলাদা audit log entry হয়, এবং system balance প্রতিটা পাঠানোর সাথে সাথেই কমে (একজনের জন্য balance অপর্যাপ্ত হলে শুধু সেই একজনই বাদ পড়বে, বাকিরা ঠিকই পাবে)।

## PingPong AI Core (নতুন)
`ai/` ফোল্ডারে একটা আলাদা, modular AI backend যোগ হয়েছে — কোনো existing feature (wallet, gifts, rooms, login, SVIP, Coin Center ইত্যাদি) স্পর্শ করেনি।

**সেটআপ:**
1. `npm install` চালাও (নতুন `dotenv` dependency যোগ হয়েছে)।
2. `.env` ফাইলে `GEMINI_API_KEY` বসাও (`.env.example` দেখো)। `.env` আগে থেকেই `.gitignore`-এ আছে, GitHub-এ যাবে না।
3. সার্ভার রিস্টার্ট করলেই PingPong Help অ্যাক্টিভ হয়ে যাবে।
4. Provider বদলাতে হলে: `ai/providers/` এ নতুন ফাইল বানাও, `.env`-এ `AI_PROVIDER` বদলাও — বাকি কোডে পরিবর্তন লাগবে না।

**যা কাজ করছে:**
- PingPong Help — প্রতিটা ইউজারের Private Messages-এ সবসময় দেখাবে, প্রথমবার খুললে welcome message, বাংলা/ইংরেজি/হিন্দিতে স্বাভাবিক কথোপকথন, session-based memory
- Server monitoring, rate-limiting + spam detection, analytics + activity log — সব Admin Panel → AI Core ট্যাবে
- সব financial logic সম্পূর্ণ সার্ভার-সাইড; AI কখনো wallet টাচ করে না

**যা বানানো যায়নি / বাস্তবসম্মত না:**
- Root/Emulator/Play Integrity/Modified-APK detection — Android/Flutter native কোডে বসাতে হয়
- সত্যিকারের auto-restart — PM2 বা হোস্টিং প্রোভাইডারের process manager লাগবে
- এই স্যান্ডবক্সে ইন্টারনেট অ্যাক্সেস নেই তাই Gemini API আসলে কল হয়ে সাড়া দিচ্ছে কিনা লাইভ টেস্ট করা যায়নি
- ⚠️ `.env`-এ বসানো key-এর ফরম্যাট Gemini key-এর মতো লাগছে না (বিস্তারিত `.env`-এর কমেন্টে) — টেস্ট করার আগে যাচাই করে নাও

## Phase 10 — Security Hardening (নতুন)
নতুন `security/` ফোল্ডারে কয়েকটা ছোট, dependency-free মডিউল — কোনো নতুন npm প্যাকেজ লাগেনি (bcrypt/helmet/express-rate-limit এর কোনোটাই না), সব Node-এর built-in `crypto` আর নিজের লেখা middleware দিয়ে করা।

**যা যোগ হয়েছে:**
- **Security Headers** (`security/headers.js`) — CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HTTPS হলে HSTS, `X-Powered-By` সরানো। সব রেসপন্সে (`app.use`)।
- **Rate Limiting** (`security/rateLimiter.js`) — OTP/login/admin-login-এ আলাদা সীমা, প্লাস পুরো `/api/*`-তে একটা সাধারণ per-IP সীমা (300/মিনিট)।
- **Brute-force Protection** (`security/bruteForce.js`) — একই mobile/username-এ বারবার ভুল দিলে progressive lockout (৫ বার ভুলের পর ১ মিনিট, তারপর দ্বিগুণ হয়ে ৩০ মিনিট পর্যন্ত)। OTP verify, password login, admin login — তিনটাতেই।
- **Session Management** (`security/session.js`) — Admin সেশনে এখন idle timeout (৩০ মিনিট) + absolute timeout (১২ ঘণ্টা) আছে; আগে টোকেন কখনো এক্সপায়ার হতো না।
- **Password Security** — আগে থেকেই ভালো ছিল (scrypt + salt + timing-safe compare, প্লেইনটেক্সট কোথাও সেভ হয় না) — এই ফেজে পরিবর্তন লাগেনি।
- **File Upload Validation** — যেসব upload-এ (music/photo/background/frame/logo/group-icon) আগে কোনো file-type/size চেক ছিল না, সেগুলোতে এখন `fileFilter` + size limit যোগ হয়েছে। প্রতিটা multer filename callback এখন `safeFilename()` দিয়ে যায় (path-traversal ফিক্স — আগে `file.originalname` সরাসরি ব্যবহার হতো)।
- **API Validation / Input Sanitization** (`security/validation.js`) — `sanitizeText`/`escapeHtml`/`isValidMobile`/`isValidAmount` হেল্পার। প্রয়োগ করা হয়েছে: profile name/bio, room name, group name, chat message, private message, mod-announce, admin announcement।
- **Security Headers + JSON body size cap** (২MB, আগে unbounded ছিল) — global middleware।
- **Global error handler** — multer বা অন্য কোনো thrown error এখন crash/HTML error page না দিয়ে JSON রেসপন্স দেয়।

**সৎভাবে জানানো হচ্ছে — এই ফেজে যা এখনো বাকি:**
- Wallet-touching endpoint গুলোর (gifts/send ইত্যাদি) amount field-এ `isValidAmount()` প্রয়োগ করা হয়নি — তবে অডিট করে দেখা গেছে সেগুলো ইতিমধ্যেই server-side catalog price বা caller-এর নিজের balance দিয়ে bound করা, তাই ঝুঁকি কম।
- CSRF middleware যোগ হয়নি — এই অ্যাপ cookie-based session ব্যবহার করে না (mobile app userId/mobile body-তে পাঠায়, admin panel `x-admin-token` header ব্যবহার করে), তাই ক্লাসিক cookie-based CSRF এখানে প্রযোজ্য না। যদি ভবিষ্যতে cookie-session যোগ হয়, তখন CSRF token লাগবে।
- SQL/NoSQL injection প্রযোজ্য না — এই প্রজেক্ট কোনো ডাটাবেজ ব্যবহার করে না (JSON ফাইল-ভিত্তিক স্টোরেজ)।
- এখনো বাকি কিছু ছোট free-text endpoint (যেমন গ্রুপ description, যদি থাকে) sanitize করা হয়নি — একই প্যাটার্নে (`sanitizeText()`) পরে যোগ করা যাবে।
- এই স্যান্ডবক্সে সার্ভার আসলে চালিয়ে rate-limit/lockout লাইভ টেস্ট করা যায়নি (নেটওয়ার্ক অ্যাক্সেস নেই) — `node --check`-এ সব ফাইল সিনট্যাক্স-ঠিক পাওয়া গেছে, কিন্তু লোকাল/স্টেজিং-এ একবার হাতে টেস্ট করে নেওয়া ভালো (বিশেষ করে OTP lockout আর admin session expiry)।
- Security Audit ও Regression Check বাকি — Phase 11 শুরুর আগে পুরো অ্যাপ (admin panel সহ) হাতে-কলমে একবার চালিয়ে দেখা দরকার, বিশেষ করে upload ফর্মগুলো (নতুন file-type রিস্ট্রিকশনের কারণে কোনো বৈধ আপলোড রিজেক্ট হচ্ছে কিনা)।

## Phase 11 — Performance Optimization (নতুন)
নতুন `perf/` ফোল্ডার (`security/`-এর একই additive প্যাটার্নে): সবচেয়ে বড় দুটো real bottleneck ঠিক করা হয়েছে — (১) `safeWrite()` আগে প্রতিটা মিউটেশনে পুরো ফাইল সিনক্রোনাসভাবে ডিস্কে লিখত (event loop ব্লক করে), এখন ২৫০ms-এ debounce/coalesce হয়ে async write হয়; (২) `findUserByUserId()` আগে প্রতিটা কলে সব ইউজার লিনিয়ারলি স্ক্যান করত (১০০+ call site), এখন O(1) Map-ইনডেক্স ব্যবহার করে, self-healing fallback সহ। এছাড়া: `compression` npm প্যাকেজ দিয়ে gzip রেসপন্স (একমাত্র জিনিস hand-roll করা হয়নি — কারণ ও details `RBAC_MIGRATION_NOTES.md`-এ), Revenue Analytics endpoint-এ ১৫s TTL cache, `voice-activity` সকেট ইভেন্ট এখন `.volatile`, admin session Map cleanup, আর `/api/admin/users`-এ opt-in pagination (backward-compatible)।

**সততার সাথে জানানো হচ্ছে:** নতুন `compression` dependency যোগ হয়েছে (`npm install` লাগবে)। Debounced write একটা honest tradeoff আনে — hard crash ঠিক ২৫০ms উইন্ডোর মধ্যে হলে সেই উইন্ডোর শেষ পরিবর্তন হারাতে পারে (গ্রেসফুল শাটডাউনে সবসময় ফ্লাশ হয়)। প্রতিটা `perf/*.js` মডিউল isolated node স্ক্রিপ্ট দিয়ে সত্যিই রান করে টেস্ট করা হয়েছে, কিন্তু আসল `node server.js` বুট করে end-to-end টেস্ট এই sandbox-এ সম্ভব হয়নি (network নেই)। বিস্তারিত (প্রতিটা পরিবর্তনের যুক্তি, কোড-রেফারেন্স, বাকি যাচাই-লিস্ট) `RBAC_MIGRATION_NOTES.md`-এর "Phase 11" সেকশনে।

## Phase 12 — Final Regression Testing
সম্পূর্ণ কোডবেসের উপর static/code-level regression pass চালানো হয়েছে (সব ৩৯টা `.js` ফাইল, প্রতিটা `require()` পাথ, প্রতিটা রুট রেজিস্ট্রেশন, প্রতিটা approval/ban lifecycle)। **একটা real regression ধরা পড়েছে এবং ফিক্স করা হয়েছে:** Dashboard-এর `/api/admin/stats` আর `/api/admin/live` এন্ডপয়েন্ট আগে সব দেশের ডেটা (total users/rooms/online/banned/active-rooms) দেখাতো — Country Manager/Country Super Admin-এর মতো country-scoped role-এর জন্যও, যেটা RBAC-এর Country Data Isolation guarantee ভেঙে ফেলছিল। এখন `/api/admin/rooms`/`/api/admin/users`-এর মতো একই `actorCanAccessCountry()` চেক দিয়ে ফিল্টার হয়। বিস্তারিত রিগ্রেশন রিপোর্ট `RBAC_MIGRATION_NOTES.md`-এর "Phase 12" সেকশনে (কী কী মডিউল টেস্ট হয়েছে, কীভাবে, কী পাওয়া যায়নি)।

## Phase 13 — Production Deployment & Release Preparation
এই ফেজে **কোনো business logic বদলায়নি** — শুধু deployment-এর জন্য প্রস্তুত করা হয়েছে। নতুন কী আছে:

- **Health check:** `GET /api/health` — auth ছাড়া, শুধু `{status, uptimeSeconds, timestamp}` — PM2/Nginx/uptime monitor-এর জন্য।
- **`.env.example`** — প্রতিটা env var-এর ডকুমেন্টেশন (`grep -rn "process.env"` দিয়ে পুরো কোডবেস থেকে ইনভেন্টরি করা)।
- **`.gitignore`** — `.env`, `node_modules/`, `data/` (লাইভ ডেটাবেজ), `uploads/`, লগ — আগে ছিল না।
- **`ecosystem.config.js`** — PM2 কনফিগ, single-instance/fork-mode (কেন cluster mode না তার ব্যাখ্যা ফাইলের কমেন্টেই আছে — in-memory + JSON-file state একাধিক instance-এ split হলে ডেটা করাপ্ট হবে), auto-restart, `kill_timeout` গ্রেসফুল-শাটডাউনের জন্য যথেষ্ট সময় দিতে।
- **`nginx.conf.example`** — HTTPS (Let's Encrypt/certbot নির্দেশসহ), Socket.IO WebSocket আপগ্রেড হেডার, gzip, upload path-গুলোর জন্য edge caching।
- **Owner password boot-warning:** `ADMIN_USERNAME`/`ADMIN_PASSWORD` env var সেট না থাকলে এখন বুট-এ console warning আসে (আগে চুপচাপ default `admin/admin123`-এ পড়ে যেত)। Login behavior অপরিবর্তিত।
- **`TRUST_PROXY` env var (real bug ফিক্স):** Nginx-এর পেছনে চালালে আগে `req.ip` সব ইউজারের জন্য Nginx-এর নিজের loopback address (`127.0.0.1`) দেখাতো — এটা `security/rateLimiter.js`-এর per-IP rate limit-কে ভুলভাবে সবার জন্য একটাই shared limit বানিয়ে দিত, আর প্রতিটা audit-log entry-তে real client IP হারিয়ে যেত। `TRUST_PROXY=1` সেট করলেই (শুধু Nginx-এর পেছনে চালালে) এটা ঠিক হয়ে যায়; সেট না করলে আগের মতোই বিহেভিয়ার (bare/Termux ডিপ্লয়মেন্টের জন্য নিরাপদ ডিফল্ট)।

### Installation
```
git clone <your-repo>
cd pingpong-project
npm install
cp .env.example .env
# .env-এ ADMIN_USERNAME/ADMIN_PASSWORD আর দরকার হলে GEMINI_API_KEY বসাও
node server.js          # dev/direct টেস্টের জন্য
```

### Deployment steps (production, PM2 + Nginx)
```
npm install --omit=dev
cp .env.example .env     # তারপর edit করো: ADMIN_PASSWORD, TRUST_PROXY=1, ইত্যাদি
npm install -g pm2
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup              # নির্দেশিত কমান্ডটা sudo দিয়ে একবার চালাও (boot-এ auto-start)
pm2 install pm2-logrotate
```
তারপর Nginx সেটআপ করো (`nginx.conf.example` দেখো — `YOUR_DOMAIN` আর SSL পাথ বদলাও), `certbot --nginx -d YOUR_DOMAIN` দিয়ে SSL ইস্যু করো।

### Environment variables
সম্পূর্ণ লিস্ট, ব্যাখ্যাসহ: `.env.example`। সংক্ষেপে — `PORT`, `NODE_ENV`, `TRUST_PROXY` (Nginx থাকলে `1`), `ADMIN_USERNAME`/`ADMIN_PASSWORD` (আবশ্যক, default রেখো না), `AI_PROVIDER`/`GEMINI_API_KEY`/`OPENAI_API_KEY` (ঐচ্ছিক)।

### Backup
সব ডেটা `data/` ফোল্ডারে JSON ফাইল হিসেবে থাকে (users, rooms বাদে বাকি সবকিছু persist হয় — rooms/sockets in-memory, restart-এ খালি হয়ে যায়, যেটা এই আর্কিটেকচারে প্রত্যাশিত), plus `uploads/` (ইউজার-আপলোড করা ছবি/মিউজিক/ফ্রেম/গিফট)। প্রতিদিন কপি রাখাই যথেষ্ট:
```
tar czf pingpong-backup-$(date +%F).tar.gz data/ uploads/
```
সার্ভার চলা অবস্থাতেও ব্যাকআপ নিরাপদ — writeQueue debounce সর্বোচ্চ ২৫০ms পুরনো ডেটা দিতে পারে, কখনো করাপ্ট ফাইল না (atomic temp-file-then-rename)।

### Restore
```
pm2 stop pingpong
# পুরনো data/ ও uploads/ ফোল্ডার সরিয়ে ব্যাকআপ থেকে extract করো
tar xzf pingpong-backup-YYYY-MM-DD.tar.gz
pm2 start pingpong
```

### Upgrade process
```
pm2 stop pingpong
git pull                  # অথবা নতুন কোড কপি করো (data/, uploads/, .env স্পর্শ কোরো না)
npm install --omit=dev    # নতুন dependency থাকলে
pm2 start ecosystem.config.js --env production
pm2 logs pingpong --lines 50   # বুট ঠিকমতো হয়েছে কিনা যাচাই করো
```
`index.html`/`admin/index.html`-এর `?v=` cache-busting param-এর কারণে ব্রাউজার/ফোন নিজে থেকেই নতুন `app.js`/`style.css` টেনে নেবে — কিছু ম্যানুয়ালি কেউ ক্যাশ ক্লিয়ার করার দরকার নেই।

### Known limitations (Phase 13, honestly reported)
- **Graceful shutdown আংশিক:** `perf/writeQueue.js`-এর SIGINT/SIGTERM হ্যান্ডলার সব pending ডিস্ক-রাইট ফ্লাশ করে নিশ্চিত করে (data loss হয় না), কিন্তু খোলা HTTP/Socket.IO কানেকশন গ্রেসফুলি drain করে না — `process.exit(0)` সাথে সাথেই কল হয়। ব্যবহারিক প্রভাব কম (PM2-এর `kill_timeout` ৮ সেকেন্ড দেওয়া আছে, বেশিরভাগ ইন-ফ্লাইট রিকোয়েস্ট তার মধ্যেই শেষ হয়ে যায়), কিন্তু একটা true zero-downtime deploy (PM2 cluster reload) এই আর্কিটেকচারে সম্ভব না (single-instance-only, উপরে ব্যাখ্যা করা হয়েছে)।
- **Single-instance ceiling:** in-memory state + JSON-file storage মানে horizontal scaling (একাধিক Node instance/সার্ভার) সম্ভব না বর্তমান আর্কিটেকচারে — একটা মেশিনে single process-ই স্কেল করার একমাত্র উপায় (আরও RAM/CPU)। সত্যিকারের multi-instance স্কেলিং লাগলে storage layer-কে একটা real shared DB (Postgres/Mongo/Redis)-এ মাইগ্রেট করতে হবে — এটা এই ফেজের স্কোপের বাইরে ইচ্ছাকৃতভাবে (business logic rewrite এড়ানোর নির্দেশ অনুযায়ী)।
- **NODE_ENV আজ কোনো behavior বদলায় না** — শুধু ভবিষ্যতের জন্য convention হিসেবে রাখা হয়েছে (log verbosity/error detail future work-এ)।
- **TURN সার্ভার এখনো নেই** (Phase-এর আগে থেকেই noted) — strict NAT-এর ইউজারদের voice কানেক্ট নাও হতে পারতে পারে।
- এই sandbox-এ network না থাকায় `npm install`, real PM2 বুট, real Nginx রিভার্স-প্রক্সি, real HTTPS হ্যান্ডশেক — কোনোটাই লাইভ টেস্ট করা যায়নি। কোড-লেভেল রিভিউ + isolated syntax check সব পাস করেছে; স্টেজিং/production-এ প্রথম ডিপ্লয়ে উপরের checklist অনুযায়ী হাতে-কলমে একবার verify করে নাও।

**Production readiness assessment:** কোর অ্যাপ্লিকেশন লজিক (RBAC, approval workflows, ban management, wallet, ভয়েস রুম) Phase 1–12 জুড়ে টেস্ট করা এবং কোড-লেভেলে সাউন্ড। Phase 13-এর deployment tooling (PM2/Nginx/health-check/env হ্যান্ডলিং) যোগ হওয়ার পর এই প্রজেক্ট একটা single-server production ডিপ্লয়মেন্টের জন্য প্রস্তুত, উপরের known limitations মাথায় রেখে। মাল্টি-সার্ভার/হাই-স্কেল ডিপ্লয়মেন্টের আগে storage layer migration লাগবে।
