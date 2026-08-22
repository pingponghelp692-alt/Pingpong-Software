// PingPong Friendship + CP relationship system
// Additive feature: persisted pair relationships, coin-priced requests,
// private-message accept/decline cards, and room-seat relationship effects.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { areAdjacentSeats } = require('./seatAdjacency.js');

// Default visual config for one relationship type (CP or Friendship).
// Nothing here is hardcoded CSS — this whole object is what the Admin
// Panel edits, persisted to disk, and pushed to clients as CSS variables.
function defaultVisual(kind) {
  return {
    width: kind === 'cp' ? 126 : 104,
    height: kind === 'cp' ? 126 : 104,
    scale: 1,
    opacity: kind === 'cp' ? 0.98 : 0.98,
    animationEnabled: true,
    animationSpeedSec: kind === 'cp' ? 2.1 : 2.7,
    offsetX: 0,
    offsetY: 0,
    customAssetEnabled: false,
    customAssetPath: null // set when an admin uploads a PNG; null = use the default bundled asset
  };
}

function initFriendshipCp({
  app, DATA_FOLDER, safeRead, safeWrite,
  findUserByUserId, saveUsers, clampCoinBalance, logTransaction,
  users, userAuth, io,
  pushWalletUpdate, emitToUser, privateMessages, saveMessages, conversationKey,
  getRooms,
  // Admin Panel additions (2026-08-11) — all optional so this module keeps
  // working even if a caller doesn't wire admin/upload support.
  requireAdmin, requirePermission, uploadRelationshipAsset, RELATIONSHIP_ASSET_FOLDER,
  rbac, reqUserAgent
}) {
  const DATA_FILE = require('path').join(DATA_FOLDER, 'friendship_cp.json');
  const CONFIG_FILE = require('path').join(DATA_FOLDER, 'relationship_visual_config.json');
  const FRIENDSHIP_COST = Math.max(1, Number(process.env.FRIENDSHIP_COST_COINS) || 100000);
  const CP_COST = Math.max(1, Number(process.env.CP_COST_COINS) || 500000);
  const REQUEST_TTL_MS = Math.max(60 * 1000, Number(process.env.RELATIONSHIP_REQUEST_TTL_MS) || 10 * 60 * 1000);

  let state = safeRead(DATA_FILE, { relationships: {}, requests: {} });
  if (!state || typeof state !== 'object') { state = { relationships: {}, requests: {} }; }
  if (!state.relationships || typeof state.relationships !== 'object') state.relationships = {};
  if (!state.requests || typeof state.requests !== 'object') state.requests = {};

  // ---------- Visual configuration (Admin Panel controlled, persisted) ----------
  // SOURCE OF TRUTH for CP/Friendship size/opacity/animation/position/asset.
  // Not CSS — CSS only reads these values via CSS variables set by the client
  // from the config this module serves. version increments on every save and
  // is used purely for cache-busting uploaded PNGs (?v=version).
  let visualConfig = safeRead(CONFIG_FILE, null);
  if (!visualConfig || typeof visualConfig !== 'object') {
    visualConfig = { version: 1, cp: defaultVisual('cp'), friendship: defaultVisual('friendship') };
  }
  if (!visualConfig.cp || typeof visualConfig.cp !== 'object') visualConfig.cp = defaultVisual('cp');
  if (!visualConfig.friendship || typeof visualConfig.friendship !== 'object') visualConfig.friendship = defaultVisual('friendship');
  if (!Number.isInteger(visualConfig.version)) visualConfig.version = 1;
  // Backfill any fields missing from an older saved config (safe merge, never
  // drops an admin's existing saved values).
  visualConfig.cp = { ...defaultVisual('cp'), ...visualConfig.cp };
  visualConfig.friendship = { ...defaultVisual('friendship'), ...visualConfig.friendship };

  function saveVisualConfig() { safeWrite(CONFIG_FILE, visualConfig); }

  function publicVisualConfig() {
    // What the client (room UI) receives. Resolves customAssetPath into a
    // real, cache-busted URL; never leaks filesystem paths.
    const resolve = (kind, cfg) => ({
      width: cfg.width, height: cfg.height, scale: cfg.scale, opacity: cfg.opacity,
      animationEnabled: cfg.animationEnabled, animationSpeedSec: cfg.animationSpeedSec,
      offsetX: cfg.offsetX, offsetY: cfg.offsetY,
      assetUrl: (cfg.customAssetEnabled && cfg.customAssetPath
        ? '/relationship-assets/' + cfg.customAssetPath
        : '/images/relationships/' + (kind === 'cp' ? 'cp-heart.png' : 'friendship-heart.png')) + '?v=' + visualConfig.version
    });
    return { version: visualConfig.version, cp: resolve('cp', visualConfig.cp), friendship: resolve('friendship', visualConfig.friendship) };
  }

  function broadcastVisualConfig() {
    io.emit('relationship-config-update', publicVisualConfig());
  }

  function save() { safeWrite(DATA_FILE, state); }
  function pairKey(a, b) { return [String(a), String(b)].sort().join('::'); }
  function makeRequestId() { return 'rel_' + Date.now().toString(36) + '_' + crypto.randomBytes(5).toString('hex'); }
  function typeLabel(type) { return type === 'cp' ? 'CP' : 'Friendship'; }
  function costFor(type) { return type === 'cp' ? CP_COST : FRIENDSHIP_COST; }

  function expireRequests() {
    const now = Date.now();
    let changed = false;
    Object.values(state.requests).forEach((r) => {
      if (r.status === 'pending' && r.expiresAt <= now) {
        r.status = 'expired';
        r.updatedAt = new Date().toISOString();
        const key = conversationKey(r.fromUserId, r.toUserId);
        (privateMessages[key] || []).forEach((m) => {
          if (m.type === 'relationship_request' && m.data && m.data.requestId === r.requestId) m.data.status = 'expired';
        });
        changed = true;
      }
    });
    if (changed) { save(); saveMessages(); }
  }

  function getRelationship(a, b) {
    if (!a || !b || a === b) return null;
    const r = state.relationships[pairKey(a, b)];
    return r && r.status === 'accepted' ? { ...r } : null;
  }

  // Ranking integration: expose accepted CP relationships as read-only public
  // data. The ranking service never mutates relationship state.
  function getAcceptedRelationships(type) {
    const wanted = type || null;
    return Object.values(state.relationships)
      .filter((r) => r && r.status === 'accepted' && (!wanted || r.type === wanted))
      .map((r) => ({ ...r }));
  }

  function getPendingBetween(a, b) {
    expireRequests();
    return Object.values(state.requests)
      .filter((r) => r.status === 'pending' && ((r.fromUserId === a && r.toUserId === b) || (r.fromUserId === b && r.toUserId === a)))
      .sort((x, y) => y.createdAt - x.createdAt)[0] || null;
  }

  function publicStatus(viewerId, targetId) {
    const relationship = getRelationship(viewerId, targetId);
    const pending = getPendingBetween(viewerId, targetId);
    return {
      relationship,
      pending: pending ? {
        requestId: pending.requestId,
        type: pending.type,
        cost: pending.cost,
        fromUserId: pending.fromUserId,
        toUserId: pending.toUserId,
        status: pending.status,
        createdAt: pending.createdAt,
        expiresAt: pending.expiresAt
      } : null,
      friendshipCost: FRIENDSHIP_COST,
      cpCost: CP_COST,
      requestTtlMs: REQUEST_TTL_MS
    };
  }

  function addPrivateRelationshipMessage({ fromUserId, toUserId, request, status }) {
    const key = conversationKey(fromUserId, toUserId);
    if (!privateMessages[key]) privateMessages[key] = [];
    const typeName = typeLabel(request.type);
    const text = status === 'pending'
      ? `💞 ${typeName} request from ${findUserByUserId(fromUserId)?.user?.name || 'User'} — ${request.cost.toLocaleString()} Coins`
      : status === 'accepted'
        ? `✅ ${typeName} request accepted`
        : status === 'rejected'
          ? `❌ ${typeName} request declined`
          : `⌛ ${typeName} request expired`;
    const msg = {
      from: fromUserId,
      to: toUserId,
      message: text,
      time: new Date().toISOString(),
      type: 'relationship_request',
      data: {
        requestId: request.requestId,
        relationshipType: request.type,
        status,
        cost: request.cost,
        expiresAt: request.expiresAt
      }
    };
    privateMessages[key].push(msg);
    saveMessages();
    emitToUser(toUserId, 'new-private-message', msg);
    return msg;
  }

  function updatePrivateRequestCards(request, status) {
    const key = conversationKey(request.fromUserId, request.toUserId);
    const msgs = privateMessages[key] || [];
    msgs.forEach((m) => {
      if (m.type === 'relationship_request' && m.data && m.data.requestId === request.requestId) {
        m.data.status = status;
      }
    });
    saveMessages();
  }

  function broadcastRoomRelationshipUpdate(userIds) {
    const wanted = new Set(userIds || []);
    const rooms = typeof getRooms === 'function' ? getRooms() : {};
    Object.values(rooms || {}).forEach((room) => {
      const seatedIds = (room.seats || []).filter(Boolean).map((s) => s.userId);
      if (!seatedIds.some((id) => wanted.has(id))) return;
      emitToRoomRelationshipState(room);
    });
  }

  function getSeatRelationshipLinks(room) {
    if (!room || !Array.isArray(room.seats)) return [];
    const seated = room.seats.map((s, i) => s ? { seatNumber: i + 1, userId: s.userId, userName: s.userName } : null);
    const links = [];
    for (let i = 0; i < seated.length; i++) {
      if (!seated[i]) continue;
      for (let j = i + 1; j < seated.length; j++) {
        if (!seated[j]) continue;
        // ROOT-CAUSE FIX (2026-08-11, "far away heart" bug): a relationship
        // link is only ever a valid ROOM VISUAL when the two users are
        // CURRENTLY seated in physically adjacent seats. Relationship
        // existence (state.relationships) stays persistent in the backend
        // regardless — this check only gates the presentation-layer link
        // this function returns, per the required behavior. See
        // seatAdjacency.js for why this is a real grid-topology check and
        // not Math.abs(a-b)===1.
        if (!areAdjacentSeats(seated[i].seatNumber, seated[j].seatNumber)) continue;
        const r = getRelationship(seated[i].userId, seated[j].userId);
        if (!r) continue;
        links.push({
          type: r.type,
          seatA: seated[i].seatNumber,
          seatB: seated[j].seatNumber,
          userA: seated[i].userId,
          userB: seated[j].userId,
          userAName: seated[i].userName,
          userBName: seated[j].userName
        });
      }
    }
    // CP wins visually if bad/old data ever contains both relationship types.
    const seenPair = new Set();
    return links.filter((link) => {
      const k = pairKey(link.userA, link.userB);
      if (seenPair.has(k)) return false;
      seenPair.add(k);
      return true;
    });
  }

  function emitToRoomRelationshipState(room) {
    if (!room || !room.roomId) return;
    const links = getSeatRelationshipLinks(room);
    const rooms = typeof getRooms === 'function' ? getRooms() : {};
    const liveRoom = rooms && rooms[room.roomId];
    if (liveRoom) liveRoom.relationshipLinks = links;
    io.to(room.roomId).emit('room-relationship-update', { roomId: room.roomId, links });
  }

  async function sendRequest(actorId, targetId, type) {
    expireRequests();
    if (!actorId || !targetId || actorId === targetId) return { success: false, message: 'You cannot create a relationship with yourself' };
    if (!['friendship', 'cp'].includes(type)) return { success: false, message: 'Invalid relationship type' };
    const sender = findUserByUserId(actorId);
    const target = findUserByUserId(targetId);
    if (!sender || !target) return { success: false, message: 'User not found' };

    const existing = getRelationship(actorId, targetId);
    if (existing) return { success: false, message: `An active ${typeLabel(existing.type)} already exists` };
    const pending = getPendingBetween(actorId, targetId);
    if (pending) return { success: false, message: `A ${typeLabel(pending.type)} request is already pending` };

    const cost = costFor(type);
    if ((sender.user.coins || 0) < cost) return { success: false, message: `Not enough Coins. ${typeLabel(type)} needs ${cost.toLocaleString()} Coins.` };

    sender.user.coins = clampCoinBalance(actorId, sender.user.coins - cost, `relationship-${type}-send`);
    logTransaction(actorId, 'coins', -cost, `${typeLabel(type)} request sent to ${target.user.name}`);
    saveUsers();
    pushWalletUpdate(actorId);

    const now = Date.now();
    const request = {
      requestId: makeRequestId(),
      type,
      fromUserId: actorId,
      toUserId: targetId,
      cost,
      status: 'pending',
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      updatedAt: new Date(now).toISOString()
    };
    state.requests[request.requestId] = request;
    save();
    const msg = addPrivateRelationshipMessage({ fromUserId: actorId, toUserId: targetId, request, status: 'pending' });
    emitToUser(actorId, 'relationship-request-sent', { requestId: request.requestId, type, targetUserId: targetId, cost, expiresAt: request.expiresAt });
    return { success: true, request, message: msg, status: publicStatus(actorId, targetId) };
  }

  async function respondRequest(actorId, requestId, action) {
    expireRequests();
    const request = state.requests[requestId];
    if (!request) return { success: false, message: 'Relationship request not found' };
    if (request.toUserId !== actorId) return { success: false, message: 'You cannot respond to this request' };
    if (request.status !== 'pending') return { success: false, message: `Request is already ${request.status}` };
    if (request.expiresAt <= Date.now()) { request.status = 'expired'; request.updatedAt = new Date().toISOString(); save(); return { success: false, message: 'This request has expired' }; }
    if (!['accept', 'reject'].includes(action)) return { success: false, message: 'Invalid response' };

    if (action === 'reject') {
      request.status = 'rejected';
      request.updatedAt = new Date().toISOString();
      save();
      updatePrivateRequestCards(request, 'rejected');
      const msg = addPrivateRelationshipMessage({ fromUserId: actorId, toUserId: request.fromUserId, request, status: 'rejected' });
      emitToUser(request.fromUserId, 'relationship-update', { relationship: null, request: { ...request } });
      return { success: true, status: 'rejected', message: msg };
    }

    const existing = getRelationship(request.fromUserId, request.toUserId);
    if (existing) return { success: false, message: `An active ${typeLabel(existing.type)} already exists` };
    const relation = {
      relationshipId: 'rel_' + crypto.randomBytes(8).toString('hex'),
      type: request.type,
      userA: request.fromUserId,
      userB: request.toUserId,
      status: 'accepted',
      createdAt: request.createdAt,
      acceptedAt: Date.now()
    };
    state.relationships[pairKey(request.fromUserId, request.toUserId)] = relation;
    request.status = 'accepted';
    request.updatedAt = new Date().toISOString();
    save();
    updatePrivateRequestCards(request, 'accepted');
    const msg = addPrivateRelationshipMessage({ fromUserId: actorId, toUserId: request.fromUserId, request, status: 'accepted' });
    emitToUser(request.fromUserId, 'relationship-update', { relationship: relation, request: { ...request } });
    emitToUser(request.toUserId, 'relationship-update', { relationship: relation, request: { ...request } });
    broadcastRoomRelationshipUpdate([request.fromUserId, request.toUserId]);
    return { success: true, status: 'accepted', relationship: relation, message: msg };
  }

  // REST API — all user actions are authenticated and keyed from req.authedMobile.
  app.get('/api/relationships/status/:targetUserId', userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor) return res.status(401).json({ success: false, message: 'User not found' });
    const targetId = req.params.targetUserId;
    if (!findUserByUserId(targetId)) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, ...publicStatus(actor.userId, targetId) });
  });

  app.post('/api/relationships/request', userAuth.requireUserAuth, async (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor) return res.status(401).json({ success: false, message: 'User not found' });
    try {
      const result = await sendRequest(actor.userId, req.body && req.body.targetUserId, req.body && req.body.type);
      res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
      console.error('[relationship] request error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  app.post('/api/relationships/respond', userAuth.requireUserAuth, async (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor) return res.status(401).json({ success: false, message: 'User not found' });
    try {
      const result = await respondRequest(actor.userId, req.body && req.body.requestId, req.body && req.body.action);
      res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
      console.error('[relationship] response error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  });

  app.get('/api/relationships/mine/:userId', userAuth.requireUserAuth, (req, res) => {
    const actor = users[req.authedMobile];
    if (!actor || actor.userId !== req.params.userId) return res.status(403).json({ success: false, message: 'You can only access your own relationships' });
    expireRequests();
    const relationships = Object.values(state.relationships).filter((r) => r.status === 'accepted' && (r.userA === actor.userId || r.userB === actor.userId));
    const pending = Object.values(state.requests).filter((r) => r.status === 'pending' && (r.fromUserId === actor.userId || r.toUserId === actor.userId));
    res.json({ success: true, relationships, pending, friendshipCost: FRIENDSHIP_COST, cpCost: CP_COST });
  });

  // Public: current CP/Friendship visual config, for the room client to
  // apply as CSS variables on load (before any socket config-update fires).
  app.get('/api/relationships/config', userAuth.requireUserAuth, (req, res) => {
    res.json({ success: true, config: publicVisualConfig() });
  });

  // ---------- Admin Panel — CP / Friendship visual settings + assets ----------
  // Guarded the same way every other admin-controlled visual asset in this
  // project is (requireAdmin + requirePermission), reusing the existing
  // multer upload instance passed in from server.js. Only wired up if the
  // caller actually provided admin/upload dependencies.
  if (app && requireAdmin && requirePermission) {
    const ALLOWED_FIELDS = ['width', 'height', 'scale', 'opacity', 'animationEnabled', 'animationSpeedSec', 'offsetX', 'offsetY', 'customAssetEnabled'];

    function sanitizeVisualPatch(kind, body) {
      const current = visualConfig[kind];
      const next = { ...current };
      if (body.width !== undefined) next.width = clampNum(body.width, 8, 400, current.width);
      if (body.height !== undefined) next.height = clampNum(body.height, 8, 400, current.height);
      if (body.scale !== undefined) next.scale = clampNum(body.scale, 0.1, 5, current.scale);
      if (body.opacity !== undefined) next.opacity = clampNum(body.opacity, 0, 1, current.opacity);
      if (body.animationEnabled !== undefined) next.animationEnabled = !!body.animationEnabled;
      if (body.animationSpeedSec !== undefined) next.animationSpeedSec = clampNum(body.animationSpeedSec, 0.2, 20, current.animationSpeedSec);
      if (body.offsetX !== undefined) next.offsetX = clampNum(body.offsetX, -200, 200, current.offsetX);
      if (body.offsetY !== undefined) next.offsetY = clampNum(body.offsetY, -200, 200, current.offsetY);
      if (body.customAssetEnabled !== undefined) next.customAssetEnabled = !!body.customAssetEnabled;
      return next;
    }
    function clampNum(v, min, max, fallback) {
      const n = Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    // GET current full config (admin view — same shape client gets, plus raw values for the form).
    app.get('/api/admin/relationships/config', requireAdmin, requirePermission('relationships:manage'), (req, res) => {
      res.json({ success: true, config: { version: visualConfig.version, cp: visualConfig.cp, friendship: visualConfig.friendship }, resolved: publicVisualConfig() });
    });

    // Save size/opacity/animation/position settings for one type ("cp" or "friendship").
    app.post('/api/admin/relationships/config/:type', requireAdmin, requirePermission('relationships:manage'), (req, res) => {
      const type = req.params.type;
      if (!['cp', 'friendship'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid relationship type' });
      const before = { ...visualConfig[type] };
      visualConfig[type] = sanitizeVisualPatch(type, req.body || {});
      visualConfig.version += 1; // cache-bust + lets clients know something changed
      saveVisualConfig();
      broadcastVisualConfig(); // TEST 9: existing connected clients update live, no refresh
      if (rbac && typeof rbac.logAction === 'function') {
        rbac.logAction({ admin: req.adminAccount, action: 'relationship-visual-config', module: 'relationships', targetType: type, targetId: type, before, after: visualConfig[type], ip: req.ip, userAgent: reqUserAgent ? reqUserAgent(req) : undefined });
      }
      res.json({ success: true, config: { version: visualConfig.version, cp: visualConfig.cp, friendship: visualConfig.friendship }, resolved: publicVisualConfig() });
    });

    // Reset one type back to bundled defaults (size/opacity/animation/position only — does not remove an uploaded custom asset, just disables it).
    app.post('/api/admin/relationships/config/:type/reset', requireAdmin, requirePermission('relationships:manage'), (req, res) => {
      const type = req.params.type;
      if (!['cp', 'friendship'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid relationship type' });
      const preservedAsset = { customAssetEnabled: visualConfig[type].customAssetEnabled, customAssetPath: visualConfig[type].customAssetPath };
      visualConfig[type] = { ...defaultVisual(type), ...preservedAsset };
      visualConfig.version += 1;
      saveVisualConfig();
      broadcastVisualConfig();
      res.json({ success: true, config: { version: visualConfig.version, cp: visualConfig.cp, friendship: visualConfig.friendship }, resolved: publicVisualConfig() });
    });

    if (uploadRelationshipAsset) {
      // Upload/replace the custom PNG for CP or Friendship. Does NOT
      // automatically enable it — the admin flips "Enable custom asset"
      // separately (also via the /config route above) so a preview can
      // happen before it goes live in every room.
      app.post('/api/admin/relationships/asset/:type', requireAdmin, requirePermission('relationships:manage'), uploadRelationshipAsset.single('asset'), (req, res) => {
        const type = req.params.type;
        if (!['cp', 'friendship'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid relationship type' });
        if (!req.file) return res.status(400).json({ success: false, message: 'File not found' });
        // Clean up the previous uploaded file for this type (not the bundled default) so uploads don't accumulate forever.
        const prevPath = visualConfig[type].customAssetPath;
        visualConfig[type].customAssetPath = req.file.filename;
        visualConfig.version += 1;
        saveVisualConfig();
        broadcastVisualConfig();
        if (prevPath && RELATIONSHIP_ASSET_FOLDER) {
          const oldFile = path.join(RELATIONSHIP_ASSET_FOLDER, prevPath);
          fs.unlink(oldFile, () => {}); // best-effort, ignore errors (e.g. already gone)
        }
        res.json({ success: true, config: { version: visualConfig.version, cp: visualConfig.cp, friendship: visualConfig.friendship }, resolved: publicVisualConfig() });
      });
    }

    // Restore the bundled default asset (disables the custom asset; does not delete it, so it can be re-enabled).
    app.post('/api/admin/relationships/asset/:type/restore-default', requireAdmin, requirePermission('relationships:manage'), (req, res) => {
      const type = req.params.type;
      if (!['cp', 'friendship'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid relationship type' });
      visualConfig[type].customAssetEnabled = false;
      visualConfig.version += 1;
      saveVisualConfig();
      broadcastVisualConfig();
      res.json({ success: true, config: { version: visualConfig.version, cp: visualConfig.cp, friendship: visualConfig.friendship }, resolved: publicVisualConfig() });
    });
  }

  return {
    FRIENDSHIP_COST, CP_COST, REQUEST_TTL_MS,
    getRelationship, getAcceptedRelationships, publicStatus, getSeatRelationshipLinks,
    sendRequest, respondRequest,
    broadcastRoomRelationshipUpdate, emitToRoomRelationshipState,
    publicVisualConfig
  };
}

module.exports = { initFriendshipCp };
