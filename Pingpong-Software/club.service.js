'use strict';

// PingPong Club — persistent, server-authoritative module.
// Source of truth: club JSON ledgers + existing users + confirmed gift history.
// No client-supplied identity, balance, EXP or ranking is trusted.

const crypto = require('crypto');

const LEVELS = [
  { key:'steel',  min:0,           max:79_999_999,      coLeaders:1, admins:2, maxMembers:200 },
  { key:'bronze', min:80_000_000,  max:399_999_999,    coLeaders:2, admins:5, maxMembers:500 },
  { key:'silver', min:400_000_000, max:3_999_999_999,  coLeaders:3, admins:10,maxMembers:1000 },
  { key:'gold',   min:4_000_000_000,max:Number.MAX_SAFE_INTEGER,coLeaders:5,admins:15,maxMembers:2000 }
];

function initClubService({ app, io, DATA_FOLDER, safeRead, safeWrite, userAuth, findUserByUserId, users, onGiftRecorded }) {
  const FILES = {
    clubs: require('path').join(DATA_FOLDER, 'clubs.json'),
    members: require('path').join(DATA_FOLDER, 'club_members.json'),
    invites: require('path').join(DATA_FOLDER, 'club_invites.json'),
    contributions: require('path').join(DATA_FOLDER, 'club_contributions.json')
  };

  const clubs = new Map();
  const members = new Map(); // clubId -> Map(userId, member)
  const invites = new Map();
  const contributions = new Map(); // transaction/event id -> contribution

  function nowIso(){ return new Date().toISOString(); }
  function id(){ return crypto.randomUUID(); }
  function monthKey(d=new Date()){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
  function levelForExp(exp){ return LEVELS.slice().reverse().find(x => Number(exp) >= x.min) || LEVELS[0]; }
  function userProfile(userId){
    const found = findUserByUserId(String(userId));
    if (!found || !found.user) return null;
    const u = found.user;
    return { id:u.userId, name:u.name || 'User', avatar:u.photo || u.avatar || '', level:Number(u.level)||1, vipLevel:Number(u.vipLevel)||0, svipLevel:Number(u.svipLevel)||0 };
  }
  function load(){
    const rawClubs = safeRead(FILES.clubs, []);
    const rawMembers = safeRead(FILES.members, []);
    const rawInvites = safeRead(FILES.invites, []);
    const rawContrib = safeRead(FILES.contributions, []);
    for(const c of Array.isArray(rawClubs) ? rawClubs : []) if(c && c.id && c.ownerId) clubs.set(c.id,c);
    for(const m of Array.isArray(rawMembers) ? rawMembers : []) {
      if(!m || !m.clubId || !m.userId) continue;
      if(!members.has(m.clubId)) members.set(m.clubId,new Map());
      members.get(m.clubId).set(String(m.userId),m);
    }
    for(const inv of Array.isArray(rawInvites) ? rawInvites : []) if(inv && inv.id) invites.set(inv.id,inv);
    for(const c of Array.isArray(rawContrib) ? rawContrib : []) if(c && c.eventId) contributions.set(String(c.eventId),c);
    // Remove memberships pointing to deleted clubs/users and normalize owners.
    for(const [clubId,map] of members){
      if(!clubs.has(clubId)){ members.delete(clubId); continue; }
      for(const [uid] of map) if(!userProfile(uid)) map.delete(uid);
      const club=clubs.get(clubId);
      if(!map.has(String(club.ownerId))){ map.set(String(club.ownerId),{id:String(club.ownerId),role:'owner',joinedAt:club.createdAt||nowIso()}); }
    }
    persistAll();
  }
  function persistAll(){
    safeWrite(FILES.clubs,[...clubs.values()]);
    const ms=[]; for(const [clubId,map] of members) for(const m of map.values()) ms.push({...m,clubId});
    safeWrite(FILES.members,ms);
    safeWrite(FILES.invites,[...invites.values()]);
    safeWrite(FILES.contributions,[...contributions.values()]);
  }
  function getMember(clubId,userId){ return members.get(clubId)?.get(String(userId)) || null; }
  function findUserClub(userId){
    const uid=String(userId);
    for(const [clubId,map] of members) if(map.has(uid)) return clubs.get(clubId) || null;
    return null;
  }
  function monthlyExp(clubId, month=monthKey()){
    let total=0;
    for(const c of contributions.values()) if(c.clubId===clubId && c.month===month && c.status==='confirmed') total += Number(c.exp)||0;
    return total;
  }
  function sanitizeClub(c,myRole=null){
    if(!c) return null;
    const exp=monthlyExp(c.id);
    const lvl=levelForExp(exp);
    return { id:c.id, name:c.name, ownerId:c.ownerId, avatarUrl:c.avatarUrl||'', labelStyle:lvl.key, level:lvl.key, exp, memberCount:(members.get(c.id)?.size)||0, maxMembers:lvl.maxMembers, myRole, createdAt:c.createdAt };
  }
  function currentUser(req){
    if(!req.authedMobile) throw new Error('Authentication required');
    const found=Object.values(users).find(u=>u && String(u.mobile||'')===String(req.authedMobile)) || users[req.authedMobile];
    if(!found) throw new Error('User account not found');
    return { id:String(found.userId), name:found.name||'User', photo:found.photo||found.avatar||'' };
  }
  function assertName(name){
    const n=String(name||'').trim();
    if(n.length<2 || n.length>40) throw new Error('Club name must be 2-40 characters');
    return n;
  }
  function createClub(user,name,avatarUrl){
    if(findUserClub(user.id)) throw new Error('User already belongs to a club');
    const n=assertName(name);
    if([...clubs.values()].some(c=>c.name.toLowerCase()===n.toLowerCase())) throw new Error('Club name already exists');
    const club={id:id(),name:n,ownerId:user.id,avatarUrl:String(avatarUrl||'').slice(0,500),createdAt:nowIso(),updatedAt:nowIso()};
    clubs.set(club.id,club);
    members.set(club.id,new Map([[user.id,{id:user.id,role:'owner',joinedAt:nowIso()}]]));
    persistAll();
    io.emit('club:update',{type:'created',club:sanitizeClub(club)});
    return club;
  }
  function addMember(clubId,userId,role='member'){
    const club=clubs.get(clubId); if(!club) throw new Error('Club not found');
    const uid=String(userId);
    if(!userProfile(uid)) throw new Error('User not found');
    if(findUserClub(uid)) throw new Error('User already belongs to a club');
    const map=members.get(clubId)||new Map();
    const exp=monthlyExp(clubId), lvl=levelForExp(exp);
    if(map.size>=lvl.maxMembers) throw new Error('Club member limit reached');
    map.set(uid,{id:uid,role,joinedAt:nowIso()}); members.set(clubId,map);
    club.updatedAt=nowIso(); persistAll();
  }
  function canManage(role){ return ['owner','co-leader','admin'].includes(role); }
  function canAssign(actor,targetRole){
    if(actor==='owner') return ['co-leader','admin','member'].includes(targetRole);
    if(actor==='co-leader') return ['admin','member'].includes(targetRole);
    if(actor==='admin') return targetRole==='member';
    return false;
  }
  function memberList(clubId){
    const out=[]; for(const m of (members.get(clubId)?.values()||[])){ const u=userProfile(m.id); if(u) out.push({...u,role:m.role,joinedAt:m.joinedAt}); }
    return out;
  }
  function createInvite(clubId,inviterId,inviteeId){
    const club=clubs.get(clubId), me=getMember(clubId,inviterId); if(!club||!me||!canManage(me.role)) throw new Error('Permission denied');
    if(!userProfile(inviteeId)) throw new Error('User not found');
    if(findUserClub(inviteeId)) throw new Error('User already belongs to a club');
    const invite={id:id(),clubId,inviterId:String(inviterId),inviteeId:String(inviteeId),status:'pending',createdAt:nowIso(),expiresAt:new Date(Date.now()+7*864e5).toISOString()};
    invites.set(invite.id,invite); persistAll();
    io.to(`user:${inviteeId}`).emit('club:invite',invite);
    return invite;
  }
  function acceptInvite(inviteId,userId){
    const inv=invites.get(inviteId); if(!inv || inv.status!=='pending') throw new Error('Invitation is invalid');
    if(inv.inviteeId!==String(userId)) throw new Error('Permission denied');
    if(new Date(inv.expiresAt)<new Date()) throw new Error('Invitation expired');
    addMember(inv.clubId,userId,'member'); inv.status='accepted'; persistAll(); return clubs.get(inv.clubId);
  }
  function leave(clubId,userId){
    const map=members.get(clubId), m=getMember(clubId,userId); if(!map||!m) throw new Error('Club/member not found');
    if(m.role==='owner') throw new Error('Owner cannot leave. Transfer ownership first.');
    map.delete(String(userId)); persistAll(); io.emit('club:update',{type:'member-left',clubId});
  }
  function removeMember(clubId,actorId,targetId){
    const actor=getMember(clubId,actorId), target=getMember(clubId,targetId); if(!actor||!target||!canManage(actor.role)) throw new Error('Permission denied');
    if(target.role==='owner') throw new Error('Owner cannot be removed');
    if(actor.role==='admin' && target.role!=='member') throw new Error('Insufficient role');
    if(actor.role==='co-leader' && ['co-leader','owner'].includes(target.role)) throw new Error('Insufficient role');
    members.get(clubId).delete(String(targetId)); persistAll(); io.emit('club:update',{type:'member-removed',clubId,userId:String(targetId)});
  }
  function setRole(clubId,actorId,targetId,role){
    if(!['member','admin','co-leader'].includes(role)) throw new Error('Invalid role');
    const actor=getMember(clubId,actorId), target=getMember(clubId,targetId); if(!actor||!target||!canAssign(actor.role,role)) throw new Error('Permission denied');
    if(target.role==='owner') throw new Error('Owner role cannot be changed');
    const map=members.get(clubId); const current=target.role;
    const lvl=levelForExp(monthlyExp(clubId));
    if(role==='co-leader' && current!=='co-leader' && [...map.values()].filter(x=>x.role==='co-leader').length>=lvl.coLeaders) throw new Error('Co-leader limit reached');
    if(role==='admin' && current!=='admin' && [...map.values()].filter(x=>x.role==='admin').length>=lvl.admins) throw new Error('Admin limit reached');
    target.role=role; persistAll(); return target;
  }
  function transferOwnership(clubId,ownerId,targetId){
    const club=clubs.get(clubId), actor=getMember(clubId,ownerId), target=getMember(clubId,targetId);
    if(!club||!actor||actor.role!=='owner'||!target) throw new Error('Permission denied');
    actor.role='member'; target.role='owner'; club.ownerId=String(targetId); club.updatedAt=nowIso(); persistAll(); return club;
  }
  function contributeFromGift(record){
    if(!record || record.status!=='confirmed' || !record.transactionId || !record.senderId) return;
    if(contributions.has(String(record.transactionId))) return;
    const club=findUserClub(record.senderId); if(!club) return;
    const value=Math.max(0,Number(record.diamondAmount)||0); if(value<=0) return;
    const contribution={id:id(),eventId:String(record.transactionId),clubId:club.id,userId:String(record.senderId),value,exp:value,sourceType:'gift',sourceId:record.transactionId,giftId:record.giftId||null,roomId:record.roomId||null,status:'confirmed',month:monthKey(),createdAt:nowIso()};
    contributions.set(contribution.eventId,contribution); club.updatedAt=nowIso(); persistAll();
    io.emit('club:update',{type:'contribution',clubId:club.id,exp:monthlyExp(club.id),level:levelForExp(monthlyExp(club.id)).key});
  }
  if(typeof onGiftRecorded==='function') onGiftRecorded(contributeFromGift);
  load();

  // All mutations and reads are authenticated. Routes never accept x-user-id as identity.
  app.get('/api/clubs/me', userAuth.requireUserAuth, (req,res)=>{
    try{
      const u=currentUser(req), c=findUserClub(u.id); const myRole=c?getMember(c.id,u.id)?.role:null;
      const recommendations=[...clubs.values()].filter(x=>!c||x.id!==c.id).sort((a,b)=>monthlyExp(b.id)-monthlyExp(a.id)).slice(0,20).map(x=>sanitizeClub(x));
      res.json({success:true,user:{id:u.id,name:u.name,avatar:u.photo},club:c?sanitizeClub(c,myRole):null,recommendations});
    }catch(e){res.status(401).json({success:false,error:e.message});}
  });
  app.post('/api/clubs', userAuth.requireUserAuth, (req,res)=>{
    try{ const c=createClub(currentUser(req),req.body.name,req.body.avatarUrl); res.status(201).json({success:true,club:sanitizeClub(c,'owner')}); }
    catch(e){res.status(400).json({success:false,error:e.message});}
  });
  app.get('/api/clubs/ranking', userAuth.requireUserAuth, (req,res)=>{
    const ranking=[...clubs.values()].map(c=>sanitizeClub(c)).sort((a,b)=>b.exp-a.exp||b.memberCount-a.memberCount); ranking.forEach((x,i)=>x.rank=i+1);
    res.json({success:true,period:monthKey(),ranking});
  });
  app.get('/api/clubs/:clubId', userAuth.requireUserAuth, (req,res)=>{
    try{ const c=clubs.get(req.params.clubId); if(!c)return res.status(404).json({success:false,error:'Club not found'}); const u=currentUser(req), role=getMember(c.id,u.id)?.role||null; res.json({success:true,club:sanitizeClub(c,role),members:memberList(c.id)}); }
    catch(e){res.status(401).json({success:false,error:e.message});}
  });
  app.post('/api/clubs/:clubId/join', userAuth.requireUserAuth, (req,res)=>{
    try{ const u=currentUser(req); addMember(req.params.clubId,u.id,'member'); res.json({success:true,club:sanitizeClub(clubs.get(req.params.clubId),'member')}); }
    catch(e){res.status(400).json({success:false,error:e.message});}
  });
  app.post('/api/clubs/:clubId/invites', userAuth.requireUserAuth, (req,res)=>{
    try{ const u=currentUser(req); const inv=createInvite(req.params.clubId,u.id,String(req.body.userId||'')); res.status(201).json({success:true,invite:inv}); }
    catch(e){res.status(400).json({success:false,error:e.message});}
  });
  app.post('/api/clubs/invites/:inviteId/accept', userAuth.requireUserAuth, (req,res)=>{
    try{ const c=acceptInvite(req.params.inviteId,currentUser(req).id); res.json({success:true,club:sanitizeClub(c,'member')}); }
    catch(e){res.status(400).json({success:false,error:e.message});}
  });
  app.post('/api/clubs/:clubId/leave', userAuth.requireUserAuth, (req,res)=>{ try{leave(req.params.clubId,currentUser(req).id);res.json({success:true});}catch(e){res.status(400).json({success:false,error:e.message});} });
  app.delete('/api/clubs/:clubId/members/:userId', userAuth.requireUserAuth, (req,res)=>{ try{removeMember(req.params.clubId,currentUser(req).id,req.params.userId);res.json({success:true});}catch(e){res.status(400).json({success:false,error:e.message});} });
  app.post('/api/clubs/:clubId/members/:userId/role', userAuth.requireUserAuth, (req,res)=>{ try{const m=setRole(req.params.clubId,currentUser(req).id,req.params.userId,req.body.role);res.json({success:true,member:m});}catch(e){res.status(400).json({success:false,error:e.message});} });
  app.post('/api/clubs/:clubId/transfer-owner', userAuth.requireUserAuth, (req,res)=>{ try{const c=transferOwnership(req.params.clubId,currentUser(req).id,req.body.userId);res.json({success:true,club:sanitizeClub(c,'member')});}catch(e){res.status(400).json({success:false,error:e.message});} });

  return { clubs, members, invites, contributions, monthlyExp, findUserClub, getMember, sanitizeClub, contributeFromGift, ranking(){return [...clubs.values()].map(c=>sanitizeClub(c)).sort((a,b)=>b.exp-a.exp);} };
}

module.exports={LEVELS,initClubService};
