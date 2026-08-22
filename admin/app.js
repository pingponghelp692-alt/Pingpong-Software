/* ==========================================================================
   PingPong Control — Admin website logic.
   ========================================================================== */

const API = ""; // same-origin (served at /admin, /owner-panel, /admin-panel — API always at /api)
let token = localStorage.getItem("pp_admin_token") || null;
let liveTimer = null;
let allUsersCache = [];

// Owner Panel / Admin Panel split (additive). Same app.js/index.html/
// style.css bundle is now served at three URL prefixes:
//   /owner-panel  -> PANEL_TYPE = "owner"  (Owner account only)
//   /admin-panel  -> PANEL_TYPE = "admin"  (every other role)
//   /admin        -> PANEL_TYPE = null     (legacy path, left exactly as
//                     it behaved before this change — no panelType is
//                     sent to /api/admin/login, so the server applies no
//                     restriction there either; unchanged for anyone with
//                     an existing /admin bookmark or integration).
// This only controls branding + which panelType is sent at login. Actual
// per-section visibility inside the shell is unchanged — still entirely
// driven by RBAC permissions (applySidebarPermissions), exactly as
// before. The Owner already implicitly sees every section (Owner = "all
// permissions" in rbac.js), so nothing else needs to change for the
// Owner Panel to already contain "everything"; the Admin Panel already
// only shows a given role's permitted sections the same way it always
// has.
const PANEL_TYPE = location.pathname.startsWith("/owner-panel") ? "owner"
  : location.pathname.startsWith("/admin-panel") ? "admin"
  : null;

function applyPanelBranding() {
  const brand = PANEL_TYPE === "owner"
    ? { mark: "PP<span>/owner</span>", title: "PingPong Owner Panel", sub: "Owner-only access. Every action here is logged.", badge: "👑 Owner Panel", tab: "PingPong Control — Owner Panel" }
    : PANEL_TYPE === "admin"
    ? { mark: "PP<span>/admin</span>", title: "PingPong Admin Panel", sub: "Operations access only. Every action here is logged.", badge: "🛡️ Admin Panel", tab: "PingPong Control — Admin Panel" }
    : null; // legacy /admin — leave default markup untouched
  if (!brand) return;
  document.title = brand.tab;
  if ($("login-mark")) $("login-mark").innerHTML = brand.mark;
  if ($("login-title")) $("login-title").textContent = brand.title;
  if ($("login-sub")) $("login-sub").textContent = brand.sub;
  if ($("panel-badge")) $("panel-badge").textContent = brand.badge;
}
applyPanelBranding();

function $(id) { return document.getElementById(id); }

function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 2800);
}

async function api(path, method = "GET", body = null) {
  try {
    const res = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { "x-admin-token": token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { doLogout(); toast("Session expired, please log in again", true); return { success: false }; }
    return await res.json();
  } catch (e) {
    toast("Network issue", true);
    return { success: false };
  }
}

async function apiUpload(path, formData) {
  try {
    const res = await fetch(API + path, {
      method: "POST",
      body: formData,
      headers: token ? { "x-admin-token": token } : {}
    });
    if (res.status === 401) { doLogout(); toast("Session expired, please log in again", true); return { success: false }; }
    return await res.json();
  } catch (e) {
    toast("Upload issue", true);
    return { success: false };
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

// ===========================================================================
// AUTH
// ===========================================================================
$("btn-login").addEventListener("click", doLogin);
$("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const username = $("login-username").value.trim();
  const password = $("login-password").value.trim();
  const r = await api("/api/admin/login", "POST", { username, password, panelType: PANEL_TYPE });
  if (r.success) {
    token = r.token;
    localStorage.setItem("pp_admin_token", token);
    enterShell();
  } else {
    $("login-error").textContent = r.message || "Incorrect username/password";
    $("login-error").classList.remove("hidden");
  }
}

$("btn-logout").addEventListener("click", async () => {
  if (token) await api("/api/admin/logout", "POST");
  doLogout();
});

function doLogout() {
  token = null;
  localStorage.removeItem("pp_admin_token");
  clearInterval(liveTimer);
  $("app-shell").classList.add("hidden");
  $("view-login").classList.add("active");
  $("login-password").value = "";
}

let myAdminProfile = null; // { admin, permissions, visibleSections } from /api/admin/me

async function enterShell() {
  $("view-login").classList.remove("active");
  $("app-shell").classList.remove("hidden");
  await loadMyProfile();
  applySidebarPermissions();
  applyApprovalCenterVisibility();
  anApplyVisibility();
  loadDashboard();
  liveTimer = setInterval(loadDashboard, 10000);
}

// Approval Center aggregates 8 modules with different permission prefixes,
// so it can't use the single data-permission="x" gate every other sidebar
// button uses (see applySidebarPermissions above). It's visible if the
// current role holds *any* view permission across the approval modules —
// which, per the existing DEFAULT_ROLE_PERMISSIONS in rbac.js, already
// naturally means: Owner/Global/Country Super Admin → full, Country
// Manager → view+review only, Admin → view+submit only, Moderator → none
// (hidden). No backend/RBAC change needed for this — it only reads the
// permissions list /api/admin/me already returns.
function applyApprovalCenterVisibility() {
  const btn = $("side-approval-center");
  if (!btn || !myAdminProfile) return;
  const perms = myAdminProfile.permissions || [];
  const anyModuleAccess = AC_MODULES.some((m) => perms.includes(m.viewPerm));
  btn.classList.toggle("hidden", !anyModuleAccess);
}

async function loadMyProfile() {
  const r = await api("/api/admin/me");
  if (r.success) myAdminProfile = r;
}

// Hides sidebar buttons the current role has no permission for. Existing
// sections' own load functions are untouched — this only controls
// whether the button/section is reachable at all.
function applySidebarPermissions() {
  if (!myAdminProfile) return;
  const visible = new Set(myAdminProfile.visibleSections || []);
  document.querySelectorAll(".side-item[data-permission]").forEach((btn) => {
    const section = btn.getAttribute("data-section");
    const allowed = visible.has(section);
    btn.classList.toggle("hidden", !allowed);
    if (!allowed && btn.classList.contains("active")) {
      // If the currently-active section just got hidden (role switch),
      // fall back to Dashboard.
      btn.classList.remove("active");
      document.querySelector('.side-item[data-section="dashboard"]').classList.add("active");
      document.querySelectorAll(".sec").forEach((s) => s.classList.remove("active"));
      $("sec-dashboard").classList.add("active");
    }
  });
}

// ===========================================================================
// SIDEBAR ROUTING
// ===========================================================================
document.querySelectorAll(".side-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".side-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".sec").forEach((s) => s.classList.remove("active"));
    btn.classList.add("active");
    const section = btn.getAttribute("data-section");
    $("sec-" + section).classList.add("active");
    if (section !== "analytics" && anLiveTimer) { clearInterval(anLiveTimer); anLiveTimer = null; }
    if (section !== "voice-sfu" && vsfuAutoTimer) { clearInterval(vsfuAutoTimer); vsfuAutoTimer = null; } // PHASE 3, STEP 3.6
    if (section === "users") loadUsers();
    if (section === "rooms") loadRooms();
    if (section === "cs101") loadCs101Admin();
    if (section === "economy") loadEconomy();
    if (section === "coin-center") loadCoinCenter();
    if (section === "frames") loadFrames();
    if (section === "tags") updateTagPreview();
    if (section === "svip-tags") loadSvipTags();
    if (section === "gift-manager") loadGiftManager();
    if (section === "video-gifts") loadVideoGifts();
    if (section === "vehicles") loadVehicles();
    if (section === "agencies") loadAgencies();
    if (section === "merchants") loadMerchants();
    if (section === "coin-sellers") loadCoinSellers();
    if (section === "payment-recharge") loadPaymentRecharge();
    if (section === "chest") loadChestLevels();
    if (section === "theme-library") loadThemeLibraryAdmin();
    if (section === "banner-management") loadBannerManagement();
    if (section === "level-management") loadLevelManagement();
    if (section === "badge-management") loadBadgeManagement();
    if (section === "super-admin") loadGodPowerList();
    if (section === "ai-core") loadAiCore();
    if (section === "role-management") loadRoleManagement();
    if (section === "call-hosting") chEnterSection();
    if (section === "voice-sfu") vsfuEnterSection();
    if (section === "relationship-settings") loadRelationshipSettings();
    if (section === "approval-center") acEnterSection();
    if (section === "ban-management") bmEnterSection();
    if (section === "analytics") anEnterSection();
  });
});

// ===========================================================================
// DASHBOARD (live)
// ===========================================================================
async function loadDashboard() {
  const stats = await api("/api/admin/stats");
  if (stats.success) {
    $("dash-users").textContent = stats.stats.totalUsers;
    $("dash-rooms").textContent = stats.stats.totalRooms;
    $("dash-online").textContent = stats.stats.onlineCount;
    $("dash-banned").textContent = stats.stats.bannedCount;
    $("strip-users").textContent = stats.stats.totalUsers;
  }

  const live = await api("/api/admin/live");
  if (live.success) {
    $("strip-online").textContent = live.totalOnline;
    $("strip-rooms").textContent = live.activeRooms.length;

    const wrap = $("live-rooms-list");
    wrap.innerHTML = "";
    $("live-rooms-empty").classList.toggle("hidden", live.activeRooms.length > 0);
    live.activeRooms.forEach((r) => {
      const row = document.createElement("div");
      row.className = "data-row";
      const names = r.onlineUsers.slice(0, 5).map((u) => escapeHtml(u.userName)).join(", ");
      row.innerHTML = `
        <div class="data-row-main"><b>${escapeHtml(r.roomName)}</b><span class="sub">Host: ${escapeHtml(r.hostName)} · ${names}${r.onlineUsers.length > 5 ? " +" + (r.onlineUsers.length - 5) + " more" : ""}</span></div>
        <span class="badge badge-ok">${r.onlineCount} online</span>
      `;
      wrap.appendChild(row);
    });
  }
}

// ===========================================================================
// USERS
// ===========================================================================
$("btn-refresh-users").addEventListener("click", loadUsers);
$("user-search").addEventListener("input", renderUsersTable);

async function loadUsers() {
  const r = await api("/api/admin/users");
  if (r.success) { allUsersCache = r.users; renderUsersTable(); }
}

function renderUsersTable() {
  const q = $("user-search").value.trim().toLowerCase();
  const tbody = $("users-tbody");
  tbody.innerHTML = "";
  const filtered = allUsersCache.filter((u) =>
    !q || u.name.toLowerCase().includes(q) || u.userId.includes(q) || u.mobile.includes(q)
  );
  filtered.forEach((u) => {
    const tr = document.createElement("tr");
    // First Time Profile Setup: real country + flag once the user has set
    // one via the profile screen; falls back to the coarse RBAC region
    // (COUNTRY_LABELS, IN/BD/PK/AR/OTHERS) for accounts that pre-date this
    // feature or haven't completed setup yet — never shows a blank cell.
    const countryCell = u.country
      ? `${u.countryFlag || ""} ${escapeHtml(u.countryName || u.country)}`
      : `<span class="muted">${escapeHtml(COUNTRY_LABELS[u.countryId] || u.countryId || "—")}</span>`;
    tr.innerHTML = `
      <td><b>${escapeHtml(u.name)}</b><br><span class="mono">${escapeHtml(u.userId)}</span>${u.customId ? `<br><span class="mono custom-id-golden">★ ${escapeHtml(u.customId)}</span>` : ""}</td>
      <td class="mono">${escapeHtml(u.mobile)}</td>
      <td>${countryCell}</td>
      <td class="mono"><img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> ${u.coins}</td>
      <td class="mono"><img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> ${u.diamonds}</td>
      <td>VIP ${u.vipLevel}${u.verified ? ' <span class="badge badge-ok">✔ verified</span>' : ""}</td>
      <td>${u.banned ? '<span class="badge badge-danger">Banned</span>' : '<span class="badge badge-ok">Active</span>'}</td>
      <td class="cell-actions">
        <button class="btn btn-sm ${u.banned ? "btn-ghost" : "btn-danger"} act-ban">${u.banned ? "Unban" : "Ban"}</button>
        <button class="btn btn-sm btn-ghost act-verify">${u.verified ? "Unverify" : "Verify"}</button>
        <button class="btn btn-sm btn-warn act-coins">Coins</button>
        <button class="btn btn-sm btn-ghost act-custom-id">Custom ID</button>
        <button class="btn btn-sm btn-danger act-delete">Delete</button>
      </td>
    `;
    tr.querySelector(".act-ban").addEventListener("click", async () => {
      const r = await api(`/api/admin/users/${u.mobile}/ban`, "POST", { banned: !u.banned });
      if (r.success) { toast(u.banned ? "Unbanned" : "Banned"); loadUsers(); } else toast(r.message, true);
    });
    tr.querySelector(".act-verify").addEventListener("click", async () => {
      const r = await api(`/api/admin/users/${u.mobile}/verify`, "POST", { verified: !u.verified });
      if (r.success) { toast("Updated"); loadUsers(); } else toast(r.message, true);
    });
    tr.querySelector(".act-coins").addEventListener("click", async () => {
      const val = prompt("New coin amount:", u.coins);
      if (val === null) return;
      const coins = Number(val);
      if (isNaN(coins) || coins < 0) { toast("Provide a valid number", true); return; }
      const r = await api(`/api/admin/users/${u.mobile}/coins`, "POST", { coins });
      if (r.success) { toast("Coins updated"); loadUsers(); } else toast(r.message, true);
    });
    tr.querySelector(".act-custom-id").addEventListener("click", async () => {
      const val = prompt("Custom ID Number (leave empty and press OK to delete):", u.customId || "");
      if (val === null) return;
      const r = await api(`/api/admin/users/${u.mobile}/custom-id`, "POST", { customId: val.trim() });
      if (r.success) { toast(r.customId ? "Custom ID set" : "Custom ID removed"); loadUsers(); } else toast(r.message, true);
    });
    tr.querySelector(".act-delete").addEventListener("click", async () => {
      if (!confirm(`Delete ${u.name} (${u.userId}) permanently? This cannot be undone.`)) return;
      const r = await api(`/api/admin/users/${u.mobile}`, "DELETE");
      if (r.success) { toast("User deleted"); loadUsers(); } else toast(r.message, true);
    });
    tbody.appendChild(tr);
  });
}

// ===========================================================================
// ROOMS
// ===========================================================================
$("btn-refresh-rooms").addEventListener("click", loadRooms);

async function loadRooms() {
  const r = await api("/api/admin/rooms");
  const tbody = $("rooms-tbody");
  tbody.innerHTML = "";
  if (!r.success) return;
  r.rooms.forEach((room) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${escapeHtml(room.roomName)}</b><br><span class="mono">${escapeHtml(room.roomId)}</span></td>
      <td>${escapeHtml(room.hostName)}</td>
      <td class="mono">👥 ${room.onlineCount}</td>
      <td>${room.roomLocked ? '<span class="badge badge-danger">Locked</span>' : '<span class="badge badge-ok">Open</span>'}
        ${room.gameEnabled ? '<span class="badge badge-ok">Game On</span>' : '<span class="badge badge-danger">Game Off</span>'}</td>
      <td class="cell-actions">
        <button class="btn btn-sm ${room.roomLocked ? "btn-ghost" : "btn-warn"} act-lock">${room.roomLocked ? "Unlock" : "Lock"}</button>
        <button class="btn btn-sm ${room.gameEnabled ? "btn-warn" : "btn-ghost"} act-game">${room.gameEnabled ? "Turn Off Game" : "Turn On Game"}</button>
        <button class="btn btn-sm btn-danger act-del">Delete</button>
      </td>
    `;
    tr.querySelector(".act-lock").addEventListener("click", async () => {
      const r2 = await api(`/api/admin/rooms/${room.roomId}/lock`, "POST", { locked: !room.roomLocked });
      if (r2.success) { toast("Room updated"); loadRooms(); } else toast(r2.message, true);
    });
    tr.querySelector(".act-game").addEventListener("click", async () => {
      const r2 = await api(`/api/admin/rooms/${room.roomId}/game`, "POST", { enabled: !room.gameEnabled });
      if (r2.success) { toast("Game setting updated"); loadRooms(); } else toast(r2.message, true);
    });
    tr.querySelector(".act-del").addEventListener("click", async () => {
      if (!confirm(`Delete room "${room.roomName}"?`)) return;
      const r2 = await api(`/api/admin/rooms/${room.roomId}`, "DELETE");
      if (r2.success) { toast("Room deleted"); loadRooms(); } else toast(r2.message, true);
    });
    tbody.appendChild(tr);
  });
}

// ===========================================================================
// AI CUSTOMER SERVICE ROOM 101
// ===========================================================================
async function loadCs101Admin() {
  const r = await api("/api/admin/cs101");
  if (!r.success) return;
  const c = r.config || {};
  $("cs101-admin-name").value = c.agentName || "";
  $("cs101-admin-greeting").value = c.greeting || "";
  $("cs101-admin-instruction").value = c.instruction || "";
  $("cs101-admin-enabled").checked = c.enabled !== false;
  $("cs101-admin-voice").checked = c.voiceEnabled !== false;
  $("cs101-admin-rate").value = c.voiceRate ?? 0.96;
  $("cs101-admin-pitch").value = c.voicePitch ?? 1.08;
  if ($("cs101-admin-room-admin")) $("cs101-admin-room-admin").value = c.roomAdminName || c.agentName || "Robin";
  if ($("cs101-admin-open-seats")) $("cs101-admin-open-seats").value = c.openSeatCount ?? 2;
  if ($("cs101-admin-room-bg-preview")) renderCs101AdminRoomBg(c.roomBackgroundUrl);
  if ($("cs101-admin-official-ids")) $("cs101-admin-official-ids").value = Array.isArray(c.officialUserIds) ? c.officialUserIds.join("\n") : "";
  const contacts = c.officialContacts || {};
  if ($("cs101-admin-labib")) $("cs101-admin-labib").value = contacts.labibName || "Official Labib";
  if ($("cs101-admin-rakesh")) $("cs101-admin-rakesh").value = contacts.rakeshName || "Official Rakesh";
  if ($("cs101-admin-phone")) $("cs101-admin-phone").value = contacts.phone || "8101221193";
  renderCs101AdminAvatar(c.avatarUrl);
  if ($("cs101-vapi-demo-url")) $("cs101-vapi-demo-url").value = c.vapiDemoUrl || "";
  checkCs101VapiConfig();
  refreshCs101VoiceHealth();
  startCs101VoiceHealthPolling();
}

async function checkCs101VapiConfig() {
  const badge = $("cs101-vapi-status");
  const help = $("cs101-vapi-help");
  try {
    const r = await api("/api/vapi/config");
    if (!r.success || !r.enabled || !r.publicKey || !r.assistantId) {
      if (badge) { badge.textContent = "Not configured"; badge.className = "badge badge-danger"; }
      if (help) help.textContent = "Set VAPI_PUBLIC_KEY and VAPI_ASSISTANT_ID in the deployment .env, then restart the server.";
      return;
    }
    if ($("cs101-vapi-public-key")) $("cs101-vapi-public-key").value = r.publicKey;
    if ($("cs101-vapi-assistant-id")) $("cs101-vapi-assistant-id").value = r.assistantId;
    if (badge) { badge.textContent = "Configured"; badge.className = "badge badge-ok"; }
    if (help) help.textContent = "Public configuration is available. Browser voice also requires microphone permission and HTTPS when opened by an IP/public domain.";
  } catch (e) {
    if (badge) { badge.textContent = "Check failed"; badge.className = "badge badge-danger"; }
    if (help) help.textContent = "Could not reach /api/vapi/config.";
  }
}

$("cs101-vapi-check")?.addEventListener("click", checkCs101VapiConfig);
$("cs101-vapi-demo-open")?.addEventListener("click", () => {
  const url = String($("cs101-vapi-demo-url")?.value || "").trim();
  if (!url) return toast("Add a Vapi Demo Link first", true);
  window.open(url, "_blank", "noopener,noreferrer");
});

// Robin Live Voice Health — surfaces real customer-facing voice failures
// (reported by public/vapi-support.js via socket "cs101:voice-error") so an
// admin can see "is Robin actually working for customers right now" instead
// of only the static config-is-present check above.
async function refreshCs101VoiceHealth() {
  const badge = $("cs101-voice-health-badge");
  const list = $("cs101-voice-error-list");
  try {
    const r = await api("/api/admin/cs101/voice-health");
    if (!r.success) throw new Error("request failed");
    if (badge) {
      if (r.healthy) {
        badge.textContent = "Healthy — no failures in the last 15 min";
        badge.className = "badge badge-ok";
      } else {
        badge.textContent = `${r.recentErrorCount} failure(s) in the last 15 min`;
        badge.className = "badge badge-danger";
      }
    }
    if (list) {
      if (!r.errors || !r.errors.length) {
        list.innerHTML = '<div class="hint">No voice failures recorded yet.</div>';
      } else {
        list.innerHTML = r.errors.map(e => {
          const when = new Date(e.ts).toLocaleString();
          const seat = e.seat ? `Seat ${escapeHtml(String(e.seat))}` : "Seat unknown";
          return `<div style="padding:6px 0;border-bottom:1px solid var(--line);">
            <div><strong>${escapeHtml(when)}</strong> — ${seat} — User ${escapeHtml(String(e.userId || "unknown"))}</div>
            <div class="hint">${escapeHtml(e.reason || "Unknown error")}</div>
          </div>`;
        }).join("");
      }
    }
  } catch (e) {
    if (badge) { badge.textContent = "Could not load voice health"; badge.className = "badge badge-warn"; }
  }
}
let cs101VoiceHealthTimer = null;
function startCs101VoiceHealthPolling() {
  if (cs101VoiceHealthTimer) clearInterval(cs101VoiceHealthTimer);
  cs101VoiceHealthTimer = setInterval(() => {
    const sec = document.getElementById("sec-cs101");
    if (sec && !sec.classList.contains("hidden")) refreshCs101VoiceHealth();
  }, 5000);
}
$("cs101-voice-health-refresh")?.addEventListener("click", refreshCs101VoiceHealth);

$("cs101-vapi-mic-check")?.addEventListener("click", async () => {
  const badge = $("cs101-vapi-status");
  const help = $("cs101-vapi-help");
  try {
    const host = String(location.hostname || "").toLowerCase();
    const localDevHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!window.isSecureContext && !localDevHost) throw new Error("HTTPS is required for microphone access on this host.");
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone API is unavailable in this browser.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    if (badge) { badge.textContent = "Microphone OK"; badge.className = "badge badge-ok"; }
    if (help) help.textContent = "Browser microphone permission is available.";
  } catch (e) {
    if (badge) { badge.textContent = "Microphone blocked"; badge.className = "badge badge-danger"; }
    if (help) help.textContent = e.message || "Microphone permission failed.";
  }
});
function renderCs101AdminAvatar(url) {
  const box = $("cs101-admin-avatar-preview");
  if (!box) return;
  box.innerHTML = `<img src="${escapeHtml(url || "/photos/cs101-female.svg")}" alt="AI" style="width:100%;height:100%;object-fit:cover;">`;
}
$("cs101-admin-save")?.addEventListener("click", async () => {
  const r = await api("/api/admin/cs101", "PUT", {
    agentName: $("cs101-admin-name").value,
    greeting: $("cs101-admin-greeting").value,
    instruction: $("cs101-admin-instruction").value,
    enabled: $("cs101-admin-enabled").checked,
    voiceEnabled: $("cs101-admin-voice").checked,
    voiceRate: Number($("cs101-admin-rate").value),
    voicePitch: Number($("cs101-admin-pitch").value),
    vapiDemoUrl: $("cs101-vapi-demo-url")?.value || "",
    roomAdminName: $("cs101-admin-room-admin")?.value || "Robin",
    openSeatCount: Number($("cs101-admin-open-seats")?.value || 2),
    officialUserIds: String($("cs101-admin-official-ids")?.value || "").split(/\s+/).map(s => s.trim()).filter(Boolean),
    officialContacts: {
      labibName: $("cs101-admin-labib")?.value || "Official Labib",
      rakeshName: $("cs101-admin-rakesh")?.value || "Official Rakesh",
      phone: $("cs101-admin-phone")?.value || "8101221193"
    }
  });
  if (r.success) { toast("Room 101 AI settings applied live"); renderCs101AdminAvatar(r.config.avatarUrl); } else toast(r.message || "Save failed", true);
});
$("cs101-admin-upload")?.addEventListener("click", async () => {
  const file = $("cs101-admin-avatar")?.files?.[0];
  if (!file) return toast("Choose an image first", true);
  const fd = new FormData(); fd.append("avatar", file);
  const r = await apiUpload("/api/admin/cs101/avatar", fd);
  if (r.success) { toast("AI image updated live"); renderCs101AdminAvatar(r.avatarUrl); } else toast(r.message || "Upload failed", true);
});


function renderCs101AdminRoomBg(url) {
  const box = $("cs101-admin-room-bg-preview");
  if (!box) return;
  box.style.backgroundImage = `url("${String(url || "/images/room-default-theme.jpg").replace(/"/g, "")}")`;
}
$("cs101-admin-room-bg-upload")?.addEventListener("click", async () => {
  const file = $("cs101-admin-room-bg")?.files?.[0];
  if (!file) return toast("Choose a room image first", true);
  const fd = new FormData(); fd.append("background", file);
  const r = await apiUpload("/api/admin/cs101/room-image", fd);
  if (r.success) { toast("Room 101 image updated live"); renderCs101AdminRoomBg(r.roomBackgroundUrl); } else toast(r.message || "Upload failed", true);
});
// ===========================================================================
// ECONOMY
// ===========================================================================
async function loadEconomy() {
  const ex = await api("/api/admin/exchanges");
  const tbody = $("exchanges-tbody");
  tbody.innerHTML = "";
  if (ex.success) ex.exchanges.forEach((e) => {
    const tr = document.createElement("tr");
    const statusBadge = e.status === "pending" ? '<span class="badge badge-warn">Pending</span>'
      : e.status === "approved" ? '<span class="badge badge-ok">Approved</span>'
      : '<span class="badge badge-danger">Rejected</span>';
    tr.innerHTML = `
      <td><b>${escapeHtml(e.userName)}</b><br><span class="mono">${escapeHtml(e.userId)}</span></td>
      <td class="mono"><img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> ${e.diamonds}</td>
      <td>${escapeHtml(e.note || "—")}</td>
      <td>${statusBadge}</td>
      <td class="cell-actions">
        ${e.status === "pending" ? `<button class="btn btn-sm btn-primary act-approve">Approve</button><button class="btn btn-sm btn-danger act-reject">Reject</button>` : ""}
      </td>
    `;
    if (e.status === "pending") {
      tr.querySelector(".act-approve").addEventListener("click", async () => {
        const r = await api(`/api/admin/exchanges/${e.id}/decide`, "POST", { approve: true });
        if (r.success) { toast("Approved"); loadEconomy(); } else toast(r.message, true);
      });
      tr.querySelector(".act-reject").addEventListener("click", async () => {
        const r = await api(`/api/admin/exchanges/${e.id}/decide`, "POST", { approve: false });
        if (r.success) { toast("Rejected"); loadEconomy(); } else toast(r.message, true);
      });
    }
    tbody.appendChild(tr);
  });

  const gifts = await api("/api/gifts/history");
  const giftWrap = $("gift-log-list");
  giftWrap.innerHTML = "";
  if (gifts.success) gifts.gifts.slice(0, 30).forEach((g) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `<div class="data-row-main">${escapeHtml(g.fromName)} → ${escapeHtml(g.toName)} <b>🎁 ${escapeHtml(g.gift.name)}</b><span class="sub">${new Date(g.time).toLocaleString()}</span></div>`;
    giftWrap.appendChild(row);
  });
}

