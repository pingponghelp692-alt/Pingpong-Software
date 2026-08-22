'use strict';
const fs=require('fs'); const path=require('path'); const root=path.join(__dirname,'..');
const src=path.join(root,'data'); const out=process.env.BACKUP_DIR||path.join(root,'backups');
fs.mkdirSync(out,{recursive:true}); const stamp=new Date().toISOString().replace(/[:.]/g,'-'); const dest=path.join(out,stamp); fs.mkdirSync(dest,{recursive:true});
for(const name of fs.readdirSync(src)){ const p=path.join(src,name); if(fs.statSync(p).isFile()) fs.copyFileSync(p,path.join(dest,name)); }
console.log(`[backup] data snapshot created: ${dest}`);
