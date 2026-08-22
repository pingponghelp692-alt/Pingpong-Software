// ==================================================
// FIREBASE — GOOGLE SIGN-IN ONLY (2026-08-16)
// ==================================================
// Phone OTP login no longer uses Firebase at all — see
// security/otpService.js + sms/gateway.js on the server, and the
// btn-send-otp/btn-verify-otp handlers in app.js, which now call this
// server's own /api/auth/send-otp and /api/auth/verify-otp directly.
// Firebase is kept ONLY for "Continue with Google" (signInWithGoogle),
// since removing it would also remove Google Sign-In, which was not part
// of this change. Self-contained, same pattern as bannerSlider.js/
// emojiReaction.js: loaded as a plain script before app.js, exposes a
// small window.ppFirebaseAuth API. Does not touch rooms/coins/sockets/
// anything else.

const firebaseConfig = {
  apiKey: "AIzaSyBPGwlHO2AOyr8c3gDNEjAqbPDWszILT2E",
  authDomain: "ping-pong-voice-chat-24a27.firebaseapp.com",
  projectId: "ping-pong-voice-chat-24a27",
  storageBucket: "ping-pong-voice-chat-24a27.firebasestorage.app",
  messagingSenderId: "479940677601",
  appId: "1:479940677601:web:4c50b83e349293cd954ca0",
  measurementId: "G-J63742935N"
};

// ROOT CAUSE NOTE (2026-08-03): this file previously called
// firebase.initializeApp(...) unconditionally at the top level. If the
// Firebase SDK script (loaded from gstatic.com in index.html) was ever
// blocked before reaching the browser — a CSP rule missing an allowance
// (this is what actually happened — see security/headers.js), an
// ad-blocker, or a network/firewall issue — `firebase` was undefined here,
// this line threw immediately, and every line after it (including
// `window.ppFirebaseAuth = {...}` at the bottom) never ran. That is why
// app.js's click handlers saw `window.ppFirebaseAuth` as undefined instead
// of a clear error. Fix: detect that specific failure explicitly and still
// define window.ppFirebaseAuth, but with functions that throw one clear,
// actionable message — so a future regression of the same kind fails loud
// and diagnosable instead of as a cryptic "undefined" property read.
let fbAuth = null;
let firebaseInitError = null;
if (typeof firebase === "undefined") {
  firebaseInitError = "Firebase SDK did not load (script blocked or failed to fetch — check CSP script-src/connect-src in security/headers.js, ad-blockers, or network access to gstatic.com)";
} else {
  try {
    firebase.initializeApp(firebaseConfig);
    fbAuth = firebase.auth();
  } catch (err) {
    firebaseInitError = "firebase.initializeApp()/firebase.auth() failed: " + err.message;
  }
}
if (firebaseInitError) {
  console.error("🔥 [FIREBASE-CLIENT] Initialization failed — Google Login will not work until this is fixed:", firebaseInitError);
}

function assertFirebaseReady() {
  if (firebaseInitError) throw new Error(firebaseInitError);
}

// Hints for the Google Sign-In error codes that can still occur. (The
// Phone-Auth-specific hints — reCAPTCHA/SMS-quota/etc. — were removed along
// with signInWithPhoneNumber(), since phone login no longer touches
// Firebase at all.)
const FIREBASE_ERROR_HINTS = {
  "auth/operation-not-allowed": "Firebase Console → Authentication → Sign-in method-এ Google provider enable করা নেই।",
  "auth/unauthorized-domain": "এই সার্ভারের ডোমেইন Firebase Console → Authentication → Settings → Authorized domains তালিকায় নেই।"
};
function withFirebaseErrorHint(err) {
  const hint = FIREBASE_ERROR_HINTS[err && err.code];
  if (hint) {
    const wrapped = new Error(`${err.message} — ${hint}`);
    wrapped.code = err.code;
    return wrapped;
  }
  return err;
}

/** Opens the Google Sign-In popup and returns a Firebase ID token for the server. */
async function signInWithGoogle() {
  assertFirebaseReady();
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await fbAuth.signInWithPopup(provider);
    return await result.user.getIdToken(true);
  } catch (err) {
    throw withFirebaseErrorHint(err);
  }
}

// ROOT-CAUSE FIX (requirements #3, #4, #7 — silent refresh / never show a
// stale-session error if a refresh is possible): finishFirebaseLogin() in
// app.js calls this when the server reports code:"token-expired" instead of
// immediately surfacing an error to the user. If a Firebase user is still
// signed in on this device (fbAuth.currentUser is non-null — normal case:
// the whole login flow just ran seconds ago and the SDK still holds the
// user in memory), getIdToken(true) forces the SDK to mint a brand-new
// token from Firebase's servers rather than reusing whatever cached/near-
// expiry token caused the problem. Returns null (never throws) if there is
// no signed-in Firebase user to refresh — callers treat null as "refresh
// isn't possible, fall through to a real sign-out".
async function getFreshIdTokenIfPossible() {
  if (firebaseInitError || !fbAuth || !fbAuth.currentUser) return null;
  try {
    return await fbAuth.currentUser.getIdToken(true);
  } catch (err) {
    console.error("🔥 [FIREBASE-CLIENT] silent token refresh failed:", err.code || err.message);
    return null;
  }
}

// ROOT-CAUSE FIX (requirement #4 — sign out + clear all cached auth data if
// refresh fails): called from app.js's clearSession() so a dead Firebase
// session never lingers as a source of repeated "expired" errors on the
// next login attempt. Clears every Firebase-specific key this integration
// could have written, in addition to whatever app.js already clears for
// its own pp_* keys.
async function fullFirebaseSignOut() {
  try {
    if (fbAuth && fbAuth.currentUser) await fbAuth.signOut();
  } catch (err) {
    console.error("🔥 [FIREBASE-CLIENT] signOut() failed (continuing with local cleanup):", err.code || err.message);
  }
  // Firebase JS SDK persists its own session under localStorage/IndexedDB
  // keys prefixed "firebase:" — these are separate from this app's own
  // pp_user/pp_auth_token keys and are NOT cleared by app.js's
  // clearSession(). A stale one of these is a second, independent way a
  // "session" can look expired/invalid on next load, so sweep them here too.
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("firebase:"))
      .forEach((k) => localStorage.removeItem(k));
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith("firebase:"))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch (e) { /* storage access can throw in locked-down/private contexts — non-fatal */ }
}

// ROOT-CAUSE FIX (requirement #6 — verify onAuthStateChanged is implemented
// correctly): this integration intentionally does NOT use Firebase's own
// persisted session to decide whether the user is logged into PingPong —
// that job belongs entirely to the app's own pp_auth_token/session layer
// (see bootstrap() in app.js), which is unaffected by Firebase token
// expiry. onAuthStateChanged is still wired up here for exactly the two
// things it's actually needed for: diagnostics — a mismatch between
// "Firebase thinks a user is signed in" and "the app has no session" is
// useful signal when debugging Google Sign-In.
if (typeof firebase !== "undefined" && !firebaseInitError) {
  firebase.auth().onAuthStateChanged((user) => {
    console.log(`🔥 [FIREBASE-CLIENT] onAuthStateChanged: ${user ? "signed in (uid=" + user.uid + ")" : "signed out"}`);
  }, (err) => {
    console.error("🔥 [FIREBASE-CLIENT] onAuthStateChanged listener error:", err);
  });
}

window.ppFirebaseAuth = {
  signInWithGoogle,
  getFreshIdTokenIfPossible,
  fullFirebaseSignOut
};
