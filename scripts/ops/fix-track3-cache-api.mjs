import fs from 'node:fs';

function replaceExact(path, from, to) {
  const src = fs.readFileSync(path, 'utf8');
  if (!src.includes(from)) throw new Error(`${path}: expected cache fragment not found`);
  fs.writeFileSync(path, src.replace(from, to));
}

replaceExact(
  'app/api/grooming-finance/route.ts',
  'async function readStagingFinanceCache():Promise<FinanceSnapshot|null>{if(!await stagingFinanceCacheEnabled())return null;try{const hit=await caches.default.match(STAGING_FINANCE_CACHE_KEY);return hit?await hit.json() as FinanceSnapshot:null;}catch{return null;}}\nasync function writeStagingFinanceCache(snapshot:FinanceSnapshot){if(!await stagingFinanceCacheEnabled())return;try{await caches.default.put(STAGING_FINANCE_CACHE_KEY,new Response(JSON.stringify(snapshot),{headers:{"content-type":"application/json","cache-control":`max-age=${STAGING_FINANCE_CACHE_TTL_SECONDS}`}));}catch{}}\nasync function invalidateStagingFinanceCache(){if(!await stagingFinanceCacheEnabled())return;try{await caches.default.delete(STAGING_FINANCE_CACHE_KEY);}catch{}}',
  'async function stagingFinanceCache(){return caches.open("pawspace-track3-finance-v2");}\nasync function readStagingFinanceCache():Promise<FinanceSnapshot|null>{if(!await stagingFinanceCacheEnabled())return null;try{const cache=await stagingFinanceCache();const hit=await cache.match(STAGING_FINANCE_CACHE_KEY);return hit?await hit.json() as FinanceSnapshot:null;}catch{return null;}}\nasync function writeStagingFinanceCache(snapshot:FinanceSnapshot){if(!await stagingFinanceCacheEnabled())return;try{const cache=await stagingFinanceCache();await cache.put(STAGING_FINANCE_CACHE_KEY,new Response(JSON.stringify(snapshot),{headers:{"content-type":"application/json","cache-control":`max-age=${STAGING_FINANCE_CACHE_TTL_SECONDS}`}));}catch{}}\nasync function invalidateStagingFinanceCache(){if(!await stagingFinanceCacheEnabled())return;try{const cache=await stagingFinanceCache();await cache.delete(STAGING_FINANCE_CACHE_KEY);}catch{}}'
);

replaceExact(
  'lib/uat-staging-auth.ts',
  'async function readCachedUatActor(email:string):Promise<Row|null>{try{const hit=await caches.default.match(uatActorCacheKey(email));return hit?await hit.json() as Row:null;}catch{return null;}}\nasync function writeCachedUatActor(email:string,row:Row){try{await caches.default.put(uatActorCacheKey(email),new Response(JSON.stringify(row),{headers:{"content-type":"application/json","cache-control":`max-age=${UAT_ACTOR_EDGE_CACHE_TTL_SECONDS}`}));}catch{}}',
  'async function uatActorEdgeCache(){return caches.open("pawspace-uat-actor-v1");}\nasync function readCachedUatActor(email:string):Promise<Row|null>{try{const cache=await uatActorEdgeCache();const hit=await cache.match(uatActorCacheKey(email));return hit?await hit.json() as Row:null;}catch{return null;}}\nasync function writeCachedUatActor(email:string,row:Row){try{const cache=await uatActorEdgeCache();await cache.put(uatActorCacheKey(email),new Response(JSON.stringify(row),{headers:{"content-type":"application/json","cache-control":`max-age=${UAT_ACTOR_EDGE_CACHE_TTL_SECONDS}`}));}catch{}}'
);

console.log('Track 3 Cache API typing compatibility patch applied');
