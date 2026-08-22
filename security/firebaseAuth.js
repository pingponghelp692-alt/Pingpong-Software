// ==================================================
// FIREBASE AUTH MIGRATION — PHASE A
// Firebase Admin SDK token verification (additive, self-contained)
// ==================================================
// Same pattern as every other module under security/ (bruteForce.js,
// session.js, userAuth.js, etc.): drop-in file, does not touch any
// existing route or the old OTP/password auth flow. server.js only gains
// ONE new capability by requiring this — verifyFirebaseToken() — it does
// not remove or alter anything.
//
// Setup required on the server (NOT done by this file):
//   1. npm install firebase-admin
//   2. In Firebase Console -> Project Settings -> Service Accounts,
//      generate a new private key (JSON file).
//   3. NEVER commit that JSON file. Instead set ONE of these env vars
//      (see .env.example):
//        FIREBASE_SERVICE_ACCOUNT_BASE64  — the whole JSON file, base64-encoded
//        FIREBASE_SERVICE_ACCOUNT_JSON    — the raw JSON as a single-line string
//        GOOGLE_APPLICATION_CREDENTIALS   — a filesystem path to the JSON
//                                            (only if the file exists on disk
//                                            outside the git repo)
//
// If none of these are set, this module logs a warning and
// verifyFirebaseToken() always rejects — it does NOT crash the server, so
// the rest of PingPong (old OTP/password login, rooms, coins, everything)
// keeps working exactly as before while Firebase isn't configured yet.

let admin = null;
let initError = null;
let firebaseReady = false;
let loadedProjectId = null;

// Must match public/firebaseClient.js's firebaseConfig.projectId. A
// service account from the WRONG Firebase project is a common, silent
// cause of "Invalid or expired Firebase session" — the token verifies
// cryptographically fine, it's just signed for a different project, so
// verifyIdToken() rejects it with a real but easy-to-miss reason. We check
// for this explicitly at startup instead of letting it surface only as a
// mystery per-request 401.
const EXPECTED_PROJECT_ID = "ping-pong-voice-chat-24a27";

function loadServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8");
        return JSON.parse(json);
    }
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    }
    return null; // fall back to GOOGLE_APPLICATION_CREDENTIALS (file path), if set
}

try {
    // eslint-disable-next-line global-require
    admin = require("firebase-admin");
    if (!admin.apps.length) {
        const serviceAccount = loadServiceAccount();
        if (serviceAccount) {
            loadedProjectId = serviceAccount.project_id || null;
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            firebaseReady = true;
        } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            admin.initializeApp({ credential: admin.credential.applicationDefault() });
            firebaseReady = true;
            loadedProjectId = admin.app().options.projectId || null;
        } else {
            initError = "No Firebase service account configured (set FIREBASE_SERVICE_ACCOUNT_BASE64 or FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS in .env)";
        }
    } else {
        firebaseReady = true;
        loadedProjectId = admin.app().options.projectId || null;
    }
} catch (err) {
    // firebase-admin not installed yet, or bad credential JSON — log and
    // degrade gracefully instead of taking the whole server down.
    initError = err.message;
}

if (firebaseReady) {
    console.log(`🔥 Firebase Admin SDK initialized (project: ${loadedProjectId || "unknown"}) — Firebase login endpoint is live.`);
    if (loadedProjectId && loadedProjectId !== EXPECTED_PROJECT_ID) {
        console.error(
            `🚨 [FIREBASE-AUTH] Service account project ("${loadedProjectId}") does NOT match the client's Firebase project ("${EXPECTED_PROJECT_ID}", see public/firebaseClient.js). ` +
            `Every client ID token will fail verification until the service account from the SAME project (${EXPECTED_PROJECT_ID}) is used. ` +
            `This exact mismatch is a common cause of "Invalid or expired Firebase session" even when Phone/Google sign-in succeeds on the client.`
        );
    }
} else {
    console.warn(`⚠️  Firebase Admin SDK NOT initialized (${initError}). /api/auth/firebase-login will reject all requests until this is configured. Old OTP/password login is unaffected.`);
}

/**
 * Verifies a Firebase ID token sent from the client after Phone OTP or
 * Google Sign-In. Returns the decoded token ({ uid, phone_number?, email?,
 * name?, picture?, firebase: { sign_in_provider } }) or throws an Error
 * whose .message is the REAL reason from firebase-admin (expired,
 * malformed, wrong project/audience, revoked, clock skew, etc.) — never a
 * generic message — so the server-side log always shows the actual cause.
 */
async function verifyFirebaseToken(idToken) {
    if (!firebaseReady) {
        const err = new Error(`Firebase Admin not configured on server (${initError})`);
        err.code = "server/not-configured"; // ROOT-CAUSE FIX: distinct code so
        // server.js can tell "we never even tried to verify this token"
        // apart from "we verified it and it's genuinely expired/invalid".
        // These used to collapse into the exact same generic client-facing
        // message ("Invalid or expired Firebase session"), which is why
        // that message could appear on EVERY login attempt (not just an
        // actually-expired one) whenever the service account simply hadn't
        // been configured yet — see server.js's /api/auth/firebase-login.
        throw err;
    }
    if (!idToken || typeof idToken !== "string") {
        const err = new Error("Missing ID token in request body");
        err.code = "server/missing-token";
        throw err;
    }
    try {
        // checkRevoked:true — rejects a token if the user's refresh tokens
        // were revoked server-side (e.g. banned, "logout everywhere"), not
        // just ordinary expiry.
        const decoded = await admin.auth().verifyIdToken(idToken, true);
        return decoded;
    } catch (err) {
        // Requirement #12: always surface the REAL Firebase error code
        // (auth/id-token-expired, auth/id-token-revoked, auth/argument-error,
        // clock-skew "Firebase ID token has incorrect \"iat\" claim" etc.)
        // to the server console. err.code from firebase-admin is preserved
        // as-is so callers (server.js) can branch on it (e.g. an expired
        // token is a normal, expected condition — the client should have
        // silently refreshed before ever reaching here; see
        // public/firebaseClient.js's getIdToken(true) usage).
        console.error(`🔍 [FIREBASE-AUTH] verifyIdToken failed — code=${err.code || "unknown"} message=${err.message}`);
        throw err;
    }
}

module.exports = { verifyFirebaseToken, isFirebaseReady: () => firebaseReady, getLoadedProjectId: () => loadedProjectId };