// ===========================================================================
// FRAMES
// ===========================================================================
async function loadFrames() {
  const r = await api("/api/frames/catalog");
  const select = $("frame-select");
  select.innerHTML = "";
  const wrap = $("frame-catalog-list");
  wrap.innerHTML = "";
  if (r.success) r.frames.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id; opt.textContent = f.name;
    select.appendChild(opt);

    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `<div class="data-row-main"><b>${escapeHtml(f.name)}</b><span class="sub">${escapeHtml(f.id)}${f.imageUrl ? " · uploaded PNG" : ""}</span></div>${f.vipOnly ? '<span class="badge badge-warn">VIP only</span>' : ""}`;
    wrap.appendChild(row);
  });
}

$("btn-upload-frame").addEventListener("click", async () => {
  const file = $("frame-upload-file").files[0];
  if (!file) { toast("Select a PNG file", true); return; }
  const fd = new FormData();
  fd.append("frame", file);
  fd.append("name", $("frame-upload-name").value.trim());
  fd.append("vipOnly", $("frame-upload-vip").checked ? "true" : "false");
  const r = await apiUpload("/api/admin/frames/upload", fd);
  if (r.success) {
    toast("Frame uploaded");
    $("frame-upload-name").value = "";
    $("frame-upload-file").value = "";
    $("frame-upload-vip").checked = false;
    loadFrames();
  } else toast(r.message || "Upload failed", true);
});

// ===========================================================================
// SVIP TAGS (per-level PNG, SVIP1–8)
// ===========================================================================
async function loadSvipTags() {
  const r = await api("/api/svip/tags");
  const wrap = $("svip-tags-list");
  wrap.innerHTML = "";
  if (!r.success) return;
  r.tags.forEach((t) => {
    const row = document.createElement("div");
    row.className = "data-row";
    const preview = t.tag
      ? `<img src="${t.tag}?v=${t.tagVersion}" alt="SVIP${t.level}" style="width:40px;height:40px;object-fit:contain;background:repeating-conic-gradient(#00000022 0% 25%, transparent 0% 50%) 50% / 12px 12px;border-radius:6px;">`
      : `<span class="sub">No tag</span>`;
    row.innerHTML = `
      <div class="data-row-main" style="display:flex;align-items:center;gap:12px;">
        ${preview}
        <b>SVIP${t.level}</b>
      </div>
      <div class="form-row" style="margin:0;">
        <input type="file" accept="image/png" class="field" id="svip-tag-file-${t.level}">
        <button class="btn btn-primary" data-svip-upload="${t.level}">Upload</button>
        ${t.tag ? `<button class="btn btn-ghost" data-svip-remove="${t.level}">Remove</button>` : ""}
      </div>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll("[data-svip-upload]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const level = btn.getAttribute("data-svip-upload");
      const file = $(`svip-tag-file-${level}`).files[0];
      if (!file) { toast("Select a PNG file", true); return; }
      const fd = new FormData();
      fd.append("tag", file);
      const r = await apiUpload(`/api/admin/svip-tags/${level}/upload`, fd);
      if (r.success) { toast(`SVIP${level} tag uploaded`); loadSvipTags(); }
      else toast(r.message || "Upload failed", true);
    });
  });
  wrap.querySelectorAll("[data-svip-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const level = btn.getAttribute("data-svip-remove");
      const r = await api(`/api/admin/svip-tags/${level}`, "DELETE");
      if (r.success) { toast(`SVIP${level} Tag removed`); loadSvipTags(); }
      else toast(r.message || "Failed", true);
    });
  });

  // Only offer levels that actually have an uploaded tag to assign.
  const assignSelect = $("svip-assign-level");
  assignSelect.innerHTML = r.tags.filter((t) => t.tag).map((t) => `<option value="${t.level}">SVIP${t.level}</option>`).join("")
    || `<option value="">No tag uploaded</option>`;
}

$("btn-svip-assign").addEventListener("click", async () => {
  const targetUserId = $("svip-assign-target").value.trim();
  const level = $("svip-assign-level").value;
  if (!targetUserId || !level) { toast("Provide a User ID and select a tag", true); return; }
  const r = await api("/api/admin/svip-tags/assign", "POST", { targetUserId, level });
  if (r.success) { toast(`SVIP${level} tag assigned to ${targetUserId}`); }
  else toast(r.message || "Failed", true);
});
$("btn-svip-unassign").addEventListener("click", async () => {
  const targetUserId = $("svip-assign-target").value.trim();
  if (!targetUserId) { toast("Provide a User ID", true); return; }
  const r = await api("/api/admin/svip-tags/unassign", "POST", { targetUserId });
  if (r.success) { toast(`Tag removed`); }
  else toast(r.message || "Failed", true);
});

$("btn-send-frame").addEventListener("click", async () => {
  const targetUserId = $("frame-target").value.trim();
  const frameId = $("frame-select").value;
  const expiryDays = $("frame-days").value ? Number($("frame-days").value) : undefined;
  if (!targetUserId || !frameId) { toast("Provide a User ID and select a Frame", true); return; }
  const r = await api("/api/admin/frames/send", "POST", { targetUserId, frameId, expiryDays });
  if (r.success) { toast("Frame sent"); $("frame-target").value = ""; } else toast(r.message, true);
});

// ===========================================================================
// TAGS (admin-assigned coloured badge next to a user's name)
// ===========================================================================
function tagPreviewTextColor(hex) {
  const h = (hex || "").replace("#", "");
  if (h.length !== 6) return "#1c1424";
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.55 ? "#1c1424" : "#fbf6ea";
}
function updateTagPreview() {
  const box = $("tag-preview");
  if (!box) return;
  const text = $("tag-text").value.trim();
  const color = $("tag-color").value;
  if (!text) { box.innerHTML = "<span class=\"hint\">Write text to see a preview</span>"; return; }
  box.innerHTML = `<span class="tag-preview-badge" style="background:${color};color:${tagPreviewTextColor(color)}">${escapeHtml(text)}</span>`;
}
$("tag-text").addEventListener("input", updateTagPreview);
$("tag-color").addEventListener("input", updateTagPreview);
$("btn-send-tag").addEventListener("click", async () => {
  const targetUserId = $("tag-target").value.trim();
  const text = $("tag-text").value.trim();
  const color = $("tag-color").value;
  if (!targetUserId || !text) { toast("Provide a User ID and Tag text", true); return; }
  const r = await api("/api/admin/tags/send", "POST", { targetUserId, text, color });
  if (r.success) toast("Tag sent"); else toast(r.message || "Failed", true);
});
$("btn-remove-tag").addEventListener("click", async () => {
  const targetUserId = $("tag-target").value.trim();
  if (!targetUserId) { toast("Provide a User ID", true); return; }
  const r = await api("/api/admin/tags/send", "POST", { targetUserId, text: "", color: "" });
  if (r.success) toast("Tag removed"); else toast(r.message || "Failed", true);
});

// ===========================================================================
// BADGE MANAGEMENT (Premium Badges, e.g. Blue Diamond V) — see badges.js
// ===========================================================================
let badgeCatalogCache = [];
async function loadBadgeManagement() {
  loadBadgeHistory();
  const r = await api("/api/admin/badges/catalog");
  const select = $("badge-select");
  select.innerHTML = "";
  if (!r.success) return;
  badgeCatalogCache = r.catalog;
  r.catalog.forEach((b) => {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.name;
    select.appendChild(opt);
  });
  updateBadgePreview();
  const first = badgeCatalogCache[0];
  $("badge-size-seat").value = first ? first.seatSize : "";
  $("badge-size-profile").value = first ? first.profileSize : "";
}
function updateBadgePreview() {
  const box = $("badge-preview");
  if (!box) return;
  const badge = badgeCatalogCache.find((b) => b.id === $("badge-select").value);
  box.innerHTML = badge
    ? `<img src="${badge.imageUrl}" alt="${escapeHtml(badge.name)}" style="width:56px;height:56px;object-fit:contain;">`
    : '<span class="hint">No badge selected</span>';
}
$("badge-select").addEventListener("change", () => {
  updateBadgePreview();
  const badge = badgeCatalogCache.find((b) => b.id === $("badge-select").value);
  $("badge-size-seat").value = badge ? badge.seatSize : "";
  $("badge-size-profile").value = badge ? badge.profileSize : "";
});
$("btn-save-badge-size").addEventListener("click", async () => {
  const badge_id = $("badge-select").value;
  if (!badge_id) { toast("Add a badge to the catalog first", true); return; }
  const seatSize = Number($("badge-size-seat").value);
  const profileSize = Number($("badge-size-profile").value);
  if (!seatSize || !profileSize) { toast("Provide both sizes", true); return; }
  const r = await api("/api/admin/badges/size", "POST", { badge_id, seatSize, profileSize });
  if (r.success) { toast("Badge size saved — applies live for everyone"); loadBadgeManagement(); }
  else toast(r.message || "Failed", true);
});
$("btn-send-badge").addEventListener("click", async () => {
  const pingpong_id = $("badge-target").value.trim();
  const badge_id = $("badge-select").value;
  if (!pingpong_id) { toast("Provide a PingPong ID", true); return; }
  if (!badge_id) { toast("Add a badge to the catalog first", true); return; }
  const r = await api("/api/admin/badges/send", "POST", { pingpong_id, badge_id });
  if (r.success) { toast("Badge sent successfully."); loadBadgeHistory(); }
  else toast(r.message || "Failed", true);
});
$("btn-remove-badge").addEventListener("click", async () => {
  const pingpong_id = $("badge-target").value.trim();
  const badge_id = $("badge-select").value;
  if (!pingpong_id) { toast("Provide a PingPong ID", true); return; }
  if (!badge_id) { toast("Select a badge to remove", true); return; }
  const r = await api("/api/admin/badges/remove", "POST", { pingpong_id, badge_id });
  if (r.success) { toast("Badge removed"); loadBadgeHistory(); }
  else toast(r.message || "Failed", true);
});
async function loadBadgeHistory() {
  const r = await api("/api/admin/badges/history");
  const wrap = $("badge-history-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!r.success) return;
  if (!r.history.length) { wrap.innerHTML = '<p class="hint">No badge activity yet.</p>'; return; }
  r.history.forEach((h) => {
    const badge = badgeCatalogCache.find((b) => b.id === h.badge_id);
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <div class="data-row-main"><b>${escapeHtml(badge ? badge.name : h.badge_id)}</b> → ${escapeHtml(h.pingpong_id)}
        <span class="sub">${h.action === "send" ? "Sent" : "Removed"} · by ${escapeHtml((h.sent_by && h.sent_by.username) || "-")} · ${new Date(h.created_at).toLocaleString()}</span>
      </div>
    `;
    wrap.appendChild(row);
  });
}

// ===========================================================================
// PROFILE NAME COLOR (VIP Name Effects Library)
// ===========================================================================
$("btn-namefx-apply").addEventListener("click", async () => {
  const targetUserId = $("namefx-target").value.trim();
  const style = $("namefx-style").value;
  if (!targetUserId) { toast("Provide a User ID", true); return; }
  const r = await api("/api/admin/name-effects/assign", "POST", { targetUserId, style });
  if (r.success) toast("Name Style applied"); else toast(r.message || "Failed", true);
});
$("btn-namefx-remove").addEventListener("click", async () => {
  const targetUserId = $("namefx-target").value.trim();
  if (!targetUserId) { toast("Provide a User ID", true); return; }
  const r = await api("/api/admin/name-effects/remove", "POST", { targetUserId });
  if (r.success) toast("Name Style removed"); else toast(r.message || "Failed", true);
});

// ===========================================================================
// GIFT MANAGER (regular Gift Box — Normal/VIP/Legend tabs)
// ===========================================================================
const GIFT_TIER_LABEL = { normal: "Normal", vip: "VIP", legend: "Legend" };
const GIFT_EFFECT_LABEL = { small: "Small Effect", full_screen: "Full Screen Effect" };

async function loadGiftManager() {
  const r = await api("/api/admin/gifts");
  const wrap = $("gift-catalog-list");
  wrap.innerHTML = "";
  if (!r.success) return;
  if (!r.gifts.length) { wrap.innerHTML = '<p class="hint">No Gifts added yet.</p>'; return; }
  r.gifts.forEach((g) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      ${g.image ? `<img src="${g.image}" style="width:44px;height:44px;object-fit:contain;border-radius:8px;background:var(--bg-raised);">` : `<span style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-size:20px;">🎁</span>`}
      <div class="data-row-main"><b>${escapeHtml(g.name)}</b><span class="sub">${g.price.toLocaleString()} <img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> · ${GIFT_TIER_LABEL[g.tier] || g.tier} · ${GIFT_EFFECT_LABEL[g.effectType] || g.effectType} ${g.sound ? "· 🔊" : ""} ${g.enabled === false ? "· Off" : ""}</span></div>
      <button class="btn btn-ghost btn-edit-gift" data-id="${g.id}">Edit</button>
      <button class="btn btn-ghost btn-toggle-gift" data-id="${g.id}">${g.enabled === false ? "Enable" : "Disable"}</button>
      <button class="btn btn-danger btn-delete-gift" data-id="${g.id}">Delete</button>
    `;
    wrap.appendChild(row);
  });
}

$("gift-catalog-list").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest(".btn-toggle-gift");
  if (toggleBtn) {
    const r = await api(`/api/admin/gifts/${toggleBtn.dataset.id}/toggle`, "POST");
    if (r.success) loadGiftManager(); else toast(r.message || "Failed", true);
    return;
  }
  const deleteBtn = e.target.closest(".btn-delete-gift");
  if (deleteBtn) {
    if (!confirm("Delete this Gift? It will also be removed from every user's Gift Box.")) return;
    const r = await api(`/api/admin/gifts/${deleteBtn.dataset.id}`, "DELETE");
    if (r.success) loadGiftManager(); else toast(r.message || "Failed", true);
    return;
  }
  const editBtn = e.target.closest(".btn-edit-gift");
  if (editBtn) {
    const id = editBtn.dataset.id;
    const name = prompt("Gift Name (leave empty to keep unchanged):", "");
    const priceStr = prompt("Coin Price (leave empty to keep unchanged):", "");
    const effectType = prompt("Effect Type — small or full_screen (leave empty to keep unchanged):", "");
    const tier = prompt("Tier — normal / vip / legend (leave empty to keep unchanged):", "");
    const fd = new FormData();
    if (name && name.trim()) fd.append("name", name.trim());
    if (priceStr && priceStr.trim()) fd.append("price", Number(priceStr.trim()));
    if (effectType && (effectType.trim() === "small" || effectType.trim() === "full_screen")) fd.append("effectType", effectType.trim());
    if (tier && ["normal", "vip", "legend"].includes(tier.trim())) fd.append("tier", tier.trim());
    const r = await apiUpload(`/api/admin/gifts/${id}/update`, fd);
    if (r.success) { toast("Gift updated"); loadGiftManager(); } else toast(r.message || "Failed", true);
  }
});

$("btn-upload-gift").addEventListener("click", async () => {
  const name = $("gift-name").value.trim();
  const price = Number($("gift-price").value);
  const effectType = $("gift-effect-type").value;
  const tier = $("gift-tier").value;
  const imageFile = $("gift-image-file").files[0];
  const soundFile = $("gift-sound-file").files[0];
  if (!name) { toast("Provide a Gift Name", true); return; }
  if (!price || price <= 0) { toast("Provide a valid Coin Price", true); return; }
  const fd = new FormData();
  fd.append("name", name);
  fd.append("price", price);
  fd.append("effectType", effectType);
  fd.append("tier", tier);
  if (imageFile) fd.append("image", imageFile);
  if (soundFile) fd.append("sound", soundFile);
  const r = await apiUpload("/api/admin/gifts/upload", fd);
  if (r.success) {
    toast("Gift added");
    $("gift-name").value = ""; $("gift-price").value = "";
    $("gift-image-file").value = ""; $("gift-sound-file").value = "";
    loadGiftManager();
  } else toast(r.message || "Failed to add", true);
});

// ===========================================================================
// VEHICLE MANAGEMENT (Add-on Vehicle Entry System)
// ===========================================================================
let vehicleCatalogCache = [];

async function loadVehicles() {
  loadVehicleHistory();
  const r = await api("/api/admin/vehicles");
  const wrap = $("vehicle-catalog-list");
  const select = $("veh-assign-select");
  wrap.innerHTML = "";
  select.innerHTML = "";
  if (!r.success) return;
  vehicleCatalogCache = r.vehicles;
  if (!r.vehicles.length) { wrap.innerHTML = '<p class="hint">No Vehicles added yet.</p>'; }
  r.vehicles.forEach((v) => {
    const row = document.createElement("div");
    row.className = "data-row";
    const tags = [v.premium ? "Premium" : "", v.limitedEdition ? "Limited" : "", v.enabled === false ? "Off" : ""].filter(Boolean).join(" · ");
    row.innerHTML = `
      ${v.thumbnailUrl ? `<img src="${v.thumbnailUrl}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;">` : ""}
      <div class="data-row-main"><b>${escapeHtml(v.name)}</b><span class="sub">${v.durationSeconds}s ${tags ? "· " + tags : ""}</span></div>
      <button class="btn btn-ghost btn-toggle-vehicle" data-id="${v.id}">${v.enabled === false ? "Enable" : "Disable"}</button>
      <button class="btn btn-danger btn-delete-vehicle" data-id="${v.id}">Delete</button>
    `;
    wrap.appendChild(row);
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.name;
    select.appendChild(opt);
  });
}

$("vehicle-catalog-list").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest(".btn-toggle-vehicle");
  if (toggleBtn) {
    const r = await api(`/api/admin/vehicles/${toggleBtn.dataset.id}/toggle`, "POST");
    if (r.success) loadVehicles(); else toast(r.message || "Failed", true);
    return;
  }
  const deleteBtn = e.target.closest(".btn-delete-vehicle");
  if (deleteBtn) {
    if (!confirm("Delete this Vehicle? It will also be removed from any user's inventory it's in.")) return;
    const r = await api(`/api/admin/vehicles/${deleteBtn.dataset.id}`, "DELETE");
    if (r.success) loadVehicles(); else toast(r.message || "Failed", true);
  }
});

$("btn-upload-vehicle").addEventListener("click", async () => {
  const name = $("veh-name").value.trim();
  const thumbFile = $("veh-thumb-file").files[0];
  const videoFile = $("veh-video-file").files[0];
  if (!name) { toast("Provide a Vehicle Name", true); return; }
  if (!thumbFile) { toast("Select a Thumbnail image", true); return; }
  if (!videoFile) { toast("Select an Entry Video (MP4/WebM)", true); return; }
  const fd = new FormData();
  fd.append("thumbnail", thumbFile);
  fd.append("video", videoFile);
  const musicFile = $("veh-music-file").files[0];
  const soundFile = $("veh-sound-file").files[0];
  if (musicFile) fd.append("music", musicFile);
  if (soundFile) fd.append("sound", soundFile);
  fd.append("name", name);
  fd.append("description", $("veh-desc").value.trim());
  fd.append("durationSeconds", $("veh-duration").value || "5");
  fd.append("displayOrder", $("veh-order").value || "0");
  fd.append("premium", $("veh-premium").checked);
  fd.append("limitedEdition", $("veh-limited").checked);
  if ($("veh-expiry").value) fd.append("expiryDate", $("veh-expiry").value);
  const r = await apiUpload("/api/admin/vehicles/upload", fd);
  if (r.success) {
    toast("Vehicle added");
    ["veh-name", "veh-desc", "veh-duration", "veh-order", "veh-expiry"].forEach((id) => $(id).value = "");
    ["veh-thumb-file", "veh-video-file", "veh-music-file", "veh-sound-file"].forEach((id) => $(id).value = "");
    $("veh-premium").checked = false; $("veh-limited").checked = false;
    loadVehicles();
  } else toast(r.message || "Upload failed", true);
});

$("btn-assign-vehicle").addEventListener("click", async () => {
  const target = $("veh-assign-target").value.trim();
  const vehicleId = $("veh-assign-select").value;
  const permanent = $("veh-assign-permanent").checked;
  const expiryDays = $("veh-assign-days").value;
  if (!target) { toast("Provide a Target User ID or Username", true); return; }
  if (!vehicleId) { toast("Add a Vehicle to the catalog first", true); return; }
  if (!permanent && !expiryDays) { toast("Provide Days, or check Permanent", true); return; }
  const r = await api("/api/admin/vehicles/assign", "POST", { target, vehicleId, permanent, expiryDays: permanent ? null : Number(expiryDays) });
  if (r.success) {
    toast("Vehicle assigned");
    $("veh-assign-target").value = ""; $("veh-assign-days").value = "";
    loadVehicleHistory();
  } else toast(r.message || "Failed", true);
});

async function loadVehicleHistory() {
  const r = await api("/api/admin/vehicles/history");
  const wrap = $("vehicle-history-list");
  wrap.innerHTML = "";
  if (!r.success) return;
  if (!r.history.length) { wrap.innerHTML = '<p class="hint">No assignments yet.</p>'; return; }
  r.history.forEach((h) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <div class="data-row-main"><b>${escapeHtml(h.vehicleName)}</b> → ${escapeHtml(h.userName || h.userId)}
        <span class="sub">${h.action === "assign" ? (h.permanent ? "Permanent" : "Until " + new Date(h.expiresAt).toLocaleDateString()) : "Removed"} · by ${escapeHtml(h.admin?.username || "-")} · ${new Date(h.at).toLocaleString()}</span>
      </div>
    `;
    wrap.appendChild(row);
  });
}


