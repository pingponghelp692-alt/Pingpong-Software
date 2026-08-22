'use strict';
/**
 * Production configuration contract.
 * Centralizes validation without owning application secrets or state.
 */
const REQUIRED_PRODUCTION = ['ADMIN_USERNAME','ADMIN_PASSWORD','METRICS_TOKEN'];
const OPTIONAL = ['DATABASE_URL','REDIS_URL','CORS_ORIGINS','LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','TURN_URL','TURN_USERNAME','TURN_CREDENTIAL'];
function bool(v, fallback=false){ if(v==null||v==='') return fallback; return ['1','true','yes','on'].includes(String(v).toLowerCase()); }
function getConfig(env=process.env){
  const production = env.NODE_ENV === 'production';
  const missing = production ? REQUIRED_PRODUCTION.filter(k => !String(env[k]||'').trim()) : [];
  if (production && missing.length) { const e=new Error(`Missing production configuration: ${missing.join(', ')}`); e.code='CONFIG_MISSING'; throw e; }
  return Object.freeze({ production, port:Number(env.PORT||3000), databaseUrl:env.DATABASE_URL||'', redisUrl:env.REDIS_URL||'', corsOrigins:env.CORS_ORIGINS||'', metricsPublic:bool(env.METRICS_PUBLIC,false), livekitConfigured:!!(env.LIVEKIT_URL&&env.LIVEKIT_API_KEY&&env.LIVEKIT_API_SECRET), turnConfigured:!!(env.TURN_URL&&env.TURN_USERNAME&&env.TURN_CREDENTIAL), walletLedgerMode:(env.WALLET_LEDGER_MODE||'legacy').toLowerCase(), clusterEnabled:bool(env.CLUSTER_ENABLED,false), missingOptional:OPTIONAL.filter(k=>!env[k]) });
}
function assertSafeProduction(env=process.env){ return getConfig(env); }
module.exports={getConfig,assertSafeProduction,REQUIRED_PRODUCTION,OPTIONAL};
