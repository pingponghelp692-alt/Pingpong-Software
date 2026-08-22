const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const required = ['server.js','package.json','.env.example','Dockerfile','docker-compose.production.yml','monitoring/prometheus.yml','monitoring/prometheus-alerts.yml','monitoring/grafana/provisioning/dashboards/provider.yml','monitoring/grafana/provisioning/datasources/prometheus.yml','integration_update/config/index.js','integration_update/middleware/index.js','scripts/backup-data.js','scripts/restore-data.js'];
const missing = required.filter(f => !fs.existsSync(path.join(root,f)));
if (missing.length) { console.error('Missing production files:', missing.join(', ')); process.exit(1); }
const files = [];
function walk(dir) { for (const e of fs.readdirSync(dir,{withFileTypes:true})) { if (['node_modules','.git'].includes(e.name)) continue; const p=path.join(dir,e.name); if(e.isDirectory()) walk(p); else if(p.endsWith('.js')) files.push(p); } }
walk(root);
for (const f of files) { const r=spawnSync(process.execPath,['--check',f],{encoding:'utf8'}); if(r.status!==0){ console.error('Syntax failure:',path.relative(root,f)); process.stderr.write(r.stderr||''); process.exit(1); } }
console.log(`Production preflight: ${files.length} JavaScript files syntax-clean; required deployment assets present.`);