// ===========================================================================
// VIDEO GIFTS
// ===========================================================================
async function loadVideoGifts() {
  const r = await api("/api/admin/video-gifts");
  const wrap = $("vgift-catalog-list");
  wrap.innerHTML = "";
  if (!r.success) return;
  if (!r.gifts.length) { wrap.innerHTML = '<p class="hint">No Video Gifts added yet.</p>'; return; }
  r.gifts.forEach((g) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      ${g.thumbnail ? `<img src="${g.thumbnail}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;">` : ""}
      <div class="data-row-main"><b>${escapeHtml(g.name)}</b><span class="sub">${g.price.toLocaleString()} <img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> · ${g.duration}s ${g.enabled === false ? "· Off" : ""}</span></div>
      <button class="btn btn-ghost btn-toggle-vgift" data-id="${g.id}">${g.enabled === false ? "Enable" : "Disable"}</button>
      <button class="btn btn-danger btn-delete-vgift" data-id="${g.id}">Delete</button>
    `;
    wrap.appendChild(row);
  });
}

$("vgift-catalog-list").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest(".btn-toggle-vgift");
  if (toggleBtn) {
    const r = await api(`/api/admin/video-gifts/${toggleBtn.dataset.id}/toggle`, "POST");
    if (r.success) loadVideoGifts(); else toast(r.message || "Failed", true);
    return;
  }
  const deleteBtn = e.target.closest(".btn-delete-vgift");
  if (deleteBtn) {
    if (!confirm("Delete this Video Gift? It will also be removed from every user's Gift Box.")) return;
    const r = await api(`/api/admin/video-gifts/${deleteBtn.dataset.id}`, "DELETE");
    if (r.success) loadVideoGifts(); else toast(r.message || "Failed", true);
  }
});

$("btn-upload-vgift").addEventListener("click", async () => {
  const name = $("vgift-name").value.trim();
  const price = Number($("vgift-price").value);
  const duration = Number($("vgift-duration").value) || 6;
  const videoFile = $("vgift-video-file").files[0];
  const thumbFile = $("vgift-thumb-file").files[0];
  if (!name) { toast("Provide a Gift Name", true); return; }
  if (!videoFile) { toast("Select an MP4 video file", true); return; }
  if (!price || price < 100000) { toast("Coin Price must be at least 100000", true); return; }
  if (duration < 6 || duration > 8) { toast("Provide a Duration between 6-8 seconds", true); return; }
  const fd = new FormData();
  fd.append("video", videoFile);
  if (thumbFile) fd.append("thumbnail", thumbFile);
  fd.append("name", name);
  fd.append("price", price);
  fd.append("duration", duration);
  const r = await apiUpload("/api/admin/video-gifts/upload", fd);
  if (r.success) {
    toast("Video Gift uploaded");
    $("vgift-name").value = ""; $("vgift-price").value = ""; $("vgift-duration").value = "";
    $("vgift-video-file").value = ""; $("vgift-thumb-file").value = "";
    loadVideoGifts();
  } else toast(r.message || "Upload failed", true);
});

// ===========================================================================
// AGENCIES
// ===========================================================================
async function loadAgencies() {
  const r = await api("/api/admin/agency/list");
  const wrap = $("agencies-list");
  wrap.innerHTML = "";
  if (r.success) r.agencies.forEach((a) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `<div class="data-row-main"><b>${escapeHtml(a.name)}</b><span class="sub">ID: ${escapeHtml(a.agencyId)} · Owner: ${escapeHtml(a.ownerUserId)} · Hosts: ${a.hostIds.length} · Rate: ${(a.commissionRate * 100).toFixed(0)}%</span></div><span class="badge badge-ok"><img src="/images/icons/icon-diamond.png" class="currency-icon" alt="diamond"> ${a.earnedDiamonds || 0}</span>`;
    wrap.appendChild(row);
  });
}

$("btn-create-agency").addEventListener("click", async () => {
  const name = $("agency-name").value.trim();
  const ownerUserId = $("agency-owner").value.trim();
  const commissionRate = $("agency-rate").value ? Number($("agency-rate").value) : undefined;
  if (!name || !ownerUserId) { toast("Provide a name and Owner ID", true); return; }
  const r = await api("/api/admin/agency/create", "POST", { name, ownerUserId, commissionRate });
  if (r.success) { toast("Agency created"); $("agency-name").value = ""; $("agency-owner").value = ""; loadAgencies(); } else toast(r.message, true);
});

$("btn-assign-host").addEventListener("click", async () => {
  const agencyId = $("assign-agency-id").value.trim();
  const hostUserId = $("assign-host-id").value.trim();
  if (!agencyId || !hostUserId) { toast("Provide an Agency ID and Host ID", true); return; }
  const r = await api("/api/admin/agency/assign-host", "POST", { agencyId, hostUserId });
  if (r.success) { toast("Host assigned"); loadAgencies(); } else toast(r.message, true);
});

// ===========================================================================
// MERCHANTS
// ===========================================================================
async function loadMerchants() {
  const r = await api("/api/admin/merchants");
  const wrap = $("merchants-list");
  wrap.innerHTML = "";
  if (r.success) r.merchants.forEach((m) => {
    const row = document.createElement("div");
    row.className = "data-row";
    const statusBadgeClass = m.status === "active" ? "badge-ok" : m.status === "suspended" ? "badge-danger" : "badge-warn";
    row.innerHTML = `<div class="data-row-main"><b>${escapeHtml(m.name)}</b><span class="sub">ID: ${escapeHtml(m.id)} · Country: ${escapeHtml(m.countryId)}${m.contact ? " · " + escapeHtml(m.contact) : ""}</span></div><span class="badge ${statusBadgeClass}">${escapeHtml(m.status)}</span>`;
    ["pending", "active", "suspended"].forEach((s) => {
      if (s === m.status) return;
      const btn = document.createElement("button");
      btn.className = "btn btn-sm btn-ghost";
      btn.textContent = s === "active" ? "Activate" : s === "suspended" ? "Suspend" : "Set Pending";
      btn.addEventListener("click", async () => {
        const res = await api(`/api/admin/merchants/${m.id}/status`, "PUT", { status: s });
        if (res.success) { toast("Merchant status updated"); loadMerchants(); } else toast(res.message, true);
      });
      row.appendChild(btn);
    });
    wrap.appendChild(row);
  });
}

$("btn-create-merchant").addEventListener("click", async () => {
  const name = $("merchant-name").value.trim();
  const countryId = $("merchant-country").value.trim();
  const contact = $("merchant-contact").value.trim();
  if (!name || !countryId) { toast("Provide a name and Country ID", true); return; }
  const r = await api("/api/admin/merchants", "POST", { name, countryId, contact: contact || undefined });
  if (r.success) { toast("Merchant created"); $("merchant-name").value = ""; $("merchant-country").value = ""; $("merchant-contact").value = ""; loadMerchants(); } else toast(r.message, true);
});

// ===========================================================================
// MANAGE COIN SELLERS (Wallet page "Coin Seller List")
// ===========================================================================
async function loadCoinSellers() {
  const wrap = $("cs-list");
  wrap.innerHTML = "";
  const r = await api("/api/admin/coin-sellers");
  const list = r.success ? r.sellers : [];
  if (!list.length) { wrap.innerHTML = `<p class="hint">No Coin Sellers added yet.</p>`; return; }
  list.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "data-row";
    if (s.missing) {
      row.innerHTML = `<div class="data-row-main"><b>${escapeHtml(s.user_id)}</b><span class="sub">User no longer exists</span></div><button class="btn btn-danger btn-sm cs-remove">Remove</button>`;
    } else {
      row.innerHTML = `
        <div class="data-row-main">
          <b>${escapeHtml(s.display_name)}</b>
          <span class="sub">ID: ${escapeHtml(s.user_id)} · Country: ${escapeHtml(s.country || "—")} · ${s.is_online ? "🟢 Online" : "⚪ Offline"} · Past 30 days' order: ${s.order_count_last_30_days}${s.whatsapp_number ? " · WhatsApp: " + escapeHtml(s.whatsapp_number) : ""}</span>
        </div>
        <button class="btn btn-ghost btn-sm cs-up" ${idx === 0 ? "disabled" : ""}>↑</button>
        <button class="btn btn-ghost btn-sm cs-down" ${idx === list.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn btn-danger btn-sm cs-remove">Remove</button>
      `;
    }
    row.querySelector(".cs-remove").addEventListener("click", async () => {
      if (!confirm(`Remove ${s.user_id} from the Coin Seller List?`)) return;
      const tr = await api(`/api/admin/coin-sellers/${s.user_id}/remove`, "POST");
      if (tr.success) { toast("Removed"); loadCoinSellers(); } else toast(tr.message || "An error occurred", true);
    });
    const upBtn = row.querySelector(".cs-up");
    const downBtn = row.querySelector(".cs-down");
    if (upBtn) upBtn.addEventListener("click", () => reorderCoinSeller(list, idx, idx - 1));
    if (downBtn) downBtn.addEventListener("click", () => reorderCoinSeller(list, idx, idx + 1));
    wrap.appendChild(row);
  });
}

async function reorderCoinSeller(list, fromIdx, toIdx) {
  const orderedUserIds = list.map((s) => s.user_id);
  const [moved] = orderedUserIds.splice(fromIdx, 1);
  orderedUserIds.splice(toIdx, 0, moved);
  const tr = await api("/api/admin/coin-sellers/reorder", "POST", { orderedUserIds });
  if (tr.success) loadCoinSellers(); else toast(tr.message || "An error occurred", true);
}

$("btn-cs-add").addEventListener("click", async () => {
  const userId = $("cs-add-userid").value.trim();
  const whatsappNumber = $("cs-add-whatsapp").value.trim();
  if (!userId) { toast("Provide a User ID", true); return; }
  const r = await api("/api/admin/coin-sellers/add", "POST", { userId, whatsappNumber });
  if (r.success) { toast("Seller added"); $("cs-add-userid").value = ""; $("cs-add-whatsapp").value = ""; loadCoinSellers(); }
  else toast(r.message || "An error occurred", true);
});

// ===========================================================================
// PAYMENT / RECHARGE (2026-08-16)
// ---------------------------------------------------------------
// Settings + Packages are gated on payment:manage (only shown/editable to
// roles that hold it — server also enforces this per-route regardless of
// what the UI shows). Records view/approve/reject are gated on
// payment:view / payment:approve. myAdminProfile.permissions (loaded at
// login, see loadMyProfile()) drives which controls render — this is a UX
// convenience only; every action is re-checked server-side.
// ===========================================================================
let prPage = 1;
let prLastPackages = [];

function prHasPerm(perm) {
  return !!(myAdminProfile && myAdminProfile.permissions && myAdminProfile.permissions.includes(perm));
}

async function loadPaymentRecharge() {
  const canManage = prHasPerm("payment:manage");
  $("pr-settings-panel").classList.toggle("hidden", !canManage);
  $("pr-packages-panel").classList.toggle("hidden", !canManage);
  if (canManage) {
    await loadPrSettings();
    await loadPrPackages();
  }
  prPage = 1;
  await loadPrRecords();
}

// ---------- Settings ----------
async function loadPrSettings() {
  const r = await api("/api/admin/payment-settings");
  if (!r.success) { toast(r.message || "Could not load payment settings", true); return; }
  const s = r.settings;
  $("pr-set-enabled").checked = !!s.enabled;
  $("pr-set-upiid").value = s.upiId || "";
  $("pr-set-receiver").value = s.receiverName || "";
  $("pr-set-qr").value = s.qrImageUrl || "";
  $("pr-set-min").value = s.minAmountINR;
  $("pr-set-max").value = s.maxAmountINR;
  $("pr-set-method-upi").checked = !!(s.methods && s.methods.upi);
  $("pr-set-method-phonepe").checked = !!(s.methods && s.methods.phonepe);
  $("pr-set-method-gpay").checked = !!(s.methods && s.methods.gpay);
  $("pr-set-instructions").value = s.instructions || "";
}

$("btn-pr-save-settings").addEventListener("click", async () => {
  const patch = {
    enabled: $("pr-set-enabled").checked,
    upiId: $("pr-set-upiid").value.trim(),
    receiverName: $("pr-set-receiver").value.trim(),
    qrImageUrl: $("pr-set-qr").value.trim(),
    minAmountINR: Number($("pr-set-min").value),
    maxAmountINR: Number($("pr-set-max").value),
    methods: {
      upi: $("pr-set-method-upi").checked,
      phonepe: $("pr-set-method-phonepe").checked,
      gpay: $("pr-set-method-gpay").checked
    },
    instructions: $("pr-set-instructions").value
  };
  const r = await api("/api/admin/payment-settings", "PUT", patch);
  if (r.success) {
    const badge = $("pr-settings-saved");
    badge.classList.remove("hidden");
    setTimeout(() => badge.classList.add("hidden"), 2000);
  } else toast(r.message || "Could not save settings", true);
});

// ---------- Packages ----------
async function loadPrPackages() {
  const r = await api("/api/admin/recharge-packages");
  const rows = $("pr-package-rows");
  rows.innerHTML = "";
  const list = r.success ? r.packages : [];
  prLastPackages = list;
  $("pr-package-empty").classList.toggle("hidden", list.length > 0);
  list.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>₹${p.priceINR}</td>
      <td>${p.coins.toLocaleString()}</td>
      <td>${(p.bonusCoins || 0).toLocaleString()}</td>
      <td>${(p.coins + (p.bonusCoins || 0)).toLocaleString()}</td>
      <td>${escapeHtml(p.label || "—")}</td>
      <td><input type="checkbox" class="pr-pkg-active" ${p.active ? "checked" : ""}></td>
      <td><button class="btn btn-danger btn-sm pr-pkg-delete">Delete</button></td>
    `;
    tr.querySelector(".pr-pkg-active").addEventListener("change", async (e) => {
      const r2 = await api(`/api/admin/recharge-packages/${p.id}`, "PUT", { active: e.target.checked });
      if (!r2.success) { toast(r2.message || "Could not update package", true); e.target.checked = !e.target.checked; }
    });
    tr.querySelector(".pr-pkg-delete").addEventListener("click", async () => {
      if (!confirm(`Delete the ₹${p.priceINR} package?`)) return;
      const r2 = await api(`/api/admin/recharge-packages/${p.id}`, "DELETE");
      if (r2.success) { toast("Package deleted"); loadPrPackages(); } else toast(r2.message || "Could not delete package", true);
    });
    rows.appendChild(tr);
  });
}

$("btn-pr-add-package").addEventListener("click", async () => {
  const priceINR = Number($("pr-pkg-price").value);
  const coins = Number($("pr-pkg-coins").value);
  const bonusCoins = Number($("pr-pkg-bonus").value) || 0;
  const label = $("pr-pkg-label").value.trim();
  if (!priceINR || priceINR <= 0) { toast("Enter a valid price", true); return; }
  if (!coins || coins <= 0) { toast("Enter a valid coin amount", true); return; }
  const r = await api("/api/admin/recharge-packages", "POST", { priceINR, coins, bonusCoins, label });
  if (r.success) {
    toast("Package added");
    $("pr-pkg-price").value = ""; $("pr-pkg-coins").value = ""; $("pr-pkg-bonus").value = ""; $("pr-pkg-label").value = "";
    loadPrPackages();
  } else toast(r.message || "Could not add package", true);
});

// ---------- Records ----------
function prBuildQuery() {
  const params = new URLSearchParams();
  const q = $("pr-f-q").value.trim();
  const status = $("pr-f-status").value;
  const method = $("pr-f-method").value;
  const minAmount = $("pr-f-minamt").value;
  const maxAmount = $("pr-f-maxamt").value;
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  if (method) params.set("method", method);
  if (minAmount) params.set("minAmount", minAmount);
  if (maxAmount) params.set("maxAmount", maxAmount);
  params.set("page", prPage);
  params.set("pageSize", $("pr-page-size").value);
  return params.toString();
}

async function loadPrRecords() {
  const r = await api("/api/admin/recharge-records?" + prBuildQuery());
  const rows = $("pr-records-rows");
  rows.innerHTML = "";
  if (!r.success) { toast(r.message || "Could not load recharge records", true); return; }
  const canApprove = prHasPerm("payment:approve");
  $("pr-records-empty").classList.toggle("hidden", r.items.length > 0);
  r.items.forEach((t) => {
    const tr = document.createElement("tr");
    const actions = (t.status === "PENDING" && canApprove)
      ? `<button class="btn btn-primary btn-sm pr-approve">Approve</button> <button class="btn btn-danger btn-sm pr-reject">Reject</button>`
      : "—";
    tr.innerHTML = `
      <td>${escapeHtml(t.id)}</td>
      <td>${escapeHtml(t.utr)}</td>
      <td>${escapeHtml(t.userId)}</td>
      <td>${escapeHtml(t.packageId)}</td>
      <td>₹${t.priceINR}</td>
      <td>${t.totalCoins.toLocaleString()}</td>
      <td>${escapeHtml(t.method)}</td>
      <td><span class="pr-status-badge pr-status-${t.status}">${t.status}</span></td>
      <td>${new Date(t.createdAt).toLocaleString()}</td>
      <td>${escapeHtml(t.decidedBy || "—")}</td>
      <td>${actions}</td>
    `;
    const approveBtn = tr.querySelector(".pr-approve");
    const rejectBtn = tr.querySelector(".pr-reject");
    if (approveBtn) approveBtn.addEventListener("click", async () => {
      if (!confirm(`Approve this recharge and credit ${t.totalCoins.toLocaleString()} coins to ${t.userId}?`)) return;
      const r2 = await api(`/api/admin/recharge-records/${t.id}/approve`, "POST");
      if (r2.success) { toast("Approved — coins credited"); loadPrRecords(); } else toast(r2.message || "Could not approve", true);
    });
    if (rejectBtn) rejectBtn.addEventListener("click", async () => {
      const reason = prompt("Reason for rejection (optional):") || "";
      const r2 = await api(`/api/admin/recharge-records/${t.id}/reject`, "POST", { reason });
      if (r2.success) { toast("Rejected"); loadPrRecords(); } else toast(r2.message || "Could not reject", true);
    });
    rows.appendChild(tr);
  });
  $("pr-page-info").textContent = `Page ${r.page} of ${r.totalPages} · ${r.total} total`;
  $("btn-pr-prev").disabled = r.page <= 1;
  $("btn-pr-next").disabled = r.page >= r.totalPages;
}

$("btn-pr-filter-apply").addEventListener("click", () => { prPage = 1; loadPrRecords(); });
$("btn-pr-filter-clear").addEventListener("click", () => {
  $("pr-f-q").value = ""; $("pr-f-status").value = ""; $("pr-f-method").value = "";
  $("pr-f-minamt").value = ""; $("pr-f-maxamt").value = "";
  prPage = 1; loadPrRecords();
});
$("pr-page-size").addEventListener("change", () => { prPage = 1; loadPrRecords(); });
$("btn-pr-prev").addEventListener("click", () => { if (prPage > 1) { prPage--; loadPrRecords(); } });
$("btn-pr-next").addEventListener("click", () => { prPage++; loadPrRecords(); });

// ===========================================================================
// ANNOUNCEMENTS
// ===========================================================================
$("btn-send-announce").addEventListener("click", async () => {
  const text = $("announce-text").value.trim();
  if (!text) return;
  const r = await api("/api/admin/announcements", "POST", { text });
  if (r.success) { toast("Broadcast sent"); $("announce-text").value = ""; } else toast(r.message, true);
});

// ===========================================================================
// TREASURE CHEST
// ===========================================================================
let chestLevelsCache = [];

async function loadChestLevels() {
  const r = await api("/api/chest/config");
  chestLevelsCache = r.success ? r.levels : [];
  renderChestLevelsForm();
}

function renderChestLevelsForm() {
  const wrap = $("chest-levels-form");
  wrap.innerHTML = "";
  chestLevelsCache.forEach((lvl, i) => {
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <h3 class="sub-head" style="margin-top:0;">Level ${lvl.level}</h3>
      <div class="form-row">
        <label style="font-size:12px;color:var(--text-dim);">Target diamonds:</label>
        <input type="number" class="field lvl-target" value="${lvl.target}" style="max-width:160px;">
        <button class="btn btn-danger btn-sm lvl-remove">Delete this Level</button>
      </div>
      <label class="field-label">Reward pool (JSON array, e.g. [{"type":"coins","amount":500}])</label>
      <textarea class="field lvl-rewards" rows="2" style="width:100%;font-family:var(--font-mono);font-size:11.5px;">${escapeHtml(JSON.stringify(lvl.rewardPool))}</textarea>
    `;
    panel.querySelector(".lvl-target").addEventListener("input", (e) => { chestLevelsCache[i].target = Number(e.target.value) || 0; });
    panel.querySelector(".lvl-rewards").addEventListener("input", (e) => {
      try { chestLevelsCache[i].rewardPool = JSON.parse(e.target.value); } catch (err) { /* wait for valid JSON before saving */ }
    });
    panel.querySelector(".lvl-remove").addEventListener("click", () => {
      chestLevelsCache.splice(i, 1);
      chestLevelsCache.forEach((l, idx) => { l.level = idx + 1; });
      renderChestLevelsForm();
    });
    wrap.appendChild(panel);
  });
}

$("btn-add-chest-level").addEventListener("click", () => {
  const lastTarget = chestLevelsCache.length ? chestLevelsCache[chestLevelsCache.length - 1].target : 0;
  chestLevelsCache.push({ level: chestLevelsCache.length + 1, target: lastTarget + 100000, rewardPool: [{ type: "coins", amount: 500 }] });
  renderChestLevelsForm();
});

$("btn-save-chest-levels").addEventListener("click", async () => {
  const r = await api("/api/admin/chest/config", "POST", { levels: chestLevelsCache });
  if (r.success) { toast("Chest levels saved"); chestLevelsCache = r.levels; renderChestLevelsForm(); }
  else toast(r.message || "An error occurred", true);
});

// ===========================================================================
// COIN CENTER
// ===========================================================================
let ccSelectedUser = null;      // single mode
let ccSelectedUsers = [];       // multi mode — array of {userId, name, coins}
function ccIsMulti() { return $("cc-multi-toggle").checked; }

async function loadCoinCenter() {
  const r = await api("/api/admin/coin-center/balance");
  $("cc-balance").textContent = r.success ? `${r.systemBalance.toLocaleString()} coins` : "—";

  const logWrap = $("cc-log-list");
  logWrap.innerHTML = "";
  const lr = await api("/api/admin/coin-center/log");
  if (lr.success) lr.log.forEach((entry) => {
    if (entry.type === "balance_set") return; // balance top-ups aren't per-user transfers
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `<div class="data-row-main"><b>${escapeHtml(entry.targetName || entry.targetUserId)}</b><span class="sub">+${entry.amount} coins · ${escapeHtml(entry.reason || "No note")} · by ${escapeHtml(entry.adminUsername)}</span></div><span class="sub">${new Date(entry.time).toLocaleString()}</span>`;
    logWrap.appendChild(row);
  });

  loadCoinCenterAccounts();
}

// ---------------------------------------------------------------------------
// COIN CENTER ACCOUNTS (Agency-style operators) — create/remove/enable/
// disable any User ID as a Coin Center from here; nowhere else.
// ---------------------------------------------------------------------------
async function loadCoinCenterAccounts() {
  const wrap = $("cca-list");
  wrap.innerHTML = "";
  const r = await api("/api/admin/coin-center/accounts");
  if (!r.success || !r.accounts.length) {
    wrap.innerHTML = `<p class="hint">No Coin Center Accounts created yet.</p>`;
    return;
  }
  r.accounts.forEach((a) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <div class="data-row-main">
        <b>${escapeHtml(a.name)}</b>
        <span class="sub">ID: ${escapeHtml(a.userId)} · Balance: ${a.balance.toLocaleString()} coins · Total Sent: ${a.sentTotal.toLocaleString()}</span>
      </div>
      <span class="badge ${a.enabled ? "badge-ok" : "badge-danger"}">${a.enabled ? "Enabled" : "Disabled"}</span>
      <input type="number" min="1" step="1" placeholder="Top-up" class="field" style="width:100px;">
      <button class="btn btn-ghost btn-topup">Top-up</button>
      <button class="btn btn-ghost btn-toggle">${a.enabled ? "Disable" : "Enable"}</button>
      <button class="btn btn-danger btn-remove">Remove</button>
    `;
    row.querySelector(".btn-topup").addEventListener("click", async () => {
      const input = row.querySelector("input");
      const amount = Number(input.value);
      if (!Number.isInteger(amount) || amount <= 0) { toast("Provide a valid amount", true); return; }
      const tr = await api(`/api/admin/coin-center/accounts/${a.userId}/topup`, "POST", { amount });
      if (tr.success) { toast("Topped up"); loadCoinCenterAccounts(); loadCoinCenter(); }
      else toast(tr.message || "An error occurred", true);
    });
    row.querySelector(".btn-toggle").addEventListener("click", async () => {
      const tr = await api(`/api/admin/coin-center/accounts/${a.userId}/toggle`, "POST", { enabled: !a.enabled });
      if (tr.success) loadCoinCenterAccounts(); else toast(tr.message || "An error occurred", true);
    });
    row.querySelector(".btn-remove").addEventListener("click", async () => {
      if (!confirm(`Remove ${a.name} (${a.userId}) from the Coin Center?`)) return;
      const tr = await api(`/api/admin/coin-center/accounts/${a.userId}/remove`, "POST");
      if (tr.success) { toast("Removed"); loadCoinCenterAccounts(); } else toast(tr.message || "An error occurred", true);
    });
    wrap.appendChild(row);
  });
}

