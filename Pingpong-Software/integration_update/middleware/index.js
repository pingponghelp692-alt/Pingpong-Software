'use strict';
/** Shared additive HTTP middleware helpers. No business logic or state ownership. */
const crypto=require('crypto');
function requestId(req,res,next){ const id=req.get('x-request-id')||crypto.randomUUID(); res.set('x-request-id',id); req.requestId=id; next(); }
function noStore(res){ res.set('Cache-Control','no-store'); }
function requireJson(req,res,next){ if(req.method==='GET'||req.method==='HEAD'||req.is('application/json')||!req.headers['content-type']) return next(); return res.status(415).json({success:false,message:'application/json required'}); }
function compose(...fns){ return (req,res,next)=>{ let i=0; const run=(err)=>{ if(err) return next(err); const fn=fns[i++]; if(!fn) return next(); try{ fn(req,res,run); }catch(e){ next(e); } }; run(); }; }
module.exports={requestId,noStore,requireJson,compose};
