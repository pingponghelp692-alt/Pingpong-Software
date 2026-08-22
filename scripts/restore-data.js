'use strict';
const fs=require('fs'); const path=require('path'); const root=path.join(__dirname,'..');
const src=process.argv[2]; if(!src){ console.error('Usage: node scripts/restore-data.js <backup-directory>'); process.exit(2); }
if(!fs.existsSync(src)||!fs.statSync(src).isDirectory()){ console.error('Backup directory not found:',src); process.exit(2); }
const dest=path.join(root,'data'); fs.mkdirSync(dest,{recursive:true});
for(const name of fs.readdirSync(src)){ const p=path.join(src,name); if(fs.statSync(p).isFile()) fs.copyFileSync(p,path.join(dest,name)); }
console.log(`[restore] data restored from: ${src}`);