$("btn-cca-create").addEventListener("click", async () => {
  const userId = $("cca-userid").value.trim();
  if (!userId) { toast("Provide a User ID", true); return; }
  const r = await api("/api/admin/coin-center/accounts/create", "POST", { userId });
  if (r.success) { toast("Coin Center created"); $("cca-userid").value = ""; loadCoinCenterAccounts(); }
  else toast(r.message || "An error occurred", true);
});

$("btn-cc-set-balance").addEventListener("click", async () => {
  const amount = $("cc-balance-input").value;
  if (amount === "") { toast("Provide an amount", true); return; }
  const r = await api("/api/admin/coin-center/balance", "POST", { amount: Number(amount) });
  if (r.success) { toast("System balance updated"); $("cc-balance-input").value = ""; loadCoinCenter(); }
  else toast(r.message || "An error occurred", true);
});

$("cc-multi-toggle").addEventListener("change", () => {
  ccSelectedUser = null;
  ccSelectedUsers = [];
  $("cc-user-card").style.display = "none";
  renderCcRecipients();
  $("btn-cc-send").disabled = true;
  $("btn-cc-send").textContent = "Send from Coin Center";
});

function renderCcRecipients() {
  const wrap = $("cc-recipients-list");
  if (!ccIsMulti() || !ccSelectedUsers.length) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
  wrap.style.display = "flex";
  wrap.innerHTML = "";
  ccSelectedUsers.forEach((u) => {
    const chip = document.createElement("span");
    chip.className = "badge badge-ok";
    chip.style.cssText = "display:inline-flex;align-items:center;gap:6px;padding:6px 10px;";
    chip.innerHTML = `${escapeHtml(u.name)} (${escapeHtml(u.userId)}) <button style="border:none;background:none;color:inherit;cursor:pointer;font-weight:800;">✕</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      ccSelectedUsers = ccSelectedUsers.filter((x) => x.userId !== u.userId);
      renderCcRecipients();
      $("btn-cc-send").disabled = ccSelectedUsers.length === 0;
    });
    wrap.appendChild(chip);
  });
  $("btn-cc-send").textContent = `${ccSelectedUsers.length} users from Coin Center`;
}

$("btn-cc-search").addEventListener("click", async () => {
  const query = $("cc-search").value.trim();
  if (!query) { toast("Provide a User ID or Mobile Number", true); return; }
  const r = await api(`/api/admin/coin-center/search?query=${encodeURIComponent(query)}`);
  if (!r.success) {
    if (!ccIsMulti()) { ccSelectedUser = null; $("btn-cc-send").disabled = true; }
    const card = $("cc-user-card");
    card.style.display = "block";
    card.innerHTML = `<span class="sub">${escapeHtml(r.message || "User not found")}</span>`;
    return;
  }

  if (ccIsMulti()) {
    if (ccSelectedUsers.some((u) => u.userId === r.user.userId)) { toast("This user is already in the list"); return; }
    ccSelectedUsers.push(r.user);
    $("cc-search").value = "";
    $("cc-user-card").style.display = "none";
    renderCcRecipients();
    $("btn-cc-send").disabled = false;
  } else {
    ccSelectedUser = r.user;
    const card = $("cc-user-card");
    card.style.display = "block";
    card.innerHTML = `<div class="data-row-main"><b>${escapeHtml(r.user.name)}</b><span class="sub">ID: ${escapeHtml(r.user.userId)} · Current coins: ${r.user.coins.toLocaleString()}</span></div>`;
    $("btn-cc-send").disabled = false;
  }
});

$("btn-cc-send").addEventListener("click", async () => {
  const amount = Number($("cc-amount").value);
  const reason = $("cc-reason").value.trim();
  if (!Number.isInteger(amount) || amount <= 0) { toast("Provide a valid (whole number) coin amount", true); return; }

  const requestId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const btn = $("btn-cc-send");

  if (ccIsMulti()) {
    if (!ccSelectedUsers.length) { toast("First find and add at least one User", true); return; }
    if (!confirm(`Send ${amount} coins each to ${ccSelectedUsers.length} users?`)) return;
    btn.disabled = true;
    try {
      const targetUserIds = ccSelectedUsers.map((u) => u.userId);
      const r = await api("/api/admin/coin-center/send-bulk", "POST", { targetUserIds, amount, reason, requestId });
      if (r.success) {
        toast(`${r.successCount} users, ${amount} coins each sent${r.failCount ? ` (${r.failCount} failed)` : ""}`);
        $("cc-amount").value = "";
        $("cc-reason").value = "";
        ccSelectedUsers = [];
        renderCcRecipients();
        loadCoinCenter();
      } else {
        toast(r.message || "Failed to send", true);
      }
    } finally {
      btn.disabled = ccSelectedUsers.length === 0;
    }
    return;
  }

  if (!ccSelectedUser) { toast("First find a User", true); return; }
  if (!confirm(`Send ${amount} coins to ${ccSelectedUser.name} (${ccSelectedUser.userId})?`)) return;

  // requestId is generated once per confirmed click and the button is
  // disabled immediately, so an accidental double-click (or a retried
  // network request carrying the same requestId) can't credit twice —
  // the server's idempotency cache replays the first result instead.
  btn.disabled = true;
  try {
    const r = await api("/api/admin/coin-center/send", "POST", { targetUserId: ccSelectedUser.userId, amount, reason, requestId });
    if (r.success) {
      toast(`${amount} coins sent`);
      $("cc-amount").value = "";
      $("cc-reason").value = "";
      ccSelectedUser.coins = r.coins;
      $("cc-user-card").querySelector(".sub").textContent = `ID: ${ccSelectedUser.userId} · Current coins: ${r.coins.toLocaleString()}`;
      loadCoinCenter();
    } else {
      toast(r.message || "Failed to send", true);
    }
  } finally {
    btn.disabled = false;
  }
});

// ===========================================================================
// AI CORE
// ===========================================================================
let aiCoreTimer = null;

function fmtUptime(sec) {
  if (!sec) return "–";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadAiCore() {
  const [statusR, analyticsR, monitorR, logsR] = await Promise.all([
    api("/api/admin/ai/status"),
    api("/api/admin/ai/analytics"),
    api("/api/admin/ai/monitor/history"),
    api("/api/admin/ai/logs?limit=50"),
  ]);

  if (statusR.success) {
    $("ai-provider").textContent = statusR.provider || "–";
    $("ai-key-warning").classList.toggle("hidden", !!statusR.apiKeyConfigured);
    const badge = $("ai-status-badge");
    const label = { healthy: "Healthy", warning: "Warning", critical: "Critical" }[statusR.status] || "Unknown";
    badge.textContent = label;
    badge.className = "badge " + (statusR.status === "critical" ? "badge-danger" : statusR.status === "warning" ? "badge-warn" : "badge-ok");
  }

  if (analyticsR.success) {
    $("ai-conversations").textContent = analyticsR.stats.totalAiConversations || 0;
    $("ai-replies").textContent = analyticsR.stats.totalAiReplies || 0;
    $("ai-flags").textContent = (analyticsR.stats.totalModerationFlags || 0) + (analyticsR.stats.totalRateLimitHits || 0);
  }

  if (monitorR.success && monitorR.history.length) {
    const last = monitorR.history[monitorR.history.length - 1];
    $("ai-mem").textContent = last.memoryMB ?? "–";
    $("ai-lag").textContent = last.eventLoopLagMs ?? "–";
    $("ai-online").textContent = last.onlineUsers ?? "–";
    $("ai-uptime").textContent = fmtUptime(last.uptimeSec);
  }

  const rows = $("ai-log-rows");
  rows.innerHTML = "";
  const logs = logsR.success ? logsR.logs : [];
  $("ai-log-empty").classList.toggle("hidden", logs.length > 0);
  logs.forEach((l) => {
    const tr = document.createElement("tr");
    const time = new Date(l.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    tr.innerHTML = `<td>${escapeHtml(time)}</td><td>${escapeHtml(l.module || "")}</td><td>${escapeHtml(l.action || "")}</td><td>${escapeHtml(String(l.result || ""))}</td>`;
    rows.appendChild(tr);
  });

  clearInterval(aiCoreTimer);
  aiCoreTimer = setInterval(() => { if ($("sec-ai-core").classList.contains("active")) loadAiCore(); }, 30000);
}

// ===========================================================================
// THEME LIBRARY
// ===========================================================================
async function loadThemeLibraryAdmin() {
  const r = await api("/api/theme-library/list");
  const grid = $("theme-lib-grid");
  const themes = r.success ? r.themes : [];
  $("theme-lib-count").textContent = `(${themes.length})`;
  $("theme-lib-empty").classList.toggle("hidden", themes.length > 0);
  grid.innerHTML = "";
  themes.forEach((t) => {
    const card = document.createElement("div");
    card.className = "theme-lib-admin-card";
    card.innerHTML = `
      <img src="${escapeHtml(t.url)}" alt="">
      <div class="theme-lib-admin-name">${escapeHtml(t.name)}</div>
      <button class="btn btn-ghost btn-sm btn-danger" data-id="${escapeHtml(t.id)}">Delete</button>
    `;
    card.querySelector("button").addEventListener("click", async () => {
      const del = await api("/api/admin/theme-library/" + t.id, "DELETE");
      if (del.success) { toast("Deleted"); loadThemeLibraryAdmin(); }
      else toast(del.message || "An error occurred", true);
    });
    grid.appendChild(card);
  });
}
$("btn-theme-lib-upload").addEventListener("click", async () => {
  const file = $("theme-lib-file").files[0];
  if (!file) { toast("Select an image", true); return; }
  const fd = new FormData();
  fd.append("theme", file);
  fd.append("name", $("theme-lib-name").value.trim() || file.name);
  const btn = $("btn-theme-lib-upload");
  btn.disabled = true;
  const r = await apiUpload("/api/admin/theme-library/upload", fd);
  btn.disabled = false;
  if (r.success) {
    toast("Theme added ✅");
    $("theme-lib-name").value = "";
    $("theme-lib-file").value = "";
    loadThemeLibraryAdmin();
  } else {
    toast(r.message || "Upload failed", true);
  }
});

// ===========================================================================
// HOME BANNER SYSTEM
// ===========================================================================
let bannerDragId = null;

async function loadBannerManagement() {
  const r = await api("/api/admin/banners");
  const grid = $("banner-grid");
  const banners = r.success ? r.banners : [];
  $("banner-count").textContent = `(${banners.length})`;
  $("banner-empty").classList.toggle("hidden", banners.length > 0);
  grid.innerHTML = "";
  banners.forEach((b) => {
    const card = document.createElement("div");
    card.className = "theme-lib-admin-card banner-admin-card";
    card.draggable = true;
    card.dataset.id = b._id;
    card.innerHTML = `
      <img src="${escapeHtml(b.imageUrl)}" alt="">
      <div class="theme-lib-admin-name">
        <span class="banner-status-pill${b.isActive ? "" : " off"}">${b.isActive ? "Active" : "Inactive"}</span>
      </div>
      <button class="btn btn-ghost btn-sm btn-banner-toggle" data-id="${escapeHtml(b._id)}">${b.isActive ? "Disable" : "Enable"}</button>
      <button class="btn btn-ghost btn-sm btn-danger btn-banner-delete" data-id="${escapeHtml(b._id)}">Delete</button>
    `;
    card.addEventListener("dragstart", () => { bannerDragId = b._id; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); });
    card.addEventListener("dragover", (e) => e.preventDefault());
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (!bannerDragId || bannerDragId === b._id) return;
      const ids = Array.from(grid.children).map((c) => c.dataset.id);
      const fromIdx = ids.indexOf(bannerDragId);
      const toIdx = ids.indexOf(b._id);
      if (fromIdx === -1 || toIdx === -1) return;
      ids.splice(toIdx, 0, ids.splice(fromIdx, 1)[0]);
      const rr = await api("/api/admin/banners/reorder", "POST", { order: ids });
      if (rr.success) loadBannerManagement(); else toast(rr.message || "Reorder failed", true);
    });
    grid.appendChild(card);
  });
}

$("banner-grid").addEventListener("click", async (e) => {
  const toggleBtn = e.target.closest(".btn-banner-toggle");
  if (toggleBtn) {
    const r = await api(`/api/admin/banners/${toggleBtn.dataset.id}/toggle`, "POST");
    if (r.success) loadBannerManagement(); else toast(r.message || "Failed", true);
    return;
  }
  const deleteBtn = e.target.closest(".btn-banner-delete");
  if (deleteBtn) {
    if (!confirm("Delete this banner?")) return;
    const r = await api("/api/admin/banners/" + deleteBtn.dataset.id, "DELETE");
    if (r.success) { toast("Deleted"); loadBannerManagement(); } else toast(r.message || "Failed", true);
  }
});

$("btn-banner-upload").addEventListener("click", async () => {
  const file = $("banner-file").files[0];
  if (!file) { toast("Select an image", true); return; }
  const fd = new FormData();
  fd.append("image", file);
  fd.append("linkUrl", $("banner-link-url").value.trim());
  const btn = $("btn-banner-upload");
  btn.disabled = true;
  const r = await apiUpload("/api/admin/banners", fd);
  btn.disabled = false;
  if (r.success) {
    toast("Banner added ✅");
    $("banner-link-url").value = "";
    $("banner-file").value = "";
    loadBannerManagement();
  } else {
    toast(r.message || "Upload failed", true);
  }
});

// ===========================================================================
// RELATIONSHIP SETTINGS (CP / Friendship visual controls, 2026-08-11)
// ===========================================================================
function relPopulateForm(kind, cfg) {
  $(`rel-${kind}-asset-enabled`).checked = !!cfg.customAssetEnabled;
  $(`rel-${kind}-width`).value = cfg.width;
  $(`rel-${kind}-height`).value = cfg.height;
  $(`rel-${kind}-scale`).value = cfg.scale;
  $(`rel-${kind}-opacity`).value = cfg.opacity;
  $(`rel-${kind}-anim-enabled`).checked = !!cfg.animationEnabled;
  $(`rel-${kind}-anim-speed`).value = cfg.animationSpeedSec;
  $(`rel-${kind}-offset-x`).value = cfg.offsetX;
  $(`rel-${kind}-offset-y`).value = cfg.offsetY;
}

async function loadRelationshipSettings() {
  const r = await api("/api/admin/relationships/config");
  if (!r.success) { toast(r.message || "Failed to load relationship settings", true); return; }
  relPopulateForm("cp", r.config.cp);
  relPopulateForm("friendship", r.config.friendship);
  $("rel-cp-preview").src = r.resolved.cp.assetUrl;
  $("rel-friendship-preview").src = r.resolved.friendship.assetUrl;
}

function relReadForm(kind) {
  return {
    width: Number($(`rel-${kind}-width`).value),
    height: Number($(`rel-${kind}-height`).value),
    scale: Number($(`rel-${kind}-scale`).value),
    opacity: Number($(`rel-${kind}-opacity`).value),
    animationEnabled: $(`rel-${kind}-anim-enabled`).checked,
    animationSpeedSec: Number($(`rel-${kind}-anim-speed`).value),
    offsetX: Number($(`rel-${kind}-offset-x`).value),
    offsetY: Number($(`rel-${kind}-offset-y`).value),
    customAssetEnabled: $(`rel-${kind}-asset-enabled`).checked
  };
}

["cp", "friendship"].forEach((kind) => {
  $(`btn-rel-${kind}-save`).addEventListener("click", async () => {
    const r = await api(`/api/admin/relationships/config/${kind}`, "POST", relReadForm(kind));
    if (r.success) {
      toast((kind === "cp" ? "CP" : "Friendship") + " settings saved ✅ (live in every room now)");
      relPopulateForm(kind, r.config[kind]);
      $(`rel-${kind}-preview`).src = r.resolved[kind].assetUrl;
    } else {
      toast(r.message || "Save failed", true);
    }
  });

  $(`btn-rel-${kind}-reset`).addEventListener("click", async () => {
    if (!confirm(`Reset ${kind === "cp" ? "CP" : "Friendship"} size/opacity/animation/position to default? (Does not delete an uploaded custom asset.)`)) return;
    const r = await api(`/api/admin/relationships/config/${kind}/reset`, "POST");
    if (r.success) {
      toast("Reset to default ✅");
      relPopulateForm(kind, r.config[kind]);
      $(`rel-${kind}-preview`).src = r.resolved[kind].assetUrl;
    } else {
      toast(r.message || "Reset failed", true);
    }
  });

  $(`btn-rel-${kind}-upload`).addEventListener("click", async () => {
    const file = $(`rel-${kind}-file`).files[0];
    if (!file) { toast("Select a PNG file", true); return; }
    const fd = new FormData();
    fd.append("asset", file);
    const btn = $(`btn-rel-${kind}-upload`);
    btn.disabled = true;
    const r = await apiUpload(`/api/admin/relationships/asset/${kind}`, fd);
    btn.disabled = false;
    if (r.success) {
      toast("Uploaded ✅ — check \"Use custom asset\" and Save to go live");
      $(`rel-${kind}-file`).value = "";
      $(`rel-${kind}-preview`).src = r.resolved[kind].assetUrl;
    } else {
      toast(r.message || "Upload failed", true);
    }
  });

  $(`btn-rel-${kind}-restore`).addEventListener("click", async () => {
    if (!confirm(`Restore the default ${kind === "cp" ? "CP" : "Friendship"} artwork? (Disables the custom asset — it isn't deleted, so it can be re-enabled later.)`)) return;
    const r = await api(`/api/admin/relationships/asset/${kind}/restore-default`, "POST");
    if (r.success) {
      toast("Restored default ✅");
      relPopulateForm(kind, r.config[kind]);
      $(`rel-${kind}-preview`).src = r.resolved[kind].assetUrl;
    } else {
      toast(r.message || "Restore failed", true);
    }
  });
});

// ===========================================================================
// LEVEL MANAGEMENT (ID Level System Upgrade, 2026-08-04)
// ===========================================================================
let levelConfigCache = null;

async function loadLevelManagement() {
  const r = await api("/api/admin/level/themes");
  if (!r.success) { toast("Failed to load Level Management", true); return; }
  levelConfigCache = r.config;
  $("level-cfg-starting").value = r.config.startingValue;
  $("level-cfg-multiplier").value = r.config.growthMultiplier;
  $("level-cfg-max").value = r.config.maxLevel;
  renderLevelFormulaPreview();
  renderLevelThemeGrid(r.themes);
}

function renderLevelFormulaPreview() {
  const starting = Number($("level-cfg-starting").value) || 10000;
  const mult = Number($("level-cfg-multiplier").value) || 5;
  const lines = [];
  for (let n = 1; n <= 4; n++) lines.push(`Level ${n} = ${Math.round(starting * Math.pow(mult, n - 1)).toLocaleString()}`);
  $("level-cfg-preview").textContent = "Preview — " + lines.join(" · ");
}
["level-cfg-starting", "level-cfg-multiplier"].forEach((id) => $(id).addEventListener("input", renderLevelFormulaPreview));

$("btn-level-cfg-save").addEventListener("click", async () => {
  const body = {
    startingValue: Number($("level-cfg-starting").value),
    growthMultiplier: Number($("level-cfg-multiplier").value),
    maxLevel: Number($("level-cfg-max").value)
  };
  if (!body.startingValue || !body.growthMultiplier || !body.maxLevel) { toast("Fill in all three fields", true); return; }
  const btn = $("btn-level-cfg-save");
  btn.disabled = true;
  const r = await api("/api/admin/level/config", "PUT", body);
  btn.disabled = false;
  if (r.success) { toast("Formula saved ✅ — existing users keep their level, only future progress uses the new numbers."); loadLevelManagement(); }
  else toast(r.message || "Save failed", true);
});

function renderLevelThemeGrid(themes) {
  $("level-theme-count").textContent = `(${themes.length} group${themes.length === 1 ? "" : "s"})`;
  const grid = $("level-theme-grid");
  grid.innerHTML = "";
  themes.forEach((t) => {
    const card = document.createElement("div");
    card.className = "theme-lib-admin-card level-theme-card";
    card.innerHTML = `
      <div class="data-row-main"><b>Level ${t.label}</b><span class="sub">${t.isDefault ? "Default (not customized yet)" : "Customized"}</span></div>
      <div class="level-theme-swatch" style="background:linear-gradient(135deg, ${escapeHtml(t.gradientFrom)}, ${escapeHtml(t.gradientTo)});">
        ${t.badgeUrl ? `<img src="${escapeHtml(t.badgeUrl)}" alt="">` : ""}
      </div>
      <div class="form-row">
        <label class="field-label">Gradient From <input type="color" class="field lt-gradient-from" value="${escapeHtml(t.gradientFrom)}"></label>
        <label class="field-label">Gradient To <input type="color" class="field lt-gradient-to" value="${escapeHtml(t.gradientTo)}"></label>
        <label class="field-label">Text Color <input type="color" class="field lt-text-color" value="${escapeHtml(t.textColor)}"></label>
      </div>
      <div class="form-row">
        <label class="field-label"><input type="checkbox" class="lt-glow-enabled" ${t.glowEnabled ? "checked" : ""}> Glow Effect</label>
        <label class="field-label">Glow Color <input type="color" class="field lt-glow-color" value="${escapeHtml(t.glowColor)}"></label>
      </div>
      <div class="form-row">
        <label class="field-label">Badge PNG <input type="file" accept="image/*" class="field lt-file-badge"></label>
        <label class="field-label">Icon PNG <input type="file" accept="image/*" class="field lt-file-icon"></label>
      </div>
      <div class="form-row">
        <label class="field-label">Border PNG <input type="file" accept="image/*" class="field lt-file-border"></label>
        <label class="field-label">Background <input type="file" accept="image/*" class="field lt-file-background"></label>
      </div>
      <button class="btn btn-primary btn-sm btn-level-theme-save" data-group="${t.groupIndex}">Save Theme</button>
    `;
    grid.appendChild(card);
  });
}

