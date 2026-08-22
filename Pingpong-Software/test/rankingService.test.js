const assert = require("assert");
const { initRankingService } = require("../rankings/ranking.service");

const app = { get() {} };
const io = { emit() {} };
const users = {
  a: { userId:"a", name:"Alice", photo:"/a.jpg", level:10, vipLevel:2, svipLevel:0 },
  b: { userId:"b", name:"Bob", photo:"/b.jpg", level:11, vipLevel:3, svipLevel:1 },
  c: { userId:"c", name:"Cara", photo:"/c.jpg", level:9, vipLevel:1, svipLevel:0 }
};
const rooms = {
  r1: { roomId:"r1", roomName:"Real Room", hostId:"a", onlineUsers:[{userId:"a"},{userId:"b"}], logo:"/r.jpg" }
};
const now = new Date().toISOString();
const gifts = [
  { transactionId:"t1", status:"confirmed", senderId:"a", receiverId:"b", roomId:"r1", diamondAmount:100, quantity:2, timestamp:now },
  { transactionId:"t1", status:"confirmed", senderId:"a", receiverId:"b", roomId:"r1", diamondAmount:100, quantity:2, timestamp:now },
  { transactionId:"failed", status:"failed", senderId:"c", receiverId:"a", roomId:"r1", diamondAmount:1000, quantity:1, timestamp:now }
];

const ranking = initRankingService({
  app, io,
  userAuth: { requireUserAuth(req,res,next){ next(); } },
  findUserByUserId(id){ return users[id] ? { user: users[id] } : null; },
  getUsers:()=>users,
  getRooms:()=>rooms,
  getGiftHistory:()=>gifts,
  getAcceptedRelationships:()=>[
    { relationshipId:"rel1", type:"cp", userA:"a", userB:"b", status:"accepted" }
  ],
  onGiftRecorded(){}
});

const gifters = ranking.buildGifters("daily");
assert.strictEqual(gifters.length, 1);
assert.strictEqual(gifters[0].userId, "a");
assert.strictEqual(gifters[0].totalValue, 100);
assert.strictEqual(gifters[0].giftCount, 2);

const roomsRank = ranking.buildRooms("daily");
assert.strictEqual(roomsRank.length, 1);
assert.strictEqual(roomsRank[0].roomId, "r1");
assert.strictEqual(roomsRank[0].totalValue, 100);

const cp = ranking.buildCp("daily");
assert.strictEqual(cp.length, 1);
assert.strictEqual(cp[0].score, 100);
assert.strictEqual(cp[0].giftCount, 2);

console.log("Ranking service: PASS");
