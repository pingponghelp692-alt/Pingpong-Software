'use strict';
const { assertSafeProduction } = require('../integration_update/config');
const { run } = require('../integration_update/database');
(async()=>{
  assertSafeProduction();
  await run({databaseUrl:process.env.DATABASE_URL});
  require('../server.js');
})().catch(err=>{ console.error('[production-start] startup aborted:',err.message); process.exit(1); });