$("level-theme-grid").addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn-level-theme-save");
  if (!btn) return;
  const card = btn.closest(".level-theme-card");
  const groupIndex = btn.dataset.group;
  const fd = new FormData();
  fd.append("gradientFrom", card.querySelector(".lt-gradient-from").value);
  fd.append("gradientTo", card.querySelector(".lt-gradient-to").value);
  fd.append("textColor", card.querySelector(".lt-text-color").value);
  fd.append("glowColor", card.querySelector(".lt-glow-color").value);
  fd.append("glowEnabled", card.querySelector(".lt-glow-enabled").checked ? "true" : "false");
  const badgeFile = card.querySelector(".lt-file-badge").files[0];
  const iconFile = card.querySelector(".lt-file-icon").files[0];
  const borderFile = card.querySelector(".lt-file-border").files[0];
  const bgFile = card.querySelector(".lt-file-background").files[0];
  if (badgeFile) fd.append("badge", badgeFile);
  if (iconFile) fd.append("icon", iconFile);
  if (borderFile) fd.append("border", borderFile);
  if (bgFile) fd.append("background", bgFile);
  btn.disabled = true;
  const r = await apiUpload(`/api/admin/level/theme/${groupIndex}`, fd);
  btn.disabled = false;
  if (r.success) { toast("Theme saved & live for all online users ✅"); loadLevelManagement(); }
  else toast(r.message || "Save failed", true);
});

// ===========================================================================
// SUPER ADMIN (God Power)
// ===========================================================================
async function loadGodPowerList() {
  const r = await api("/api/admin/godpower/list");
  if (!r.success) return;
  $("godpower-max").textContent = r.max;
  $("godpower-count-badge").textContent = `(${r.count}/${r.max})`;
  const wrap = $("godpower-list");
  wrap.innerHTML = "";
  $("godpower-empty").classList.toggle("hidden", r.holders.length > 0);
  r.holders.forEach((h) => {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <div style="flex:1;">
        <b>${escapeHtml(h.name)}</b>
        <div class="hint">ID: ${escapeHtml(h.userId)}</div>
      </div>
      <button class="btn btn-ghost btn-sm btn-danger" data-id="${escapeHtml(h.userId)}">Remove</button>
    `;
    row.querySelector("button").addEventListener("click", () => revokeGodPower(h.userId));
    wrap.appendChild(row);
  });
}
$("btn-godpower-search").addEventListener("click", async () => {
  const query = $("godpower-search").value.trim();
  if (!query) return;
  const r = await api("/api/admin/godpower/search?query=" + encodeURIComponent(query));
  const card = $("godpower-user-card");
  if (!r.success) { card.style.display = "none"; toast(r.message || "User not found", true); return; }
  const u = r.user;
  card.style.display = "flex";
  card.innerHTML = `
    <div style="flex:1;">
      <b>${escapeHtml(u.name)}</b>
      <div class="hint">ID: ${escapeHtml(u.userId)} · Mobile: ${escapeHtml(u.mobile)}</div>
    </div>
  `;
  const btn = document.createElement("button");
  if (u.isGodPower) {
    btn.className = "btn btn-ghost btn-sm btn-danger";
    btn.textContent = "Remove God Power";
    btn.addEventListener("click", () => revokeGodPower(u.userId));
  } else {
    btn.className = "btn btn-primary btn-sm";
    btn.textContent = "Grant God Power";
    btn.addEventListener("click", () => grantGodPower(u.userId));
  }
  card.appendChild(btn);
});
async function grantGodPower(userId) {
  const r = await api("/api/admin/godpower/grant", "POST", { userId });
  if (r.success) { toast("God Power granted ✅"); $("godpower-user-card").style.display = "none"; $("godpower-search").value = ""; loadGodPowerList(); }
  else toast(r.message || "An error occurred", true);
}
async function revokeGodPower(userId) {
  const r = await api("/api/admin/godpower/revoke", "POST", { userId });
  if (r.success) { toast("God Power removed"); $("godpower-user-card").style.display = "none"; loadGodPowerList(); }
  else toast(r.message || "An error occurred", true);
}

// ===========================================================================
// ROLE & COUNTRY MANAGEMENT (new)
// ===========================================================================
const ROLE_LABELS = {
  owner: "Owner",
  global_super_admin: "Global Super Admin",
  country_super_admin: "Country Super Admin",
  country_manager: "Country Manager",
  admin: "Admin",
  moderator: "Moderator"
};
const COUNTRY_LABELS = { IN: "India", BD: "Bangladesh", PK: "Pakistan", AR: "Arabic", OTHERS: "Others" };

if ($("ram-create-btn")) {
  $("ram-create-btn").addEventListener("click", createAdminAccount);
}
// Room 101 (Robin / Customer Service) is the one room a Moderator can be
// scoped to from this form. Only meaningful for the Moderator role — the
// existing assignedRoomIds/inRoomScope RBAC mechanism already enforces
// this server-side, this checkbox just surfaces it in the UI.
if ($("ram-role") && $("ram-room101-wrap")) {
  const syncRoom101Visibility = () => {
    $("ram-room101-wrap").classList.toggle("hidden", $("ram-role").value !== "moderator");
  };
  $("ram-role").addEventListener("change", syncRoom101Visibility);
  syncRoom101Visibility();
}

async function loadRoleManagement() {
  await Promise.all([loadAdminAccounts(), loadAuditLogs()]);
}

async function loadAdminAccounts() {
  const r = await api("/api/admin/accounts");
  const rows = $("ram-accounts-rows");
  const empty = $("ram-accounts-empty");
  if (!r.success || !r.accounts || !r.accounts.length) {
    rows.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  rows.innerHTML = r.accounts.map((a) => {
    const isRoom101 = a.role === "moderator" && Array.isArray(a.assignedRoomIds) && a.assignedRoomIds.includes("101");
    const scopeCell = a.role === "moderator"
      ? (isRoom101 ? '<span class="badge badge-ok">Room 101 (Robin)</span>' : '<span class="hint">All assigned rooms</span>')
      : "—";
    return `
    <tr>
      <td>${escapeHtml(a.username)}</td>
      <td>${escapeHtml(a.fullName || "")}</td>
      <td><span class="role-pill">${escapeHtml(ROLE_LABELS[a.role] || a.role)}</span></td>
      <td>${a.countryId ? escapeHtml(COUNTRY_LABELS[a.countryId] || a.countryId) : "—"}</td>
      <td>${scopeCell}</td>
      <td>${a.status === "active" ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-warn">Suspended</span>'}</td>
      <td>${a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : "—"}</td>
      <td>
        ${a.role === "owner" ? "" : `
          <button class="btn btn-ghost btn-sm" data-toggle="${a.id}" data-status="${a.status}">${a.status === "active" ? "Suspend" : "Activate"}</button>
          <button class="btn-danger-sm" data-del="${a.id}">Delete</button>
          ${a.role === "moderator" ? `<button class="btn btn-ghost btn-sm" data-room101="${a.id}" data-current="${isRoom101 ? "1" : "0"}">${isRoom101 ? "Remove Room 101" : "Assign Room 101"}</button>` : ""}
        `}
      </td>
    </tr>
  `;
  }).join("");
  rows.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => toggleAdminAccount(btn.getAttribute("data-toggle"), btn.getAttribute("data-status")));
  });
  rows.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => deleteAdminAccount(btn.getAttribute("data-del")));
  });
  rows.querySelectorAll("[data-room101]").forEach((btn) => {
    btn.addEventListener("click", () => toggleRoom101Scope(btn.getAttribute("data-room101"), btn.getAttribute("data-current") === "1"));
  });
}

// Toggles a Moderator between "scoped to Room 101 only" and "no room
// restriction from this shortcut" — uses the existing PUT /api/admin/accounts/:id
// assignedRoomIds update path (server.js:4628 / rbac.js updateAccount), so
// no new backend route or permission is introduced.
async function toggleRoom101Scope(id, currentlyAssigned) {
  const r = await api(`/api/admin/accounts/${id}`, "PUT", { assignedRoomIds: currentlyAssigned ? [] : ["101"] });
  if (r.success) {
    toast(currentlyAssigned ? "Room 101 assignment removed" : "Assigned as Room 101 Support Admin ✅");
    loadAdminAccounts();
  } else {
    toast(r.message || "Could not update assignment");
  }
}

async function createAdminAccount() {
  $("ram-create-error").classList.add("hidden");
  const payload = {
    username: $("ram-username").value.trim(),
    password: $("ram-password").value.trim(),
    fullName: $("ram-fullname").value.trim(),
    role: $("ram-role").value,
    countryId: $("ram-country").value || null
  };
  if (payload.role === "moderator" && $("ram-room101-cs")?.checked) {
    payload.assignedRoomIds = ["101"];
  }
  if (!payload.username || !payload.password) {
    $("ram-create-error").textContent = "Username and Password must be provided";
    $("ram-create-error").classList.remove("hidden");
    return;
  }
  const r = await api("/api/admin/accounts", "POST", payload);
  if (r.success) {
    toast("Admin Account created ✅");
    $("ram-username").value = ""; $("ram-password").value = ""; $("ram-fullname").value = "";
    if ($("ram-room101-cs")) $("ram-room101-cs").checked = false;
    loadAdminAccounts();
  } else {
    $("ram-create-error").textContent = r.message || "Could not be created";
    $("ram-create-error").classList.remove("hidden");
  }
}

async function toggleAdminAccount(id, currentStatus) {
  const newStatus = currentStatus === "active" ? "suspended" : "active";
  const r = await api(`/api/admin/accounts/${id}`, "PUT", { status: newStatus });
  if (r.success) { toast("Status updated"); loadAdminAccounts(); }
  else toast(r.message || "An error occurred", true);
}

async function deleteAdminAccount(id) {
  if (!confirm("Permanently delete this Admin Account?")) return;
  const r = await api(`/api/admin/accounts/${id}`, "DELETE");
  if (r.success) { toast("Account deleted"); loadAdminAccounts(); }
  else toast(r.message || "An error occurred", true);
}

async function loadAuditLogs() {
  const r = await api("/api/admin/logs?limit=200");
  const rows = $("ram-logs-rows");
  const empty = $("ram-logs-empty");
  if (!r.success || !r.logs || !r.logs.length) {
    rows.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  rows.innerHTML = r.logs.map((l) => `
    <tr>
      <td>${new Date(l.timestamp).toLocaleString()}</td>
      <td>${escapeHtml(l.adminUsername)}</td>
      <td>${escapeHtml(l.action)}</td>
      <td>${escapeHtml(l.targetType || "")}${l.targetId ? " · " + escapeHtml(l.targetId) : ""}</td>
      <td>${l.result === "failed" ? `<span class="log-result-failed" title="${escapeHtml(l.failureReason || "")}">Failed</span>` : `<span class="log-result-ok">OK</span>`}</td>
    </tr>
  `).join("");
}

// ===========================================================================
// BOOTSTRAP
// ===========================================================================
if (token) enterShell(); else $("view-login").classList.add("active");

// ===========================================================================
// APPROVAL CENTER (Phase 7 — Unified Approval Center UI)
// ===========================================================================
// Pure frontend integration layer over the existing Phase 6 backend
// (approvalEngine.js + agencyApproval.js + vipApproval.js +
// diamondSeller.js + namefxApproval.js + framesApproval.js +
// giftsApproval.js + rechargeWithdrawApproval.js). No backend route,
// permission, or RBAC logic is touched — this only calls existing
// endpoints and renders their responses. Backend remains the final
// authority: every action button still hits the real permission-gated
// route, so a hidden/faked button here can never bypass anything server-
// side (see §13 Security in the Phase 7 instruction).

const AC_MODULES = [
  { key: "agency",         label: "Agency",         basePath: "/api/admin/agency/requests",         viewPerm: "agencies:view",       submitPerm: "agencies:submit",       reviewPerm: "agencies:review",       approvePerm: "agencies:approve",       hasComment: false, titleField: (r) => r.name || r.ownerUserId },
  { key: "recharge",       label: "Recharge",       basePath: "/api/admin/recharge/requests",        viewPerm: "recharge:view",       submitPerm: "recharge:submit",       reviewPerm: "recharge:review",       approvePerm: "recharge:approve",       hasComment: true,  titleField: (r) => (r.amount != null ? r.amount + " coins" : "—") },
  { key: "withdraw",       label: "Withdraw",       basePath: "/api/admin/withdraw/requests",        viewPerm: "withdraw:view",       submitPerm: "withdraw:submit",       reviewPerm: "withdraw:review",       approvePerm: "withdraw:approve",       hasComment: true,  titleField: (r) => (r.amount != null ? r.amount + " diamonds" : "—") },
  { key: "namefx",         label: "Name Effects",   basePath: "/api/admin/name-effects/requests",    viewPerm: "namefx:view",         submitPerm: "namefx:submit",         reviewPerm: "namefx:review",         approvePerm: "namefx:approve",         hasComment: true,  titleField: (r) => r.style || "—" },
  { key: "frames",         label: "Frames",         basePath: "/api/admin/frames/requests",          viewPerm: "frames:view",         submitPerm: "frames:submit",         reviewPerm: "frames:review",         approvePerm: "frames:approve",         hasComment: true,  titleField: (r) => r.frameName || r.frameId || "—" },
  { key: "gifts",          label: "Gifts",          basePath: "/api/admin/gifts/requests",           viewPerm: "gifts:view",          submitPerm: "gifts:submit",          reviewPerm: "gifts:review",          approvePerm: "gifts:approve",          hasComment: true,  titleField: (r) => r.name || "—" },
  { key: "diamond-seller", label: "Diamond Seller", basePath: "/api/admin/diamond-seller/requests",  viewPerm: "diamond-seller:view", submitPerm: "diamond-seller:submit", reviewPerm: "diamond-seller:review", approvePerm: "diamond-seller:approve", hasComment: true,  titleField: (r) => r.fullName || "—" },
  { key: "vip",            label: "VIP",            basePath: "/api/admin/vip/requests",             viewPerm: "vip:view",            submitPerm: "vip:submit",            reviewPerm: "vip:review",            approvePerm: "vip:approve",            hasComment: true,  titleField: (r) => r.tier || "—" }
];
function acModule(key) { return AC_MODULES.find((m) => m.key === key); }

let acRecords = [];        // normalized, merged across all accessible modules
let acCountries = [];      // from /api/admin/countries
let acAccountsByUser = {}; // username -> role (best-effort, only if role:manage)
let acLoaded = false;
let acPage = 1;
let acSelected = null;     // currently open drawer record

function acPerm(p) { return myAdminProfile && (myAdminProfile.permissions || []).includes(p); }

async function acEnterSection() {
  if (!acCountries.length) {
    const c = await api("/api/admin/countries");
    if (c.success) acCountries = c.countries;
  }
  acPopulateFilterOptions();
  if (acPerm("role:manage")) {
    const acc = await api("/api/admin/accounts");
    if (acc.success) {
      acAccountsByUser = {};
      acc.accounts.forEach((a) => { acAccountsByUser[a.username] = a.role; });
      acPopulateRoleFilter();
    }
  }
  await acLoadAll();
}

function acPopulateFilterOptions() {
  const modSel = $("ac-f-module");
  if (modSel.options.length <= 1) {
    AC_MODULES.forEach((m) => {
      if (!acPerm(m.viewPerm)) return;
      const opt = document.createElement("option");
      opt.value = m.key; opt.textContent = m.label;
      modSel.appendChild(opt);
    });
  }
  const countrySel = $("ac-f-country");
  if (countrySel.options.length <= 1) {
    acCountries.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.id; opt.textContent = c.name;
      countrySel.appendChild(opt);
    });
  }
}

function acPopulateRoleFilter() {
  const roleSel = $("ac-f-role");
  if (roleSel.options.length > 1) return;
  const roles = [...new Set(Object.values(acAccountsByUser))];
  roles.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r; opt.textContent = r.replace(/_/g, " ");
    roleSel.appendChild(opt);
  });
}

// ---------------------------------------------------------------------
// FETCH — one list call per module the role can view. Cached in
// acRecords; re-fetched only on Refresh/enter-section, never per
// filter/pagination change (avoids duplicate API calls per §12).
// ---------------------------------------------------------------------
async function acLoadAll() {
  $("ac-table-loading").classList.remove("hidden");
  $("ac-table-empty").classList.add("hidden");
  const calls = AC_MODULES.filter((m) => acPerm(m.viewPerm)).map(async (m) => {
    const r = await api(m.basePath + "?pageSize=200");
    if (!r.success) return [];
    return (r.requests || []).map((rec) => acNormalize(m, rec));
  });
  const results = await Promise.all(calls);
  acRecords = results.flat();
  acLoaded = true;
  acPage = 1;
  $("ac-table-loading").classList.add("hidden");
  acRenderCards();
  acRenderTable();
}

function acNormalize(mod, rec) {
  return {
    module: mod.key,
    moduleLabel: mod.label,
    requestId: rec.requestId,
    userId: rec.userId,
    countryId: rec.countryId,
    submittedBy: rec.submittedBy || null,
    reviewedBy: rec.reviewedBy || null,
    decidedBy: rec.decidedBy || null,
    reopenedBy: rec.reopenedBy || null,
    status: rec.status,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    title: mod.titleField(rec),
    raw: rec
  };
}

// ---------------------------------------------------------------------
// DASHBOARD CARDS
// ---------------------------------------------------------------------
function acRenderCards() {
  const today = new Date().toDateString();
  const isToday = (iso) => iso && new Date(iso).toDateString() === today;

  const pending = acRecords.filter((r) => r.status === "pending").length;
  const review = acRecords.filter((r) => r.status === "review").length;
  const approvedToday = acRecords.filter((r) => r.status === "approved" && isToday(r.updatedAt)).length;
  const rejectedToday = acRecords.filter((r) => r.status === "rejected" && isToday(r.updatedAt)).length;
  const reopened = acRecords.filter((r) => !!r.reopenedBy).length;
  // "Expired" bucket: approved requests whose linked VIP membership is
  // expired, or whose linked Diamond Seller is suspended — the request
  // model itself has no "expired" status, only the linked resource does.
  const expired = acRecords.filter((r) => {
    if (r.module === "vip" && r.raw.membershipId && r._membershipStatus === "expired") return true;
    if (r.module === "diamond-seller" && r.raw.sellerId && r._sellerStatus === "suspended") return true;
    return false;
  }).length;

  const byCountry = {};
  acRecords.forEach((r) => { byCountry[r.countryId || "OTHERS"] = (byCountry[r.countryId || "OTHERS"] || 0) + 1; });

  const cards = [
    { cls: "st-pending", num: pending, lbl: "Pending", filterStatus: "pending" },
    { cls: "st-review", num: review, lbl: "Under Review", filterStatus: "review" },
    { cls: "st-approved", num: approvedToday, lbl: "Approved Today", filterStatus: "approved" },
    { cls: "st-rejected", num: rejectedToday, lbl: "Rejected Today", filterStatus: "rejected" },
    { cls: "st-expired", num: expired, lbl: "Expired", filterStatus: "expired" },
    { cls: "st-reopened", num: reopened, lbl: "Reopened", filterStatus: "reopened" }
  ];
  const wrap = $("ac-stat-grid");
  wrap.innerHTML = cards.map((c) => `
    <div class="ac-stat-card ${c.cls}" data-status="${c.filterStatus}">
      <span class="ac-stat-num">${c.num}</span><span class="ac-stat-lbl">${c.lbl}</span>
    </div>
  `).join("") + `
    <div class="ac-stat-card st-country">
      <span class="ac-stat-lbl">Country Statistics</span>
      ${Object.entries(byCountry).map(([cid, n]) => `<span class="ac-country-mini"><span>${escapeHtml(cid)}</span><b>${n}</b></span>`).join("") || '<span class="ac-country-mini">—</span>'}
    </div>
  `;
  wrap.querySelectorAll(".ac-stat-card[data-status]").forEach((card) => {
    card.addEventListener("click", () => {
      $("ac-f-status").value = card.getAttribute("data-status");
      acPage = 1; acRenderTable();
    });
  });
}

// ---------------------------------------------------------------------
// FILTERING (client-side, over the merged in-memory list)
// ---------------------------------------------------------------------
function acGetFilters() {
  return {
    from: $("ac-f-from").value || null,
    to: $("ac-f-to").value || null,
    module: $("ac-f-module").value || null,
    status: $("ac-f-status").value || null,
    countryId: $("ac-f-country").value || null,
    role: $("ac-f-role").value || null,
    reviewer: $("ac-f-reviewer").value.trim().toLowerCase() || null,
    applicant: $("ac-f-applicant").value.trim().toLowerCase() || null,
    vipTier: $("ac-f-viptier").value || null,
    agency: $("ac-f-agency").value.trim().toLowerCase() || null,
    dseller: $("ac-f-dseller").value.trim().toLowerCase() || null,
    q: $("ac-global-search").value.trim().toLowerCase() || null
  };
}

function acFilteredRecords() {
  const f = acGetFilters();
  return acRecords.filter((r) => {
    if (f.module && r.module !== f.module) return false;
    if (f.countryId && r.countryId !== f.countryId) return false;
    if (f.from && new Date(r.createdAt) < new Date(f.from)) return false;
    if (f.to && new Date(r.createdAt) > new Date(f.to + "T23:59:59")) return false;
    if (f.status) {
      if (f.status === "reopened") { if (!r.reopenedBy) return false; }
      else if (f.status === "expired") {
        const isExp = (r.module === "vip" && r._membershipStatus === "expired") || (r.module === "diamond-seller" && r._sellerStatus === "suspended");
        if (!isExp) return false;
      } else if (r.status !== f.status) return false;
    }
    if (f.role) {
      const uname = r.submittedBy && r.submittedBy.username;
      if (!uname || acAccountsByUser[uname] !== f.role) return false;
    }
    if (f.reviewer) {
      const rv = (r.reviewedBy && r.reviewedBy.username || "").toLowerCase();
      if (!rv.includes(f.reviewer)) return false;
    }
    if (f.applicant) {
      const hay = [r.userId, r.raw.targetUserName, r.submittedBy && r.submittedBy.username].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(f.applicant)) return false;
    }
    if (f.vipTier && !(r.module === "vip" && r.raw.tier === f.vipTier)) return false;
    if (f.agency && !(r.module === "agency" && ((r.raw.name || "").toLowerCase().includes(f.agency) || (r.raw.ownerUserId || "").toLowerCase().includes(f.agency)))) return false;
    if (f.dseller && !(r.module === "diamond-seller" && ((r.raw.fullName || "").toLowerCase().includes(f.dseller) || (r.raw.kycIdNumber || "").toLowerCase().includes(f.dseller)))) return false;
    if (f.q) {
      const hay = [r.requestId, r.userId, r.title, r.moduleLabel, r.submittedBy && r.submittedBy.username].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

$("ac-btn-apply").addEventListener("click", () => { acPage = 1; acRenderTable(); });
$("ac-btn-clear").addEventListener("click", () => {
  ["ac-f-from", "ac-f-to", "ac-f-reviewer", "ac-f-applicant", "ac-f-agency", "ac-f-dseller", "ac-global-search"].forEach((id) => { $(id).value = ""; });
  ["ac-f-module", "ac-f-status", "ac-f-country", "ac-f-role", "ac-f-viptier"].forEach((id) => { $(id).value = ""; });
  acPage = 1; acRenderTable();
});
$("ac-btn-refresh").addEventListener("click", acLoadAll);
$("ac-global-search").addEventListener("input", () => { acPage = 1; acRenderTable(); });
$("ac-page-size").addEventListener("change", () => { acPage = 1; acRenderTable(); });
$("ac-btn-prev").addEventListener("click", () => { if (acPage > 1) { acPage--; acRenderTable(); } });
$("ac-btn-next").addEventListener("click", () => { acPage++; acRenderTable(); });

// ---------------------------------------------------------------------
// TABLE + PAGINATION
// ---------------------------------------------------------------------
function acStatusBadge(r) {
  let cls = "badge-status-" + r.status, label = r.status;
  if (r.module === "vip" && r._membershipStatus === "expired") { cls = "badge-status-expired"; label = "expired"; }
  if (r.module === "diamond-seller" && r._sellerStatus === "suspended") { cls = "badge-status-suspended"; label = "suspended"; }
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function acRenderTable() {
  const filtered = acFilteredRecords();
  const pageSize = Number($("ac-page-size").value) || 50;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (acPage > totalPages) acPage = totalPages;
  const start = (acPage - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  $("ac-table-empty").classList.toggle("hidden", pageRows.length > 0);
  $("ac-table-rows").innerHTML = pageRows.map((r) => `
    <tr>
      <td class="mono">${escapeHtml(r.requestId)}</td>
      <td>${escapeHtml(r.moduleLabel)}<div class="hint">${escapeHtml(r.title || "")}</div></td>
      <td class="mono">${escapeHtml(r.userId || "—")}</td>
      <td>${escapeHtml(r.countryId || "—")}</td>
      <td>${escapeHtml(r.submittedBy ? r.submittedBy.username : "—")}</td>
      <td>${escapeHtml(r.reviewedBy ? r.reviewedBy.username : "—")}</td>
      <td>${acStatusBadge(r)}</td>
      <td class="hint">${new Date(r.createdAt).toLocaleString()}</td>
      <td class="hint">${new Date(r.updatedAt).toLocaleString()}</td>
      <td><button class="ac-row-link" data-open="${escapeHtml(r.module)}::${escapeHtml(r.requestId)}">Details ▸</button></td>
    </tr>
  `).join("");
  $("ac-table-rows").querySelectorAll("[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const [mod, id] = btn.getAttribute("data-open").split("::");
      acOpenDrawer(mod, id);
    });
  });
  $("ac-page-info").textContent = total === 0 ? "No results" : `${start + 1}–${Math.min(start + pageSize, total)} / Total ${total}`;
  $("ac-btn-prev").disabled = acPage <= 1;
  $("ac-btn-next").disabled = acPage >= totalPages;
}

// ---------------------------------------------------------------------
// DRAWER — details / timeline / comments / related objects
// ---------------------------------------------------------------------
function acFindRecord(moduleKey, requestId) {
  return acRecords.find((r) => r.module === moduleKey && r.requestId === requestId);
}

async function acOpenDrawer(moduleKey, requestId) {
  const rec = acFindRecord(moduleKey, requestId);
  if (!rec) return;
  acSelected = rec;
  $("ac-drawer-overlay").classList.remove("hidden");
  acRenderDrawer();
}

function acCloseDrawer() {
  $("ac-drawer-overlay").classList.add("hidden");
  acSelected = null;
}
$("ac-drawer-close").addEventListener("click", acCloseDrawer);
$("ac-drawer-overlay").addEventListener("click", (e) => { if (e.target.id === "ac-drawer-overlay") acCloseDrawer(); });

function acRenderDrawer() {
  const r = acSelected;
  const mod = acModule(r.module);
  $("ac-drawer-title").textContent = `${r.moduleLabel} · ${r.requestId}`;
  $("ac-drawer-badge").outerHTML = `<span id="ac-drawer-badge">${acStatusBadge(r)}</span>`;

  // ---- user info ----
  $("ac-drawer-userinfo").innerHTML = [
    ["User ID", r.userId || "—"],
    ["Target User", r.raw.targetUserName || "—"],
    ["Country", r.countryId || "—"],
    ["Submitted By", r.submittedBy ? `${r.submittedBy.username}${acAccountsByUser[r.submittedBy.username] ? " (" + acAccountsByUser[r.submittedBy.username].replace(/_/g, " ") + ")" : ""}` : "—"],
    ["Reviewed By", r.reviewedBy ? r.reviewedBy.username : "—"],
    ["Decided By", r.decidedBy ? r.decidedBy.username : "—"]
  ].map(([k, v]) => `<div class="ac-kv-row"><b>${escapeHtml(k)}</b><span>${escapeHtml(String(v))}</span></div>`).join("");

  // ---- current / previous state ----
  const hist = r.raw.history || [];
  const prevEntry = hist.length >= 2 ? hist[hist.length - 2] : null;
  $("ac-drawer-state").innerHTML = [
    ["Current Status", r.status],
    ["Current Note", r.raw.decisionNote || r.raw.reviewNote || r.raw.submitNote || "—"],
    ["Previous Action", prevEntry ? prevEntry.action : "—"],
    ["Previous By", prevEntry && prevEntry.by ? prevEntry.by.username : "—"]
  ].map(([k, v]) => `<div class="ac-kv-row"><b>${escapeHtml(k)}</b><span>${escapeHtml(String(v))}</span></div>`).join("");

  // ---- related objects (module-specific linked resource) ----
  acRenderRelated(r);

  // ---- attachments ----
  const attach = [];
  if (r.raw.previewImageUrl) attach.push({ url: r.raw.previewImageUrl, kind: "image" });
  if (r.raw.thumbnailUrl) attach.push({ url: r.raw.thumbnailUrl, kind: "image" });
  if (r.raw.videoUrl) attach.push({ url: r.raw.videoUrl, kind: "link", label: "Video" });
  if (r.raw.soundUrl) attach.push({ url: r.raw.soundUrl, kind: "link", label: "Sound" });
  if (Array.isArray(r.raw.documents)) r.raw.documents.forEach((d) => attach.push({ url: d, kind: "link", label: "KYC Document" }));
  $("ac-drawer-attach-wrap").classList.toggle("hidden", attach.length === 0);
  $("ac-drawer-attachments").innerHTML = attach.map((a) =>
    a.kind === "image"
      ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(a.url)}" alt=""></a>`
      : `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.label || "Link")} ↗</a>`
  ).join("");

  // ---- timeline (uses record.history[] when the engine provides it;
  // agency's hand-rolled module has no history[], so it's synthesized
  // from submittedBy/reviewedBy/decidedBy/reopenedBy instead) ----
  acRenderTimeline(r);

  // ---- comment box (only for engine-backed modules — agency has no
  // /comment endpoint) ----
  $("ac-drawer-comment-wrap").classList.toggle("hidden", !mod.hasComment);

  // ---- action bar ----
  acRenderActionBar(r);
}

function acRenderRelated(r) {
  const wrap = $("ac-drawer-related");
  let html = "";
  if (r.module === "vip" && r.raw.membershipId) {
    html += `<div class="ac-kv-row"><b>VIP Membership</b><span class="mono">${escapeHtml(r.raw.membershipId)}</span></div>`;
    if (acPerm("vip:approve")) {
      html += `<div class="form-row" style="margin-top:6px;">
        <button class="btn btn-ghost btn-sm" data-vip-action="renew" data-mid="${escapeHtml(r.raw.membershipId)}">Renew (30 days)</button>
        <button class="btn btn-danger btn-sm" data-vip-action="expire" data-mid="${escapeHtml(r.raw.membershipId)}">Force Expire</button>
      </div>`;
    }
  } else if (r.module === "diamond-seller" && r.raw.sellerId) {
    html += `<div class="ac-kv-row"><b>Seller ID</b><span class="mono">${escapeHtml(r.raw.sellerId)}</span></div>`;
    if (acPerm("diamond-seller:suspend")) {
      html += `<div class="form-row" style="margin-top:6px;">
        <button class="btn btn-ghost btn-sm" data-dsr-action="suspend" data-sid="${escapeHtml(r.raw.sellerId)}">Suspend</button>
        <button class="btn btn-ghost btn-sm" data-dsr-action="restore" data-sid="${escapeHtml(r.raw.sellerId)}">Restore</button>
      </div>`;
    }
    if (acPerm("diamond-seller:approve")) {
      html += `<div class="form-row" style="margin-top:6px;">
        <input type="number" step="0.1" id="ac-commission-input" class="field" placeholder="New Commission %">
        <button class="btn btn-primary btn-sm" data-dsr-action="commission" data-sid="${escapeHtml(r.raw.sellerId)}">Change Commission</button>
      </div>`;
    }
  } else if (r.module === "agency" && r.raw.agencyId) {
    html += `<div class="ac-kv-row"><b>Agency ID</b><span class="mono">${escapeHtml(r.raw.agencyId)}</span></div>`;
  } else {
    html = `<div class="hint">There is no separate resource linked to this request.</div>`;
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll("[data-vip-action]").forEach((b) => b.addEventListener("click", () => acVipAction(b.getAttribute("data-vip-action"), b.getAttribute("data-mid"))));
  wrap.querySelectorAll("[data-dsr-action]").forEach((b) => b.addEventListener("click", () => acDiamondSellerAction(b.getAttribute("data-dsr-action"), b.getAttribute("data-sid"))));
}

function acRenderTimeline(r) {
  const hist = r.raw.history;
  let entries;
  if (Array.isArray(hist) && hist.length) {
    entries = hist.slice().reverse();
  } else {
    // Synthesized fallback (agency module) — build from the flat fields
    // every request record (shared or hand-rolled) is guaranteed to have.
    entries = [];
    if (r.raw.reopenedBy) entries.push({ action: "reopen", by: r.raw.reopenedBy, at: r.updatedAt });
    if (r.raw.decidedBy) entries.push({ action: r.status === "rejected" ? "reject" : "approve", by: r.raw.decidedBy, note: r.raw.decisionNote, at: r.updatedAt });
    if (r.raw.reviewedBy) entries.push({ action: "review", by: r.raw.reviewedBy, note: r.raw.reviewNote, at: r.raw.updatedAt });
    if (r.raw.submittedBy) entries.push({ action: "submit", by: r.raw.submittedBy, note: r.raw.submitNote, at: r.createdAt });
  }
  $("ac-drawer-timeline").innerHTML = entries.map((e) => `
    <div class="ac-timeline-item">
      <div class="ac-tl-action">${escapeHtml(e.action)}</div>
      <div class="ac-tl-meta">${e.by ? escapeHtml(e.by.username) : "system"} · ${e.at ? new Date(e.at).toLocaleString() : "—"}</div>
      ${e.note ? `<div class="ac-tl-note">${escapeHtml(e.note)}</div>` : ""}
    </div>
  `).join("") || `<div class="hint">No history.</div>`;
}

function acRenderActionBar(r) {
  const mod = acModule(r.module);
  const bar = $("ac-drawer-actionbar");
  const btns = [];
  if (r.status === "pending" && acPerm(mod.reviewPerm)) btns.push(`<button class="btn btn-ghost btn-sm" data-act="review">Review</button>`);
  if (["pending", "review"].includes(r.status) && acPerm(mod.approvePerm)) btns.push(`<button class="btn btn-primary btn-sm" data-act="approve">Approve</button>`);
  if (["pending", "review"].includes(r.status) && (acPerm(mod.reviewPerm) || acPerm(mod.approvePerm))) btns.push(`<button class="btn btn-danger btn-sm" data-act="reject">Reject</button>`);
  if (r.status === "rejected" && (acPerm(mod.submitPerm) || acPerm(mod.reviewPerm) || acPerm(mod.approvePerm))) btns.push(`<button class="btn btn-ghost btn-sm" data-act="reopen">Reopen</button>`);
  bar.innerHTML = btns.join("") || `<span class="hint">There is no Action Permission for this Request right now.</span>`;
  bar.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => acDoAction(r, b.getAttribute("data-act"))));
}

async function acDoAction(r, action) {
  const mod = acModule(r.module);
  let note = null;
  if (action === "reject") note = prompt("Write a reason for rejecting (optional):") || "";
  else if (["review", "approve", "reopen"].includes(action)) note = prompt("Write a note (optional):") || "";
  if (note === null) return; // user cancelled the prompt
  const res = await api(`${mod.basePath}/${r.requestId}/${action}`, "POST", { note });
  if (!res.success) { toast(res.message || "An error occurred", true); return; }
  toast("Request updated");
  Object.assign(r.raw, res.request);
  r.status = res.request.status;
  r.reviewedBy = res.request.reviewedBy;
  r.decidedBy = res.request.decidedBy;
  r.reopenedBy = res.request.reopenedBy;
  r.updatedAt = res.request.updatedAt;
  acRenderCards();
  acRenderTable();
  acRenderDrawer();
}

$("ac-comment-send").addEventListener("click", async () => {
  const r = acSelected;
  if (!r) return;
  const mod = acModule(r.module);
  const text = $("ac-comment-input").value.trim();
  if (!text) return;
  const res = await api(`${mod.basePath}/${r.requestId}/comment`, "POST", { text });
  if (!res.success) { toast(res.message || "An error occurred", true); return; }
  $("ac-comment-input").value = "";
  Object.assign(r.raw, res.request);
  acRenderDrawer();
});

// ---------------------------------------------------------------------
// VIP membership + Diamond Seller quick actions (act on the linked
// resource, not the request record itself — see §7 in the instruction).
// ---------------------------------------------------------------------
async function acVipAction(action, membershipId) {
  const r = acSelected;
  const body = action === "renew" ? { days: 30 } : {};
  const res = await api(`/api/admin/vip/memberships/${membershipId}/${action}`, "POST", body);
  if (!res.success) { toast(res.message || "An error occurred", true); return; }
  toast(action === "renew" ? "Membership Renewed" : "Membership Expired");
  if (r) { r._membershipStatus = res.membership.status; acRenderCards(); acRenderTable(); acRenderDrawer(); }
}

async function acDiamondSellerAction(action, sellerId) {
  const r = acSelected;
  if (action === "commission") {
    const rate = $("ac-commission-input") ? $("ac-commission-input").value : "";
    if (!rate) { toast("Provide a new Commission %", true); return; }
    const res = await api(`/api/admin/diamond-seller/sellers/${sellerId}/commission`, "POST", { rate });
    if (!res.success) { toast(res.message || "An error occurred", true); return; }
    toast("Commission updated");
    acRenderDrawer();
    return;
  }
  const res = await api(`/api/admin/diamond-seller/sellers/${sellerId}/${action}`, "POST", {});
  if (!res.success) { toast(res.message || "An error occurred", true); return; }
  toast(action === "suspend" ? "Seller Suspended" : "Seller Restored");
  if (r) { r._sellerStatus = res.seller.status; acRenderCards(); acRenderTable(); acRenderDrawer(); }
}

// ===========================================================================
// BAN MANAGEMENT (Phase 8)
// ===========================================================================
// Sidebar visibility is the plain single-permission gate every other simple
// section uses (data-permission="ban:view" on the button, handled already by
// applySidebarPermissions()) — unlike Approval Center this isn't an
// aggregation of many modules, so no custom visibility function is needed.
//
// Two tabs: "Ban List" (the ban registry — GET /api/admin/bans, server-side
// filter/pagination since this is a single endpoint, not merged across
// modules like Approval Center) and "Pending Requests" (the Submit->Review->
// Approve queue on /api/admin/bans/requests, generated by approvalEngine.js —
// approving a request is what CREATES a row in the Ban List).
let bmCountries = [];
let bmPage = 1;
let bmTotal = 0;
let bmRows = [];          // current page of ban records (Ban List tab)
let bmSelected = null;    // ban record open in the drawer
let bmReqRows = [];       // pending/review ban requests (Pending Requests tab)

async function bmEnterSection() {
  if (!bmCountries.length) {
    const c = await api("/api/admin/countries");
    if (c.success) {
      bmCountries = c.countries;
      const sel = $("bm-f-country");
      if (sel.options.length <= 1) {
        bmCountries.forEach((c2) => {
          const opt = document.createElement("option");
          opt.value = c2.id; opt.textContent = c2.name;
          sel.appendChild(opt);
        });
      }
    }
  }
  $("bm-btn-new").classList.toggle("hidden", !acPerm("ban:submit"));
  bmPage = 1;
  await bmLoadSummary();
  await bmLoadList();
  if (acPerm("ban:review") || acPerm("ban:approve")) await bmLoadRequests();
}

// ---------------------------------------------------------------------
// TABS
// ---------------------------------------------------------------------
document.querySelectorAll(".ac-tab[data-bmtab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".ac-tab[data-bmtab]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.getAttribute("data-bmtab");
    $("bm-panel-list").classList.toggle("hidden", which !== "list");
    $("bm-panel-requests").classList.toggle("hidden", which !== "requests");
    if (which === "requests") bmLoadRequests();
  });
});

