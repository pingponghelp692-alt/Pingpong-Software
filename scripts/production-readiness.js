'use strict';
const fs=require('fs'),path=require('path'); const root=path.join(__dirname,'..');
const files=['server.js','package.json','Dockerfile','docker-compose.production.yml','monitoring/prometheus.yml','.github/workflows/ci.yml','integration_update/config/index.js','integration_update/middleware/index.js','scripts/backup-data.js','scripts/restore-data.js'];
const missing=files.filter(f=>!fs.existsSync(path.join(root,f))); if(missing.length){console.error('Missing:',missing.join(', '));process.exit(1);}
const {spawnSync}=require('child_process'); const js=[]; function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(['node_modules','.git'].includes(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.js'))js.push(p);}} walk(root);
let bad=0; for(const f of js){const r=spawnSync(process.execPath,['--check',f],{encoding:'utf8'});if(r.status){bad++;console.error('Syntax failure:',path.relative(root,f));}}
if(bad){process.exit(1);} console.log(`Production readiness: ${js.length} JavaScript files parse cleanly; ${files.length} deployment/core assets present.`);
