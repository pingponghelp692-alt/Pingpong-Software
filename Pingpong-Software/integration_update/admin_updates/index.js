'use strict';
/** Admin extension manifest. Concrete merchant UI/routes remain owned by the existing app. */
const MODULES=Object.freeze([
 {name:'merchants',permission:'merchant:view',managePermission:'merchant:manage',path:'/api/admin/merchants'},
 {name:'ai',permission:'ai-core:view',path:'/api/admin/ai'},
 {name:'voice-sfu',permission:'voice-sfu:manage',path:'/api/admin/voice-sfu'}
]);
function list(){ return MODULES.map(x=>({...x})); }
function visibleFor(perms=[]){ const set=new Set(perms); return list().filter(x=>set.has(x.permission)||set.has(x.managePermission)); }
module.exports={MODULES,list,visibleFor};