// ---------------------------------------------------------------------
// DASHBOARD CARDS — GET /api/admin/bans/summary
// ---------------------------------------------------------------------
async function bmLoadSummary() {
  const r = await api("/api/admin/bans/summary");
  if (!r.success) return;
  const s = r.summary;
  const cards = [
    { cls: "st-active", num: s.activeBans, lbl: "Active Bans", status: "active" },
    { cls: "st-pending", num: s.temporaryBans, lbl: "Temporary Bans" },
    { cls: "st-rejected", num: s.permanentBans, lbl: "Permanent Bans" },
    { cls: "st-review", num: s.deviceIpBans, lbl: "Device/IP Bans" },
    { cls: "st-reopened", num: s.pendingAppeals, lbl: "Pending Appeals" },
    { cls: "st-restored", num: s.restored, lbl: "Restored", status: "restored" },
    { cls: "st-expired", num: s.rejectedAppeals, lbl: "Rejected Appeals" }
  ];
  const wrap = $("bm-stat-grid");
  wrap.innerHTML = cards.map((c) => `
    <div class="ac-stat-card ${c.cls}" ${c.status ? `data-status="${c.status}"` : ""}>
      <span class="ac-stat-num">${c.num}</span><span class="ac-stat-lbl">${c.lbl}</span>
    </div>
  `).join("");
  wrap.querySelectorAll(".ac-stat-card[data-status]").forEach((card) => {
    card.addEventListener("click", () => {
      $("bm-f-status").value = card.getAttribute("data-status");
      bmPage = 1; bmLoadList();
    });
  });
}

// ---------------------------------------------------------------------
// BAN LIST — server-side filter/search/pagination/sort (GET /api/admin/bans)
// ---------------------------------------------------------------------
function bmGetFilters() {
  return {
    countryId: $("bm-f-country").value || "",
    banType: $("bm-f-type").value || "",
    status: $("bm-f-status").value || "",
    reason: $("bm-f-reason").value.trim() || "",
    dateFrom: $("bm-f-from").value || "",
    dateTo: $("bm-f-to").value || "",
    q: $("bm-global-search").value.trim() || ""
  };
}

async function bmLoadList() {
  $("bm-table-loading").classList.remove("hidden");
  $("bm-table-empty").classList.add("hidden");
  const f = bmGetFilters();
  const pageSize = Number($("bm-page-size").value) || 50;
  const params = new URLSearchParams(Object.assign({}, f, { page: bmPage, pageSize }));
  Object.keys(f).forEach((k) => { if (!f[k]) params.delete(k); });
  const r = await api(`/api/admin/bans?${params.toString()}`);
  $("bm-table-loading").classList.add("hidden");
  if (!r.success) { bmRows = []; bmTotal = 0; bmRenderTable(); return; }
  bmRows = r.bans || [];
  bmTotal = r.total || 0;
  bmRenderTable();
}

$("bm-btn-apply").addEventListener("click", () => { bmPage = 1; bmLoadList(); });
$("bm-btn-clear").addEventListener("click", () => {
  ["bm-f-reason", "bm-f-from", "bm-f-to", "bm-global-search"].forEach((id) => { $(id).value = ""; });
  ["bm-f-country", "bm-f-type", "bm-f-status"].forEach((id) => { $(id).value = ""; });
  bmPage = 1; bmLoadList();
});
$("bm-btn-refresh").addEventListener("click", () => { bmLoadSummary(); bmLoadList(); });
$("bm-global-search").addEventListener("input", () => { bmPage = 1; bmLoadList(); });
$("bm-page-size").addEventListener("change", () => { bmPage = 1; bmLoadList(); });
$("bm-btn-prev").addEventListener("click", () => { if (bmPage > 1) { bmPage--; bmLoadList(); } });
$("bm-btn-next").addEventListener("click", () => { bmPage++; bmLoadList(); });

