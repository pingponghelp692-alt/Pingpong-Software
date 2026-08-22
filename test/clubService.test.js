'use strict';
const assert=require('assert');
const fs=require('fs'); const os=require('os'); const path=require('path');
const {initClubService}=require('../club.service');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pp-club-'));
const files={};
function safeRead(file, fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}}
function safeWrite(file,data){fs.writeFileSync(file,JSON.stringify(data));}
const users={m1:{userId:'u1',name:'Alice',photo:'/a.jpg'},m2:{userId:'u2',name:'Bob',photo:'/b.jpg'},m3:{userId:'u3',name:'Cara',photo:'/c.jpg'}};
const find=id=>{const u=Object.values(users).find(x=>x.userId===String(id)); return u?{user:u}:null;};
const hooks=[]; const io={emit(){},to(){return {emit(){}}}}; const app={get(){},post(){},delete(){}}; const userAuth={requireUserAuth(req,res,next){req.authedMobile='m1';next();}};
const svc=initClubService({app,io,DATA_FOLDER:dir,safeRead,safeWrite,userAuth,findUserByUserId:find,users,onGiftRecorded:fn=>hooks.push(fn)});
const c=svc.clubs.size===0 ? null : [...svc.clubs.values()][0];
// Direct API routes are wired by the service; exercise core state via the persisted stores.
assert.strictEqual(svc.ranking().length,0);
// create through the route isn't needed here; call the route-independent behavior by invoking the real POST handler captured below.
let postCreate;
const originalPost=app.post;
// handlers were captured only by our mock if it stored them; replace wasn't possible after init, so test gift hook against a seeded club.
// Seed a real persistent club/member record and reinitialize.
fs.writeFileSync(path.join(dir,'clubs.json'),JSON.stringify([{id:'c1',name:'Real Club',ownerId:'u1',createdAt:new Date().toISOString()}]));
fs.writeFileSync(path.join(dir,'club_members.json'),JSON.stringify([{clubId:'c1',id:'u1',userId:'u1',role:'owner',joinedAt:new Date().toISOString()}]));
const svc2=initClubService({app,io,DATA_FOLDER:dir,safeRead,safeWrite,userAuth,findUserByUserId:find,users,onGiftRecorded:fn=>hooks.push(fn)});
assert.strictEqual(svc2.ranking()[0].exp,0);
hooks[hooks.length-1]({transactionId:'tx1',status:'confirmed',senderId:'u1',roomId:'r1',giftId:'g1',diamondAmount:500,quantity:1});
assert.strictEqual(svc2.ranking()[0].exp,500);
hooks[hooks.length-1]({transactionId:'tx1',status:'confirmed',senderId:'u1',roomId:'r1',giftId:'g1',diamondAmount:500,quantity:1});
assert.strictEqual(svc2.ranking()[0].exp,500);
hooks[hooks.length-1]({transactionId:'bad',status:'failed',senderId:'u1',diamondAmount:999});
assert.strictEqual(svc2.ranking()[0].exp,500);
console.log('Club service: PASS');
