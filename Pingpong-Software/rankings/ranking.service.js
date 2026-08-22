
'use strict';

/**
 * PingPong Ranking Service
 * Source of truth:
 *   - CP: accepted CP relationships + confirmed gift history between the pair.
 *   - Rooms: confirmed gift history grouped by roomId.
 *   - Gifters: confirmed gift history grouped by senderId.
 *
 * This module never changes wallet/gift/room state. It is read/aggregate only.
 */
function initRankingService({
  app, io, userAuth,
  findUserByUserId,
  getUsers,
  getRooms,
  getGiftHistory,
  getAcceptedRelationships,
  onGiftRecorded,
}) {
  const PERIODS = new Set(['daily', 'weekly', 'monthly']);
  const INVALID_STATUSES = new Set(['pending', 'failed', 'cancelled', 'rejected', 'refunded', 'invalid', 'duplicate']);

  function periodStart(period, now = new Date()) {
    const d = new Date(now);
    if (period === 'daily') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (period === 'weekly') {
      // Monday 00:00 in the server's existing local timezone.
      const day = d.getDay(); // Sun=0, Mon=1
      const daysFromMonday = (day + 6) % 7;
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysFromMonday).getTime();
    }
    if (period === 'monthly') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    throw new Error('Invalid ranking period');
  }

  function validGift(e) {
    if (!e || !e.senderId || !Number.isFinite(Number(e.diamondAmount)) || Number(e.diamondAmount) <= 0) return false;
    const status = String(e.status || 'confirmed').toLowerCase();
    return !INVALID_STATUSES.has(status) && ['confirmed', 'success', 'completed'].includes(status);
  }

  function giftTime(e) {
    const t = Date.parse(e.timestamp || e.time || '');
    return Number.isFinite(t) ? t : 0;
  }

  function periodEntries(period) {
    const since = periodStart(period);
    const seen = new Set();
    const out = [];
    for (const e of (getGiftHistory() || [])) {
      if (!validGift(e)) continue;
      const t = giftTime(e);
      if (!t || t < since) continue;
      const key = e.transactionId || e.giftHistoryId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  }

  function publicUser(userId) {
    const found = findUserByUserId(userId);
    if (!found || !found.user) return null;
    const u = found.user;
    return {
      id: u.userId,
      name: u.name || 'User',
      avatar: u.photo || u.avatar || '',
      level: Number(u.level) || 1,
      vipLevel: Number(u.vipLevel) || 0,
      svipLevel: Number(u.svipLevel) || 0,
    };
  }

  function rankList(list) {
    list.sort((a, b) =>
      Number(b.totalValue || b.score || 0) - Number(a.totalValue || a.score || 0) ||
      Number(b.giftCount || 0) - Number(a.giftCount || 0) ||
      (Date.parse(b.lastGiftTime || '') || 0) - (Date.parse(a.lastGiftTime || '') || 0)
    );
    list.forEach((x, i) => { x.rank = i + 1; });
    return list;
  }

  function buildGifters(period) {
    const totals = new Map();
    for (const e of periodEntries(period)) {
      const uid = e.senderId;
      const qty = Math.max(1, Number(e.quantity) || 1);
      const v = Number(e.diamondAmount);
      const cur = totals.get(uid) || { totalValue: 0, giftCount: 0, lastGiftTime: 0 };
      cur.totalValue += v;
      cur.giftCount += qty;
      cur.lastGiftTime = Math.max(cur.lastGiftTime, giftTime(e));
      totals.set(uid, cur);
    }
    const rows = [];
    for (const [userId, t] of totals) {
      const user = publicUser(userId);
      if (!user) continue; // never fabricate a deleted/unknown user profile
      rows.push({
        userId,
        user,
        giftCount: t.giftCount,
        totalValue: t.totalValue,
        lastGiftTime: new Date(t.lastGiftTime).toISOString(),
      });
    }
    return rankList(rows);
  }

  function buildRooms(period) {
    const totals = new Map();
    for (const e of periodEntries(period)) {
      if (!e.roomId) continue;
      const qty = Math.max(1, Number(e.quantity) || 1);
      const v = Number(e.diamondAmount);
      const cur = totals.get(e.roomId) || { totalValue: 0, giftCount: 0, lastGiftTime: 0 };
      cur.totalValue += v;
      cur.giftCount += qty;
      cur.lastGiftTime = Math.max(cur.lastGiftTime, giftTime(e));
      totals.set(e.roomId, cur);
    }
    const rooms = getRooms() || {};
    const rows = [];
    for (const [roomId, t] of totals) {
      const room = rooms[roomId];
      if (!room) continue;
      const host = publicUser(room.hostId);
      rows.push({
        roomId,
        roomNumber: room.roomNumber || room.hostId || roomId,
        roomName: room.roomName || 'Room',
        roomAvatar: room.logo || room.background || '',
        hostId: room.hostId || null,
        hostName: host ? host.name : (room.hostName || 'Host'),
        hostAvatar: host ? host.avatar : '',
        onlineCount: Array.isArray(room.onlineUsers) ? room.onlineUsers.filter(Boolean).length : 0,
        giftCount: t.giftCount,
        totalValue: t.totalValue,
        lastGiftTime: new Date(t.lastGiftTime).toISOString(),
      });
    }
    return rankList(rows);
  }

  function buildRoomDetail(roomId, period) {
    const rooms = getRooms() || {};
    const room = rooms[roomId];
    if (!room) return null;
    const entries = periodEntries(period).filter(e => e.roomId === roomId);
    const bySender = new Map();
    let totalValue = 0, giftCount = 0;
    for (const e of entries) {
      const qty = Math.max(1, Number(e.quantity) || 1);
      const v = Number(e.diamondAmount);
      totalValue += v; giftCount += qty;
      const cur = bySender.get(e.senderId) || { totalValue: 0, giftCount: 0 };
      cur.totalValue += v; cur.giftCount += qty;
      bySender.set(e.senderId, cur);
    }
    const topGifters = [];
    for (const [userId, t] of bySender) {
      const user = publicUser(userId);
      if (user) topGifters.push({ userId, user, giftCount: t.giftCount, totalValue: t.totalValue });
    }
    rankList(topGifters);
    const host = publicUser(room.hostId);
    return {
      roomId,
      roomName: room.roomName || 'Room',
      host: host || { id: room.hostId || null, name: room.hostName || 'Host', avatar: '', level: 1, vipLevel: 0, svipLevel: 0 },
      onlineCount: Array.isArray(room.onlineUsers) ? room.onlineUsers.filter(Boolean).length : 0,
      giftCount, totalValue, period,
      topGifters,
    };
  }

  function buildCp(period) {
    const entries = periodEntries(period);
    const relationships = (getAcceptedRelationships ? getAcceptedRelationships('cp') : []) || [];
    const rows = [];
    for (const r of relationships) {
      const pair = new Set([r.userA, r.userB]);
      let score = 0, giftCount = 0, lastGiftTime = 0;
      for (const e of entries) {
        if (!pair.has(e.senderId) || !pair.has(e.receiverId)) continue;
        score += Number(e.diamondAmount);
        giftCount += Math.max(1, Number(e.quantity) || 1);
        lastGiftTime = Math.max(lastGiftTime, giftTime(e));
      }
      // CP ranking is activity based; an accepted CP with no period activity
      // is not invented into a Top list with a fake score.
      if (score <= 0) continue;
      const a = publicUser(r.userA), b = publicUser(r.userB);
      if (!a || !b) continue;
      rows.push({
        relationshipId: r.relationshipId,
        userA: a,
        userB: b,
        score,
        giftCount,
        period,
        lastGiftTime: new Date(lastGiftTime).toISOString(),
      });
    }
    rows.sort((a,b) => b.score-a.score || b.giftCount-a.giftCount || (Date.parse(b.lastGiftTime)||0)-(Date.parse(a.lastGiftTime)||0));
    rows.forEach((x,i)=>x.rank=i+1);
    return rows;
  }

  function buildAll(period) {
    return { period, generatedAt: new Date().toISOString(), cp: buildCp(period), rooms: buildRooms(period), gifters: buildGifters(period) };
  }

  function periodFromReq(req) {
    const p = String(req.query.period || 'daily').toLowerCase();
    return PERIODS.has(p) ? p : null;
  }

  function auth(req, res, next) {
    return userAuth.requireUserAuth(req, res, next);
  }

  app.get('/api/rankings/cp', auth, (req,res) => {
    const period = periodFromReq(req);
    if (!period) return res.status(400).json({ success:false, message:'Invalid period. Use daily, weekly or monthly.' });
    res.json({ success:true, ...buildAll(period), ranking: buildCp(period) });
  });
  app.get('/api/rankings/rooms', auth, (req,res) => {
    const period = periodFromReq(req);
    if (!period) return res.status(400).json({ success:false, message:'Invalid period. Use daily, weekly or monthly.' });
    res.json({ success:true, ...buildAll(period), ranking: buildRooms(period) });
  });
  app.get('/api/rankings/rooms/:roomId', auth, (req,res) => {
    const period = periodFromReq(req);
    if (!period) return res.status(400).json({ success:false, message:'Invalid period. Use daily, weekly or monthly.' });
    const detail = buildRoomDetail(req.params.roomId, period);
    if (!detail) return res.status(404).json({ success:false, message:'Room not found' });
    res.json({ success:true, ...detail });
  });
  app.get('/api/rankings/gifters', auth, (req,res) => {
    const period = periodFromReq(req);
    if (!period) return res.status(400).json({ success:false, message:'Invalid period. Use daily, weekly or monthly.' });
    res.json({ success:true, ...buildAll(period), ranking: buildGifters(period) });
  });

  function emitUpdates() {
    for (const period of PERIODS) {
      io.emit('ranking:cp:update', { period, ranking: buildCp(period), generatedAt: new Date().toISOString() });
      io.emit('ranking:room:update', { period, ranking: buildRooms(period), generatedAt: new Date().toISOString() });
      io.emit('ranking:gifters:update', { period, ranking: buildGifters(period), generatedAt: new Date().toISOString() });
    }
  }

  if (typeof onGiftRecorded === 'function') onGiftRecorded(() => emitUpdates());

  return { buildCp, buildRooms, buildGifters, buildRoomDetail, buildAll, emitUpdates };
}

module.exports = { initRankingService };