function bmStatusBadge(status) {
  return `<span class="badge badge-status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function bmDurationLabel(b) {
  if (b.banType === "permanent") return "Permanent";
  if (!b.durationDays) return "—";
  return b.durationDays + " days";
}

function bmRenderTable() {
  const pageSize = Number($("bm-page-size").value) || 50;
  const totalPages = Math.max(1, Math.ceil(bmTotal / pageSize));
  $("bm-table-empty").classList.toggle("hidden", bmRows.length > 0);
  $("bm-table-rows").innerHTML = bmRows.map((b) => `
    <tr>
      <td class="mono">${escapeHtml(b.banId)}</td>
      <td>${escapeHtml(b.userName || b.userId || "—")}</td>
      <td>${escapeHtml(b.countryId || "—")}</td>
      <td>${escapeHtml(b.banType)}</td>
      <td>${escapeHtml(b.reason || "—")}</td>
      <td>${bmDurationLabel(b)}</td>
      <td>${bmStatusBadge(b.status)}${b.appealStatus ? ` <span class="badge badge-status-${escapeHtml(b.appealStatus)}">appeal: ${escapeHtml(b.appealStatus)}</span>` : ""}</td>
      <td>${escapeHtml(b.assignedAdmin ? b.assignedAdmin.username : "—")}</td>
      <td class="hint">${new Date(b.createdAt).toLocaleString()}</td>
      <td class="hint">${b.expiryAt ? new Date(b.expiryAt).toLocaleString() : "—"}</td>
      <td><button class="ac-row-link" data-bmopen="${escapeHtml(b.banId)}">Details ▸</button></td>
    </tr>
  `).join("");
  $("bm-table-rows").querySelectorAll("[data-bmopen]").forEach((btn) => {
    btn.addEventListener("click", () => bmOpenDrawer(btn.getAttribute("data-bmopen")));
  });
  const start = bmTotal === 0 ? 0 : (bmPage - 1) * pageSize + 1;
  $("bm-page-info").textContent = bmTotal === 0 ? "No results" : `${start}–${Math.min(bmPage * pageSize, bmTotal)} / Total ${bmTotal}`;
  $("bm-btn-prev").disabled = bmPage <= 1;
  $("bm-btn-next").disabled = bmPage >= totalPages;
}

// ---------------------------------------------------------------------
// DRAWER — User Info / Ban Details / Appeal / Timeline / Comment
// ---------------------------------------------------------------------
function bmFindRow(banId) { return bmRows.find((b) => b.banId === banId); }

async function bmOpenDrawer(banId) {
  const r = await api(`/api/admin/bans/${banId}`);
  if (!r.success) { toast(r.message || "Could not load", true); return; }
  bmSelected = r.ban;
  $("bm-drawer-overlay").classList.remove("hidden");
  bmRenderDrawer();
}
function bmCloseDrawer() { $("bm-drawer-overlay").classList.add("hidden"); bmSelected = null; }
$("bm-drawer-close").addEventListener("click", bmCloseDrawer);
$("bm-drawer-overlay").addEventListener("click", (e) => { if (e.target.id === "bm-drawer-overlay") bmCloseDrawer(); });

function bmRenderDrawer() {
  const b = bmSelected;
  $("bm-drawer-title").textContent = `${escapeHtml(b.banType)} · ${b.banId}`;
  $("bm-drawer-badge").outerHTML = `<span id="bm-drawer-badge">${bmStatusBadge(b.status)}</span>`;

  $("bm-drawer-userinfo").innerHTML = [
    ["User ID", b.userId || "—"],
    ["User Name", b.userName || "—"],
    ["Country", b.countryId || "—"]
  ].map(([k, v]) => `<div class="ac-kv-row"><b>${escapeHtml(k)}</b><span>${escapeHtml(String(v))}</span></div>`).join("");

  const hist = b.history || [];
  const prevEntry = hist.length >= 2 ? hist[hist.length - 2] : null;
  $("bm-drawer-details").innerHTML = [
    ["Ban Type", b.banType],
    ["Reason", b.reason || "—"],
    ["Duration", bmDurationLabel(b)],
    ["Device ID", b.deviceId || "—"],
    ["IP Address", b.ipAddress || "—"],
    ["Assigned Admin", b.assignedAdmin ? b.assignedAdmin.username : "—"],
    ["Created", new Date(b.createdAt).toLocaleString()],
    ["Expiry", b.expiryAt ? new Date(b.expiryAt).toLocaleString() : "—"],
    ["Current Status (After)", b.status],
    ["Previous State (Before)", prevEntry ? prevEntry.type : "—"]
  ].map(([k, v]) => `<div class="ac-kv-row"><b>${escapeHtml(k)}</b><span>${escapeHtml(String(v))}</span></div>`).join("");

  bmRenderAppeal(b);
  bmRenderTimeline(b);
  bmRenderActionBar(b);
}

function bmRenderAppeal(b) {
  const status = b.appealStatus || "No Appeal";
  let html = `<div class="ac-kv-row"><b>Appeal Status</b><span>${escapeHtml(status)}</span></div>`;
  $("bm-drawer-appeal").innerHTML = html;
  const entries = (b.appealHistory || []).slice().reverse();
  $("bm-drawer-appeal-timeline").innerHTML = entries.map((e) => `
    <div class="ac-timeline-item">
      <div class="ac-tl-action">${escapeHtml(e.type)}</div>
      <div class="ac-tl-meta">${e.by ? escapeHtml(e.by.username) : "system"} · ${e.at ? new Date(e.at).toLocaleString() : "—"}</div>
      ${e.note ? `<div class="ac-tl-note">${escapeHtml(e.note)}</div>` : ""}
    </div>
  `).join("") || `<div class="hint">No appeal actions yet.</div>`;
}

function bmRenderTimeline(b) {
  const entries = (b.history || []).slice().reverse();
  $("bm-drawer-timeline").innerHTML = entries.map((e) => `
    <div class="ac-timeline-item">
      <div class="ac-tl-action">${escapeHtml(e.type)}</div>
      <div class="ac-tl-meta">${e.by ? escapeHtml(e.by.username) : "system"} · ${e.at ? new Date(e.at).toLocaleString() : "—"}</div>
      ${e.note ? `<div class="ac-tl-note">${escapeHtml(e.note)}</div>` : ""}
    </div>
  `).join("") || `<div class="hint">No history.</div>`;
}

function bmRenderActionBar(b) {
  const bar = $("bm-drawer-actionbar");
  const btns = [];
  if (b.status === "active" && acPerm("ban:approve")) btns.push(`<button class="btn btn-primary btn-sm" data-bmact="restore">Restore User</button>`);
  if (b.status === "restored" && acPerm("ban:approve")) btns.push(`<button class="btn btn-ghost btn-sm" data-bmact="reopen">Reopen Ban</button>`);
  if (b.status === "active" && !["pending", "under_review"].includes(b.appealStatus) && acPerm("ban:view")) btns.push(`<button class="btn btn-ghost btn-sm" data-bmact="appeal-submit">Start Appeal</button>`);
  if (b.appealStatus === "pending" && acPerm("ban:appeal-review")) btns.push(`<button class="btn btn-ghost btn-sm" data-bmact="appeal-review">Review Appeal</button>`);
  if (["pending", "under_review"].includes(b.appealStatus) && acPerm("ban:appeal-decide")) {
    btns.push(`<button class="btn btn-primary btn-sm" data-bmact="appeal-restore">Restore (Appeal)</button>`);
    btns.push(`<button class="btn btn-danger btn-sm" data-bmact="appeal-reject">Reject Appeal</button>`);
  }
  bar.innerHTML = btns.join("") || `<span class="hint">There is no Action Permission right now.</span>`;
  bar.querySelectorAll("[data-bmact]").forEach((btn) => btn.addEventListener("click", () => bmDoAction(b, btn.getAttribute("data-bmact"))));
}

const BM_ACTION_ENDPOINT = {
  "restore": "restore", "reopen": "reopen",
  "appeal-submit": "appeal", "appeal-review": "appeal/review",
  "appeal-restore": "appeal/restore", "appeal-reject": "appeal/reject"
};
async function bmDoAction(b, action) {
  let note = null;
  if (["appeal-reject", "appeal-submit", "appeal-review"].includes(action)) note = prompt("Write a note (optional):") || "";
  if (note === null) return;
  const res = await api(`/api/admin/bans/${b.banId}/${BM_ACTION_ENDPOINT[action]}`, "POST", { note });
  if (!res.success) { toast(res.message || "An error occurred", true); return; }
  toast("Updated");
  bmSelected = res.ban;
  bmRenderDrawer();
  bmLoadSummary();
  bmLoadList();
}

$("bm-comment-send").addEventListener("click", async () => {
  if (!bmSelected) return;
  const text = $("bm-comment-input").value.trim();
  if (!text) return;
  const res = await api(`/api/admin/bans/${bmSelected.banId}/comment`, "POST", { text });
  if (!res.success) { toast(res.message || "An error occurred", true); return; }
  $("bm-comment-input").value = "";
  bmSelected = res.ban;
  bmRenderDrawer();
});

// ---------------------------------------------------------------------
// NEW BAN MODAL — submits into the Pending Requests queue
// (POST /api/admin/bans/requests/submit)
// ---------------------------------------------------------------------
$("bm-btn-new").addEventListener("click", () => { $("bm-new-overlay").classList.remove("hidden"); });
$("bm-new-close").addEventListener("click", () => { $("bm-new-overlay").classList.add("hidden"); });
$("bm-new-overlay").addEventListener("click", (e) => { if (e.target.id === "bm-new-overlay") $("bm-new-overlay").classList.add("hidden"); });
$("bm-new-type").addEventListener("change", () => {
  const t = $("bm-new-type").value;
  $("bm-new-duration").classList.toggle("hidden", t === "permanent");
  $("bm-new-device").classList.toggle("hidden", t !== "device");
  $("bm-new-ip").classList.toggle("hidden", t !== "ip");
});
$("bm-new-submit").addEventListener("click", async () => {
  const body = {
    targetUserId: $("bm-new-userid").value.trim(),
    banType: $("bm-new-type").value,
    reason: $("bm-new-reason").value.trim(),
    durationDays: $("bm-new-duration").value || null,
    deviceId: $("bm-new-device").value.trim() || null,
    ipAddress: $("bm-new-ip").value.trim() || null
  };
  if (!body.targetUserId || !body.reason) { toast("Provide a User ID and Reason", true); return; }
  const res = await api("/api/admin/bans/requests/submit", "POST", body);
  if (!res.success) { toast(res.message || "An error occurred", true); return; }
  toast("Ban Request Submitted — waiting for Review/Approve");
  $("bm-new-overlay").classList.add("hidden");
  ["bm-new-userid", "bm-new-reason", "bm-new-duration", "bm-new-device", "bm-new-ip"].forEach((id) => { $(id).value = ""; });
  bmLoadRequests();
});

// ---------------------------------------------------------------------
// PENDING REQUESTS TAB — Submit->Review->Approve/Reject->Reopen queue
// (generated by approvalEngine.js, same shape as Approval Center modules)
// ---------------------------------------------------------------------
async function bmLoadRequests() {
  const r = await api("/api/admin/bans/requests?pageSize=200");
  if (!r.success) { bmReqRows = []; bmRenderRequests(); return; }
  bmReqRows = (r.requests || []).filter((req) => ["pending", "review", "rejected"].includes(req.status));
  bmRenderRequests();
}

function bmRenderRequests() {
  $("bm-req-empty").classList.toggle("hidden", bmReqRows.length > 0);
  $("bm-req-rows").innerHTML = bmReqRows.map((req) => {
    const btns = [];
    if (req.status === "pending" && acPerm("ban:review")) btns.push(`<button class="btn btn-ghost btn-sm" data-bmreq="review" data-id="${escapeHtml(req.requestId)}">Review</button>`);
    if (["pending", "review"].includes(req.status) && acPerm("ban:approve")) btns.push(`<button class="btn btn-primary btn-sm" data-bmreq="approve" data-id="${escapeHtml(req.requestId)}">Approve</button>`);
    if (["pending", "review"].includes(req.status) && (acPerm("ban:review") || acPerm("ban:approve"))) btns.push(`<button class="btn btn-danger btn-sm" data-bmreq="reject" data-id="${escapeHtml(req.requestId)}">Reject</button>`);
    if (req.status === "rejected" && (acPerm("ban:submit") || acPerm("ban:review") || acPerm("ban:approve"))) btns.push(`<button class="btn btn-ghost btn-sm" data-bmreq="reopen" data-id="${escapeHtml(req.requestId)}">Reopen</button>`);
    return `
    <tr>
      <td class="mono">${escapeHtml(req.requestId)}</td>
      <td>${escapeHtml(req.targetUserName || req.userId || "—")}</td>
      <td>${escapeHtml(req.countryId || "—")}</td>
      <td>${escapeHtml(req.banType)}</td>
      <td>${escapeHtml(req.reason || "—")}</td>
      <td>${bmDurationLabel(req)}</td>
      <td>${bmStatusBadge(req.status)}</td>
      <td>${escapeHtml(req.submittedBy ? req.submittedBy.username : "—")}</td>
      <td class="hint">${new Date(req.createdAt).toLocaleString()}</td>
      <td>${btns.join(" ") || '<span class="hint">—</span>'}</td>
    </tr>`;
  }).join("");
  $("bm-req-rows").querySelectorAll("[data-bmreq]").forEach((btn) => {
    btn.addEventListener("click", () => bmDoRequestAction(btn.getAttribute("data-id"), btn.getAttribute("data-bmreq")));
  });
}

async function bmDoRequestAction(requestId, action) {
  let note = prompt("Write a note (optional):");
  if (note === null) return;
  if (action === "reject") note = note || "";
  const res = await api(`/api/admin/bans/requests/${requestId}/${action}`, "POST", { note });
  if (!res.success) { toast(res.message || "An error occurred", true); return; }
  toast(action === "approve" ? "Approved — Ban is now Active" : "Updated");
  bmLoadRequests();
  bmLoadSummary();
  bmLoadList();
}

// ===========================================================================
// DASHBOARD & ANALYTICS (Phase 9)
// ===========================================================================
// Honesty note: nearly every card/chart below is built by calling EXISTING
// admin endpoints (already country-scoped server-side by actorCanAccessCountry,
// already permission-gated) and aggregating client-side — the exact same
// pattern acLoadAll() already uses for Approval Center. The only NEW backend
// route this phase added is /api/admin/analytics/revenue (see analyticsHub.js)
// because no existing endpoint exposes the wallet transaction log in
// aggregate. Metrics with no real backing data (New Registrations, DAU/MAU,
// Deleted Rooms, true historical Popular Rooms, Chat/Voice/Room ban types)
// are intentionally left out rather than invented — see the <p class="hint">
// notes already in the corresponding HTML panels.

const ANALYTICS_APPROVAL_MODULES = AC_MODULES.concat([
  { key: "ban", label: "Ban", basePath: "/api/admin/bans/requests", viewPerm: "ban:view" }
]);

let anCountries = [];
let anLiveTimer = null;
let anCache = { users: [], rooms: [], agencies: [], sellers: [], memberships: [], approvals: [], revenueDays: [] };

function anApplyVisibility() {
  const btn = $("side-analytics");
  if (!btn || !myAdminProfile) return;
  btn.classList.toggle("hidden", !(myAdminProfile.permissions || []).includes("dashboard:view"));
}

function anCountryFilterValue() { return $("an-f-country").value || ""; }
function anFilterByCountry(list, field) {
  const cid = anCountryFilterValue();
  if (!cid) return list;
  return list.filter((x) => (x[field || "countryId"] || "OTHERS") === cid);
}

async function anEnterSection() {
  if (!anCountries.length) {
    const c = await api("/api/admin/countries");
    if (c.success) {
      anCountries = c.countries;
      const sel = $("an-f-country");
      anCountries.forEach((c2) => {
        const opt = document.createElement("option");
        opt.value = c2.id; opt.textContent = c2.name;
        sel.appendChild(opt);
      });
    }
  }
  const isGlobalRole = myAdminProfile && [myAdminProfile.admin.role].some((r) => ["owner", "global_super_admin", "country_super_admin"].includes(r));
  $("an-f-country").disabled = !isGlobalRole;
  if (!isGlobalRole && myAdminProfile) $("an-f-country").value = myAdminProfile.admin.countryId || "";
  $("an-scope-note").textContent = isGlobalRole
    ? "You can view data for all Countries — use the Country dropdown to narrow to a specific Country."
    : `You can only view data for your own Country (${escapeHtml(myAdminProfile.admin.countryId || "—")}) — this is scoped at the backend and cannot be changed from the UI.`;
  const isOwner = myAdminProfile && myAdminProfile.admin.role === "owner";
  $("an-btn-export-csv").classList.toggle("hidden", !isOwner);
  $("an-btn-export-pdf").classList.toggle("hidden", !isOwner);

  await anLoadAll();
  if (anLiveTimer) clearInterval(anLiveTimer);
  anLiveTimer = setInterval(anLoadLive, 30000);
}

document.querySelectorAll(".ac-tab[data-antab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".ac-tab[data-antab]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".an-panel").forEach((p) => p.classList.add("hidden"));
    $("an-panel-" + tab.getAttribute("data-antab")).classList.remove("hidden");
  });
});
$("an-f-country").addEventListener("change", anLoadAll);
$("an-f-range").addEventListener("change", anRenderRevenue);
$("an-btn-refresh").addEventListener("click", anLoadAll);

// ---------------------------------------------------------------------
// LOAD — one pass, cache in anCache, render every panel
// ---------------------------------------------------------------------
async function anLoadAll() {
  const calls = {
    users: acPerm("users:view") ? api("/api/admin/users") : Promise.resolve({ success: false }),
    rooms: acPerm("rooms:view") ? api("/api/admin/rooms") : Promise.resolve({ success: false }),
    agencies: acPerm("agencies:view") ? api("/api/admin/agency/list") : Promise.resolve({ success: false }),
    sellers: acPerm("diamond-seller:view") ? api("/api/admin/diamond-seller/sellers?pageSize=200") : Promise.resolve({ success: false }),
    memberships: acPerm("vip:view") ? api("/api/admin/vip/memberships?pageSize=200") : Promise.resolve({ success: false }),
    banSummary: acPerm("ban:view") ? api("/api/admin/bans/summary") : Promise.resolve({ success: false }),
    banList: acPerm("ban:view") ? api("/api/admin/bans?pageSize=200") : Promise.resolve({ success: false }),
    revenue: acPerm("revenue:view") ? api("/api/admin/analytics/revenue") : Promise.resolve({ success: false })
  };
  const approvalCalls = Promise.all(ANALYTICS_APPROVAL_MODULES.filter((m) => acPerm(m.viewPerm)).map(async (m) => {
    const r = await api(m.basePath + "?pageSize=200");
    return { key: m.key, label: m.label, requests: r.success ? (r.requests || []) : [] };
  }));

  const [users, rooms, agencies, sellers, memberships, banSummary, banList, revenue, approvals] = await Promise.all([
    calls.users, calls.rooms, calls.agencies, calls.sellers, calls.memberships, calls.banSummary, calls.banList, calls.revenue, approvalCalls
  ]);

  anCache.users = users.success ? users.users : [];
  anCache.rooms = rooms.success ? rooms.rooms : [];
  anCache.agencies = agencies.success ? agencies.agencies : [];
  anCache.sellers = sellers.success ? sellers.sellers : [];
  anCache.memberships = memberships.success ? memberships.memberships : [];
  anCache.banSummary = banSummary.success ? banSummary.summary : null;
  anCache.bans = banList.success ? banList.bans : [];
  anCache.revenueDays = revenue.success ? revenue.days : [];
  anCache.approvals = approvals;

  anRenderOverview();
  anLoadLive();
  anRenderRevenue();
  anRenderApprovals();
  anRenderBans();
  anRenderUsers();
  anRenderRooms();
}

// ---------------------------------------------------------------------
// OVERVIEW — Owner/Country Dashboard cards (all client-aggregated from
// already country-scoped endpoint responses)
// ---------------------------------------------------------------------
function anRenderOverview() {
  const users = anFilterByCountry(anCache.users);
  const rooms = anFilterByCountry(anCache.rooms);
  const agencies = anFilterByCountry(anCache.agencies);
  const sellers = anFilterByCountry(anCache.sellers);
  const memberships = anFilterByCountry(anCache.memberships);
  const bans = anFilterByCountry(anCache.bans);

  const pendingByModule = anCache.approvals.map((m) => ({
    key: m.key, label: m.label,
    pending: m.requests.filter((r) => r.status === "pending" || r.status === "review").length
  }));
  const totalPendingApprovals = pendingByModule.reduce((s, m) => s + m.pending, 0);
  const rechargeMod = pendingByModule.find((m) => m.key === "recharge");
  const withdrawMod = pendingByModule.find((m) => m.key === "withdraw");

  const thisMonth = new Date().toISOString().slice(0, 7);
  const revThisMonth = anCache.revenueDays.filter((d) => d.date.startsWith(thisMonth));
  const revCoins = revThisMonth.reduce((s, d) => s + (d.recharge.coins || 0), 0);
  const revDiamonds = revThisMonth.reduce((s, d) => s + (d.diamondSales.diamonds || 0), 0);

  const activeBans = anCache.banSummary
    ? bans.filter((b) => b.status === "active" && (!b.expiryAt || new Date(b.expiryAt) > new Date())).length
    : 0;

  const cards = [
    { num: users.length, lbl: "Total Users" },
    { num: acPerm("dashboard:view") ? "—" : "—", lbl: "Online Users (see Live Monitoring below)" },
    { num: rooms.length, lbl: "Total Rooms" },
    { num: rooms.filter((r) => r.onlineCount > 0).length, lbl: "Active Rooms" },
    { num: agencies.length, lbl: "Agencies" },
    { num: sellers.filter((s) => s.status === "active").length, lbl: "Diamond Sellers (Active)" },
    { num: memberships.filter((m) => m.status === "active").length, lbl: "VIP Members (Active)" },
    { num: rechargeMod ? rechargeMod.pending : "—", lbl: "Recharge Requests (Pending)" },
    { num: withdrawMod ? withdrawMod.pending : "—", lbl: "Withdraw Requests (Pending)" },
    { num: totalPendingApprovals, lbl: "Pending Approvals (All Modules)" },
    { num: activeBans, lbl: "Active Bans" },
    { num: `${revCoins} coins / ${revDiamonds} 💎`, lbl: "Revenue Summary (this month)" }
  ];
  $("an-overview-grid").innerHTML = cards.map((c) => `
    <div class="ac-stat-card"><span class="ac-stat-num">${escapeHtml(String(c.num))}</span><span class="ac-stat-lbl">${escapeHtml(c.lbl)}</span></div>
  `).join("");
}

// ---------------------------------------------------------------------
// LIVE MONITORING — GET /api/admin/live, auto-refreshed every 30s while
// this section is open.
// ---------------------------------------------------------------------
async function anLoadLive() {
  if (!$("sec-analytics").classList.contains("active")) return;
  const r = await api("/api/admin/live");
  if (!r.success) return;
  const rooms = anFilterByCountry(anCache.rooms);
  const roomIds = new Set(rooms.map((x) => x.roomId));
  const scopedActive = r.activeRooms.filter((rm) => !anCountryFilterValue() || rooms.some((x) => x.roomName === rm.roomName));
  const usersInVoice = scopedActive.reduce((s, rm) => s + rm.onlineCount, 0);
  const activeHosts = new Set(scopedActive.map((rm) => rm.hostName)).size;

  const cards = [
    { num: anCountryFilterValue() ? usersInVoice : r.totalOnline, lbl: "Online Users" },
    { num: scopedActive.length, lbl: "Active Voice Rooms" },
    { num: usersInVoice, lbl: "Users in Voice" },
    { num: activeHosts, lbl: "Active Hosts" },
    { num: activeHosts, lbl: "Active Broadcasters" }
  ];
  $("an-live-grid").innerHTML = cards.map((c) => `
    <div class="ac-stat-card"><span class="ac-stat-num">${escapeHtml(String(c.num))}</span><span class="ac-stat-lbl">${escapeHtml(c.lbl)}</span></div>
  `).join("");
}

// ---------------------------------------------------------------------
// REVENUE — /api/admin/analytics/revenue, rolled up client-side into
// daily/weekly/monthly buckets per the range selector.
// ---------------------------------------------------------------------
function anBucketKey(dateStr, range) {
  if (range === "monthly") return dateStr.slice(0, 7);
  if (range === "weekly") {
    const d = new Date(dateStr);
    const day = (d.getUTCDay() + 6) % 7; // Monday=0
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
  }
  return dateStr;
}

function anRenderRevenue() {
  const range = $("an-f-range").value;
  $("an-rev-range-label").textContent = `(${range})`;
  const buckets = {};
  anCache.revenueDays.forEach((d) => {
    const key = anBucketKey(d.date, range);
    if (!buckets[key]) buckets[key] = { key, recharge: 0, withdraw: 0, diamondSales: 0, diamondCommission: 0 };
    buckets[key].recharge += d.recharge.coins || 0;
    buckets[key].withdraw += d.withdraw.diamonds || 0;
    buckets[key].diamondSales += d.diamondSales.diamonds || 0;
    buckets[key].diamondCommission += d.diamondCommission.coins || 0;
  });
  const rows = Object.values(buckets).sort((a, b) => a.key.localeCompare(b.key)).slice(-24);

  anRenderLineChart($("an-rev-line"), rows.map((r) => ({ label: r.key, value: r.recharge })), "#6EA8FE");
  anRenderGroupedBarChart($("an-rev-bar1"), rows, [
    { field: "recharge", label: "Recharge (coins)", color: "#4ADE80" },
    { field: "withdraw", label: "Withdraw (diamonds)", color: "#F7921E" }
  ]);
  anRenderGroupedBarChart($("an-rev-bar2"), rows, [
    { field: "diamondSales", label: "Diamond Sales", color: "#9D7BF7" },
    { field: "diamondCommission", label: "Commission (coins)", color: "#F7CE7E" }
  ]);
}

// ---------------------------------------------------------------------
// APPROVAL ANALYTICS — client-side status counts per module (reuses the
// exact requests already fetched for Overview's pendingByModule)
// ---------------------------------------------------------------------
function anRenderApprovals() {
  const rows = ANALYTICS_APPROVAL_MODULES.map((m) => {
    const found = anCache.approvals.find((a) => a.key === m.key);
    const reqs = found ? found.requests : [];
    return {
      label: m.label,
      pending: reqs.filter((r) => r.status === "pending").length,
      review: reqs.filter((r) => r.status === "review").length,
      approved: reqs.filter((r) => r.status === "approved").length,
      rejected: reqs.filter((r) => r.status === "rejected").length,
      reopened: reqs.filter((r) => !!r.reopenedBy).length
    };
  });
  $("an-appr-rows").innerHTML = rows.map((r) => `
    <tr><td>${escapeHtml(r.label)}</td><td>${r.pending}</td><td>${r.review}</td><td>${r.approved}</td><td>${r.rejected}</td><td>${r.reopened}</td></tr>
  `).join("");
  anRenderGroupedBarChart($("an-appr-bar"), rows.map((r) => ({ key: r.label, pending: r.pending, approved: r.approved, rejected: r.rejected })), [
    { field: "pending", label: "Pending", color: "#F7CE7E" },
    { field: "approved", label: "Approved", color: "#4ADE80" },
    { field: "rejected", label: "Rejected", color: "var(--red)" }
  ]);
}

// ---------------------------------------------------------------------
// BAN ANALYTICS — real ban types only (temporary/permanent/device/ip);
// see the <p class="hint"> in the HTML for why chat/voice/room aren't here.
// ---------------------------------------------------------------------
function anRenderBans() {
  const bans = anFilterByCountry(anCache.bans);
  const byType = { temporary: 0, permanent: 0, device: 0, ip: 0 };
  bans.forEach((b) => { if (byType[b.banType] !== undefined) byType[b.banType]++; });
  const appeals = { pending: 0, under_review: 0, restored: 0, rejected: 0 };
  bans.forEach((b) => { if (b.appealStatus && appeals[b.appealStatus] !== undefined) appeals[b.appealStatus]++; });

  const s = anCache.banSummary || { activeBans: 0, temporaryBans: 0, permanentBans: 0, deviceIpBans: 0, pendingAppeals: 0, restored: 0, rejectedAppeals: 0 };
  const cards = [
    { num: s.activeBans, lbl: "Active" }, { num: byType.temporary, lbl: "Temporary" },
    { num: byType.permanent, lbl: "Permanent" }, { num: byType.device, lbl: "Device" },
    { num: byType.ip, lbl: "IP" }, { num: s.pendingAppeals, lbl: "Appeals" },
    { num: s.restored, lbl: "Restored" }
  ];
  $("an-ban-grid").innerHTML = cards.map((c) => `
    <div class="ac-stat-card"><span class="ac-stat-num">${c.num}</span><span class="ac-stat-lbl">${escapeHtml(c.lbl)}</span></div>
  `).join("");

  anRenderPieChart($("an-ban-pie"), [
    { label: "Temporary", value: byType.temporary, color: "#F7CE7E" },
    { label: "Permanent", value: byType.permanent, color: "var(--red)" },
    { label: "Device", value: byType.device, color: "#6EA8FE" },
    { label: "IP", value: byType.ip, color: "#9D7BF7" }
  ]);
  anRenderPieChart($("an-ban-appeal-pie"), [
    { label: "Pending", value: appeals.pending, color: "#F7CE7E" },
    { label: "Under Review", value: appeals.under_review, color: "#6EA8FE" },
    { label: "Restored", value: appeals.restored, color: "#4ADE80" },
    { label: "Rejected", value: appeals.rejected, color: "var(--red)" }
  ]);
}

// ---------------------------------------------------------------------
// USER ANALYTICS — VIP tier + Diamond Seller status distribution only
// (real, stored data). New Registrations/DAU/MAU intentionally omitted.
// ---------------------------------------------------------------------
function anRenderUsers() {
  const memberships = anFilterByCountry(anCache.memberships).filter((m) => m.status === "active");
  const tierColors = { VIP_SILVER: "#9AA0A6", VIP_GOLD: "#F7CE7E", VIP_PLATINUM: "#6EA8FE", VIP_DIAMOND: "#9D7BF7", VIP_ROYAL: "var(--red)" };
  const byTier = {};
  memberships.forEach((m) => { byTier[m.tier] = (byTier[m.tier] || 0) + 1; });
  anRenderPieChart($("an-user-vip-pie"), Object.entries(byTier).map(([tier, n]) => ({ label: tier, value: n, color: tierColors[tier] || "#9AA0A6" })));

  const sellers = anFilterByCountry(anCache.sellers);
  const byStatus = {};
  sellers.forEach((s) => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });
  const statusColors = { active: "#4ADE80", suspended: "#F7921E", pending: "#F7CE7E" };
  anRenderPieChart($("an-user-dseller-pie"), Object.entries(byStatus).map(([st, n]) => ({ label: st, value: n, color: statusColors[st] || "#9AA0A6" })));
}

// ---------------------------------------------------------------------
// ROOM ANALYTICS — Total/Active/Locked (real) + Popular-Now list (real
// current onlineCount, not a historical/fabricated popularity score).
// ---------------------------------------------------------------------
function anRenderRooms() {
  const rooms = anFilterByCountry(anCache.rooms);
  const cards = [
    { num: rooms.length, lbl: "Total Rooms" },
    { num: rooms.filter((r) => r.onlineCount > 0).length, lbl: "Active Rooms" },
    { num: rooms.filter((r) => r.roomLocked).length, lbl: "Locked Rooms" },
    { num: rooms.filter((r) => !r.roomLocked).length, lbl: "Unlocked Rooms" }
  ];
  $("an-room-grid").innerHTML = cards.map((c) => `
    <div class="ac-stat-card"><span class="ac-stat-num">${c.num}</span><span class="ac-stat-lbl">${escapeHtml(c.lbl)}</span></div>
  `).join("");

  const popular = rooms.slice().sort((a, b) => b.onlineCount - a.onlineCount).slice(0, 10);
  $("an-room-rows").innerHTML = popular.map((r) => `
    <tr><td>${escapeHtml(r.roomName)}</td><td>${escapeHtml(r.hostName)}</td><td>${r.onlineCount}</td><td>${r.roomLocked ? "🔒" : "—"}</td></tr>
  `).join("") || `<tr><td colspan="4" class="hint">No rooms.</td></tr>`;
}

// ---------------------------------------------------------------------
// LIGHTWEIGHT SVG CHARTS — no external chart library dependency.
// ---------------------------------------------------------------------
function anRenderLineChart(el, points, color) {
  if (!points.length) { el.innerHTML = `<div class="hint">No data.</div>`; return; }
  const w = Math.max(360, points.length * 46), h = 180, pad = 24;
  const max = Math.max(1, ...points.map((p) => p.value));
  const stepX = (w - pad * 2) / Math.max(1, points.length - 1);
  const coords = points.map((p, i) => [pad + i * stepX, h - pad - (p.value / max) * (h - pad * 2)]);
  const path = coords.map((c, i) => (i === 0 ? "M" : "L") + c[0].toFixed(1) + "," + c[1].toFixed(1)).join(" ");
  const dots = coords.map((c, i) => `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="3" fill="${color}"><title>${escapeHtml(points[i].label)}: ${points[i].value}</title></circle>`).join("");
  const labels = points.map((p, i) => i % Math.ceil(points.length / 8 || 1) === 0 ? `<text x="${coords[i][0].toFixed(1)}" y="${h - 4}" font-size="9" fill="var(--text-dim)" text-anchor="middle">${escapeHtml(p.label.slice(5))}</text>` : "").join("");
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>${dots}${labels}</svg>`;
}

