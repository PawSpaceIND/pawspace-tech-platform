import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__AI_QUOTA_NATIVE_DB__','__AI_QUOTA_NATIVE_ENV__');
const {reserveAiProviderRequest,ensureAiProviderRuntimeControl}=await import('../lib/ai-provider-runtime-control.ts');
for(const quota of ['requests','tokens','cost'])test('native local D1: atomic '+quota+' budget across50 distinct reservations',{timeout:60000},async t=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('isolated quota test')}}",compatibilityDate:'2026-09-01',d1Databases:{DB:'ai-quota-'+quota},d1Persist:false,cf:false,outboundService:async()=>{throw Error('External requests forbidden')}}));t.after(()=>mf.dispose());
 const db=await mf.getD1Database('DB');await ensureAiProviderRuntimeControl(db);
 const env={PAWSPACE_AI_MAX_REQUESTS_PER_MINUTE:quota==='requests'?1:100,PAWSPACE_AI_MAX_RESERVED_TOKENS_PER_DAY:quota==='tokens'?1000:100000,PAWSPACE_AI_ESTIMATED_COST_MICROS_PER_1K_TOKENS:1000,PAWSPACE_AI_MAX_ESTIMATED_COST_MICROS_PER_DAY:quota==='cost'?1000:100000};
 const input={provider:'fake',modelRef:'fake',systemPrompt:'s',userPrompt:'u',maxOutputTokens:999,asOf:Date.now()};
 const results=await Promise.all(Array.from({length:50},()=>reserveAiProviderRequest(db,env,input)));
 assert.equal(results.filter(r=>r.allowed).length,1,JSON.stringify(results));
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM ai_provider_runtime_requests').first()).n,1);
});