function anRenderGroupedBarChart(el, rows, seriesDef) {
  if (!rows.length) { el.innerHTML = `<div class="hint">No data.</div>`; return; }
  const w = Math.max(360, rows.length * 60), h = 180, pad = 24;
  const max = Math.max(1, ...rows.flatMap((r) => seriesDef.map((s) => r[s.field] || 0)));
  const groupW = (w - pad * 2) / rows.length;
  const barW = groupW / (seriesDef.length + 1);
  let bars = "";
  rows.forEach((r, i) => {
    seriesDef.forEach((s, j) => {
      const val = r[s.field] || 0;
      const bh = (val / max) * (h - pad * 2);
      const x = pad + i * groupW + j * barW + barW * 0.5;
      const y = h - pad - bh;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.85).toFixed(1)}" height="${bh.toFixed(1)}" fill="${s.color}"><title>${escapeHtml(s.label)} — ${escapeHtml(r.key)}: ${val}</title></rect>`;
    });
  });
  const labels = rows.map((r, i) => `<text x="${(pad + i * groupW + groupW / 2).toFixed(1)}" y="${h - 4}" font-size="9" fill="var(--text-dim)" text-anchor="middle">${escapeHtml(String(r.key).slice(5))}</text>`).join("");
  const legend = seriesDef.map((s) => `<span><i style="background:${s.color}"></i>${escapeHtml(s.label)}</span>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${bars}${labels}</svg><div class="an-legend">${legend}</div>`;
}

function anRenderPieChart(el, slices) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (!total) { el.innerHTML = `<div class="hint">No data.</div>`; return; }
  const r = 60, cx = 70, cy = 70, circumference = 2 * Math.PI * r;
  let offset = 0;
  const circles = slices.filter((s) => s.value > 0).map((s) => {
    const frac = s.value / total;
    const len = frac * circumference;
    const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="28" stroke-dasharray="${len.toFixed(1)} ${(circumference - len).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}"><title>${escapeHtml(s.label)}: ${s.value} (${Math.round(frac * 100)}%)</title></circle>`;
    offset += len;
    return circle;
  }).join("");
  const legend = slices.filter((s) => s.value > 0).map((s) => `<span><i style="background:${s.color}"></i>${escapeHtml(s.label)}: ${s.value}</span>`).join("");
  el.innerHTML = `<svg viewBox="0 0 140 140" width="140" height="140">${circles}</svg><div class="an-legend">${legend}</div>`;
}

// ---------------------------------------------------------------------
// EXPORT (Owner only — gated client-side above; underlying API calls are
// still permission-checked server-side same as everywhere else)
// ---------------------------------------------------------------------
function anCsvFromRows(headers, rows) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}
$("an-btn-export-csv").addEventListener("click", () => {
  const rows = anCache.revenueDays.map((d) => [d.date, d.recharge.coins, d.withdraw.diamonds, d.diamondSales.diamonds, d.diamondCommission.coins]);
  const csv = anCsvFromRows(["Date", "Recharge (coins)", "Withdraw (diamonds)", "Diamond Sales (diamonds)", "Diamond Commission (coins)"], rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `revenue-analytics-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  toast("CSV downloaded (also opens in Excel)");
});
$("an-btn-export-pdf").addEventListener("click", () => {
  toast("Choose \"Save as PDF\" from the Print dialog");
  window.print();
});

// ===========================================================================
// CALL HOSTING (additive — see callHosting.js). Same api()/$()/toast()
// helpers as every other section above; does not touch any existing
// section's functions or DOM ids.
// ===========================================================================
let chCurrentTab = "hosts";

function chEnterSection() {
  document.querySelectorAll(".ch-tab").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".ch-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      chCurrentTab = btn.getAttribute("data-ch-tab");
      document.querySelectorAll(".ch-panel").forEach((p) => (p.style.display = "none"));
      $("ch-panel-" + chCurrentTab).style.display = "";
      chLoadTab(chCurrentTab);
    };
  });
  chLoadTab(chCurrentTab);
}

function chLoadTab(tab) {
  if (tab === "hosts") chLoadHosts();
  if (tab === "active-calls") chLoadActiveCalls();
  if (tab === "history") chLoadHistory();
  if (tab === "reports") chLoadReports();
  if (tab === "revenue") chLoadRevenue();
  if (tab === "rates") chLoadRates();
}

function chStatusBadge(status) {
  const colors = { pending: "#f0ad4e", approved: "#5cb85c", suspended: "#f0ad4e", disabled: "#999", removed: "#d9534f", rejected: "#d9534f" };
  return `<span style="color:${colors[status] || '#999'};font-weight:600;">${status}</span>`;
}

async function chLoadHosts() {
  const status = $("ch-hosts-filter").value;
  const search = $("ch-hosts-search").value.trim();
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(search ? { search } : {}) }).toString();
  const r = await api("/api/admin/call-hosting/hosts?" + qs);
  const list = $("ch-hosts-list");
  if (!r.success) { list.innerHTML = "<p class='hint'>Failed to load hosts.</p>"; return; }
  if (!r.hosts.length) { list.innerHTML = "<p class='hint'>No hosts yet.</p>"; return; }
  list.innerHTML = r.hosts.map((h) => `
    <div class="panel" style="display:flex;justify-content:space-between;align-items:center;">
      <div><strong>${h.user.userName}</strong> (${h.userId}) — ${chStatusBadge(h.status)}</div>
      <div class="hint">Country: ${h.countryId || "-"}</div>
    </div>
  `).join("");
}

$("ch-hosts-filter").addEventListener("change", chLoadHosts);
$("ch-hosts-search").addEventListener("input", () => { clearTimeout(window._chSearchDebounce); window._chSearchDebounce = setTimeout(chLoadHosts, 300); });

async function chHostAction(action) {
  const userId = $("ch-host-userid").value.trim();
  if (!userId) { toast("Enter a User ID", true); return; }
  const r = await api(`/api/admin/call-hosting/hosts/${encodeURIComponent(userId)}/${action}`, "POST", {});
  if (r.success) { toast(`Host ${action}d`); chLoadHosts(); }
  else toast(r.error || "Failed", true);
}
$("ch-btn-approve").addEventListener("click", () => chHostAction("approve"));
$("ch-btn-reject").addEventListener("click", () => chHostAction("reject"));
$("ch-btn-suspend").addEventListener("click", () => chHostAction("suspend"));
$("ch-btn-disable").addEventListener("click", () => chHostAction("disable"));
$("ch-btn-remove").addEventListener("click", () => {
  if (!confirm("Remove this host? This cannot be undone from here.")) return;
  chHostAction("remove");
});

async function chLoadActiveCalls() {
  const r = await api("/api/admin/call-hosting/active-calls");
  const list = $("ch-active-calls-list");
  if (!r.success || !r.activeCalls.length) { list.innerHTML = "<p class='hint'>No active calls right now.</p>"; return; }
  list.innerHTML = r.activeCalls.map((c) => `
    <div class="panel">
      <strong>${c.callType}</strong> — ${c.callerId} → ${c.hostId} — ${c.status}<br>
      <span class="hint">Elapsed: ${c.elapsedSec}s · Coins charged: ${c.coinsCharged}</span>
    </div>
  `).join("");
}

async function chLoadHistory() {
  const hostId = $("ch-history-host").value.trim();
  const callerId = $("ch-history-caller").value.trim();
  const qs = new URLSearchParams({ ...(hostId ? { hostId } : {}), ...(callerId ? { callerId } : {}) }).toString();
  const r = await api("/api/admin/call-hosting/history?" + qs);
  const list = $("ch-history-list");
  if (!r.success || !r.calls.length) { list.innerHTML = "<p class='hint'>No call history found.</p>"; return; }
  list.innerHTML = r.calls.map((c) => `
    <div class="panel">
      <strong>${c.callType}</strong> — ${c.callerId} → ${c.hostId} — ${c.status}<br>
      <span class="hint">${new Date(c.startTime).toLocaleString()} · ${c.durationSec}s · ${c.coinsCharged} coins</span>
    </div>
  `).join("");
}
$("ch-btn-history-filter").addEventListener("click", chLoadHistory);

async function chLoadReports() {
  const r = await api("/api/admin/call-hosting/reports");
  const list = $("ch-reports-list");
  if (!r.success || !r.reports.length) { list.innerHTML = "<p class='hint'>No hosts to report on.</p>"; return; }
  list.innerHTML = r.reports.map((rep) => `
    <div class="panel">
      <strong>${rep.user.userName}</strong> (${rep.userId}) — ${chStatusBadge(rep.status)} — ${rep.onlineStatus ? "🟢 Online" : "⚫ Offline"}<br>
      <span class="hint">
        Calls: ${rep.totalCalls} · Minutes: ${rep.totalMinutes} · Callers: ${rep.callerCount} · Avg call: ${rep.avgCallDurationSec}s<br>
        Coins — Today: ${rep.dailyCoins} · This week: ${rep.weeklyCoins} · This month: ${rep.monthlyCoins}<br>
        Last call: ${rep.lastCall ? new Date(rep.lastCall).toLocaleString() : "—"}
        ${rep.target ? `<br>Target: ${rep.target.progressCoins}/${rep.target.targetCoins} coins (${rep.target.progressPct}%, ${rep.target.remaining} remaining)` : ""}
      </span>
    </div>
  `).join("");
}

async function chLoadRevenue() {
  const r = await api("/api/admin/call-hosting/revenue");
  if (!r.success) return;
  $("ch-revenue-total").textContent = r.total || 0;
  const byday = $("ch-revenue-byday");
  const days = Object.keys(r.byDay || {}).sort().reverse();
  byday.innerHTML = days.length
    ? days.map((d) => `<div class="panel" style="display:flex;justify-content:space-between;"><span>${d}</span><span>${r.byDay[d]} coins</span></div>`).join("")
    : "<p class='hint'>No revenue recorded yet.</p>";
}

async function chLoadRates() {
  const r = await api("/api/admin/call-hosting/rates");
  if (!r.success) return;
  $("ch-rate-coins").value = r.rates.coinsPerMinute;
  $("ch-rate-minbal").value = r.rates.minBalance;
  $("ch-rate-maxdur").value = r.rates.maxCallDurationSec;
  $("ch-rate-maxdaily").value = r.rates.maxDailyMinutes ?? "";
  $("ch-rate-enabled").checked = !!r.rates.enabled;
}

$("ch-btn-save-rates").addEventListener("click", async () => {
  const body = {
    coinsPerMinute: Number($("ch-rate-coins").value),
    minBalance: Number($("ch-rate-minbal").value),
    maxCallDurationSec: Number($("ch-rate-maxdur").value),
    maxDailyMinutes: $("ch-rate-maxdaily").value === "" ? null : Number($("ch-rate-maxdaily").value),
    enabled: $("ch-rate-enabled").checked
  };
  const r = await api("/api/admin/call-hosting/rates", "PUT", body);
  if (r.success) toast("Call rates saved"); else toast("Failed to save rates", true);
});

$("ch-btn-set-target").addEventListener("click", async () => {
  const userId = $("ch-target-userid").value.trim();
  const targetCoins = Number($("ch-target-coins").value);
  const periodDays = Number($("ch-target-days").value) || 7;
  if (!userId || !Number.isFinite(targetCoins)) { toast("Enter host User ID and target coins", true); return; }
  const r = await api(`/api/admin/call-hosting/targets/${encodeURIComponent(userId)}`, "PUT", { targetCoins, periodDays });
  if (r.success) toast("Target set"); else toast(r.error || "Failed", true);
});

// ===========================================================================
// VOICE SFU DASHBOARD (Phase 3, Step 3.6 — read-only, no new admin API)
// ===========================================================================
// Reuses the EXISTING GET /api/admin/voice-sfu/health (Step 3.2) and
// GET /api/admin/voice-sfu/readiness (Step 3.5) routes — see
// voice_sfu/index.js. No new endpoint is added for this panel. Rendering
// follows this admin panel's existing stat-card/data-list conventions
// (see the Approval Center / Dashboard & Analytics sections for the same
// pattern) rather than introducing a new UI style.
let vsfuAutoTimer = null;

function vsfuEnterSection() {
  vsfuRefresh();
  $("vsfu-btn-refresh").onclick = vsfuRefresh;
  $("vsfu-auto-refresh").onchange = () => {
    if (vsfuAutoTimer) { clearInterval(vsfuAutoTimer); vsfuAutoTimer = null; }
    if ($("vsfu-auto-refresh").checked) vsfuAutoTimer = setInterval(vsfuRefresh, 10000);
  };
}

async function vsfuRefresh() {
  const [healthRes, readinessRes] = await Promise.all([
    api("/api/admin/voice-sfu/health"),
    api("/api/admin/voice-sfu/readiness")
  ]);
  $("vsfu-last-updated").textContent = "Updated " + new Date().toLocaleTimeString();

  // ---- Readiness ----
  if (readinessRes && readinessRes.success) {
    const r = readinessRes.readiness;
    const badge = r.ready
      ? '<span class="tag-preview-badge" style="background:rgba(74,222,128,0.15);color:#4ADE80;">READY</span>'
      : '<span class="tag-preview-badge" style="background:rgba(239,68,68,0.15);color:var(--red);">NOT READY</span>';
    let html = `<div style="margin-bottom:8px;">${badge} <span class="hint">mode: ${escapeHtml(r.voiceMode || "mesh")}</span></div>`;
    if (Array.isArray(r.errors) && r.errors.length) {
      html += `<div style="color:var(--red);font-size:12.5px;margin-bottom:6px;">${r.errors.map((e) => "⚠ " + escapeHtml(e)).join("<br>")}</div>`;
    }
    if (Array.isArray(r.warnings) && r.warnings.length) {
      html += `<div style="color:#F7CE7E;font-size:12.5px;">${r.warnings.map((w) => "• " + escapeHtml(w)).join("<br>")}</div>`;
    }
    if (!r.errors?.length && !r.warnings?.length) html += '<div class="hint">No readiness warnings.</div>';
    $("vsfu-readiness").innerHTML = html;
  } else {
    $("vsfu-readiness").innerHTML = '<div class="hint">Could not load readiness (is the server running Step 3.5+?).</div>';
  }

  if (!healthRes || !healthRes.success) {
    $("vsfu-rollout").innerHTML = '<div class="hint">Could not load health/rollout data.</div>';
    $("vsfu-health-summary").innerHTML = "";
    $("vsfu-latency").innerHTML = "";
    return;
  }
  const h = healthRes.health;

  // ---- Rollout ----
  let rolloutHtml = `<div><span class="hint">Base mode:</span> <b>${escapeHtml(h.voiceMode || "mesh")}</b></div>`;
  if (h.voiceMode === "staged" && h.rolloutConfig) {
    const rc = h.rolloutConfig;
    rolloutHtml += `<div style="margin-top:6px;">
      <div><span class="hint">Rollout %:</span> <b>${rc.percent ?? 0}%</b></div>
      <div><span class="hint">Allowlisted rooms:</span> ${rc.allowlistRoomCount ?? (rc.allowlistRooms || []).length ?? 0}</div>
      <div><span class="hint">Allowlisted hosts:</span> ${rc.allowlistHostCount ?? (rc.allowlistHosts || []).length ?? 0}</div>
    </div>`;
  } else {
    rolloutHtml += `<div class="hint" style="margin-top:6px;">Staged rollout is off — every room is ${escapeHtml(h.voiceMode || "mesh")}.</div>`;
  }
  $("vsfu-rollout").innerHTML = rolloutHtml;

  // ---- SFU Health stat cards ----
  const s = h.sfu || {};
  const cards = [
    { num: s.activePublishers ?? 0, lbl: "Active Publishers" },
    { num: s.activeSubscribers ?? 0, lbl: "Active Subscribers" },
    { num: s.joinCount ?? 0, lbl: "Total Joins" },
    { num: s.leaveCount ?? 0, lbl: "Total Leaves" },
    { num: s.tokenFailureCount ?? 0, lbl: "Token Failures" },
    { num: s.errorCount ?? 0, lbl: "Errors" },
    { num: s.cleanupCount ?? 0, lbl: "Rooms Cleaned Up" },
    { num: s.reconnectEventCount ?? 0, lbl: "Reconnect Events" }
  ];
  $("vsfu-health-summary").innerHTML = cards.map((c) =>
    `<div class="stat-card${c.lbl === "Token Failures" && c.num > 0 ? " warn" : ""}"><div class="stat-num">${c.num}</div><div class="stat-lbl">${escapeHtml(c.lbl)}</div></div>`
  ).join("");

  // ---- Latency ----
  const lat = s.latencyMs || {};
  const latCards = [
    { num: lat.token?.avg ?? "—", lbl: "Token Mint" },
    { num: lat.join?.avg ?? "—", lbl: "Full Join Request" },
    { num: lat.permissionUpdate?.avg ?? "—", lbl: "Permission Update" },
    { num: lat.cleanup?.avg ?? "—", lbl: "Room Cleanup" },
    { num: lat.reconnect?.avg ?? "—", lbl: "Reconnect Tag" },
    { num: s.liveKitApiLatencyMs?.avg ?? "—", lbl: "LiveKit API (overall)" }
  ];
  $("vsfu-latency").innerHTML = latCards.map((c) =>
    `<div class="stat-card"><div class="stat-num">${c.num}</div><div class="stat-lbl">${escapeHtml(c.lbl)}</div></div>`
  ).join("");

  // ---- Active local rooms ----
  const rooms = s.activeLocalRooms || [];
  $("vsfu-rooms-list").innerHTML = rooms.length
    ? rooms.map((r) => `<div class="data-row"><span>${escapeHtml(r.roomName)}</span><span class="hint">${r.localParticipantCount} connected · ${r.localPublisherCount} publishing</span></div>`).join("")
    : '<div class="hint">No SFU-active rooms on this instance right now.</div>';

  // ---- Recent events ----
  const events = (s.recentEvents || []).slice().reverse();
  $("vsfu-events-list").innerHTML = events.length
    ? events.map((e) => {
        const color = e.type === "error" ? "var(--red)" : e.type === "cleanup" ? "#F7CE7E" : "var(--text-dim)";
        return `<div class="data-row"><span style="color:${color};">[${escapeHtml(e.type)}]</span> <span class="hint">${escapeHtml(new Date(e.t).toLocaleTimeString())}</span> ${e.roomId ? "room:" + escapeHtml(e.roomId) + " " : ""}${e.userId ? "user:" + escapeHtml(e.userId) + " " : ""}${e.message ? escapeHtml(e.message) : ""}</div>`;
      }).join("")
    : '<div class="hint">No recent events.</div>';
}
