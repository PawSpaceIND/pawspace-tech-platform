import {randomUUID} from 'node:crypto';
export const COMPONENT_BUDGET_ID='managed-audio-approved-usd5-20261002';
export const COMPONENT_LIMITS=Object.freeze({capMicros:5000000,requestsPerKind:30,inputBytes:65536,inputTokenOverhead:512,outputTokens:700,ttsCharacters:1000,inputSeconds:60,inputRate:16000,outputRate:16000,deadlineMs:45000,leaseMs:7200000,ratesExpireAt:Date.parse('2026-10-03T00:00:00Z')});
export const COMPONENT_BUDGET_DDL="CREATE TABLE IF NOT EXISTS managed_audio_test_budget (id TEXT PRIMARY KEY,cap_micros INTEGER NOT NULL CHECK(cap_micros=5000000),reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micros BETWEEN 0 AND 5000000))";
export const COMPONENT_RUN_DDL="CREATE TABLE IF NOT EXISTS managed_audio_component_runs (id TEXT PRIMARY KEY,budget_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,source_sha TEXT NOT NULL,reserved_micros INTEGER NOT NULL CHECK(reserved_micros=5000000),model_used INTEGER NOT NULL DEFAULT 0 CHECK(model_used BETWEEN 0 AND 30),stt_used INTEGER NOT NULL DEFAULT 0 CHECK(stt_used BETWEEN 0 AND 30),tts_used INTEGER NOT NULL DEFAULT 0 CHECK(tts_used BETWEEN 0 AND 30),expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)";
export function componentCostBound(){
 // Input tokens <= UTF-8 bytes, plus fixed protocol overhead. No caching/discount credit.
 // Conservative rate ceilings: input $0.50/M, output $1.80/M; TTS $0.10/1K
 // characters; STT $0.50/hour (includes documented entity/keyterm extras conservatively).
 const l=COMPONENT_LIMITS,modelPerRequest=Math.ceil((l.inputBytes+l.inputTokenOverhead)*0.5+l.outputTokens*1.8),ttsPerRequest=l.ttsCharacters*100,sttPerRequest=Math.ceil(Math.ceil(l.inputSeconds/60)*60*500000/3600);
 const totalMicros=l.requestsPerKind*(modelPerRequest+ttsPerRequest+sttPerRequest);
 if(totalMicros>l.capMicros)throw Error('component_budget_unbounded');
 return {currency:'USD',modelPerRequest,ttsPerRequest,sttPerRequest,totalMicros,hardReservationMicros:l.capMicros,headroomMicros:l.capMicros-totalMicros,ratesExpireAt:l.ratesExpireAt,sources:['https://developers.openai.com/api/docs/models/gpt-5.6-luna','https://elevenlabs.io/pricing/api'],includedDiscountApplied:false,taxesOrRegionalSurcharges:'must remain within conservative rate ceilings; no unknown extras authorized'};
}
export async function startComponentLease(db,sourceSha,now=Date.now()){
 if(!/^[a-f0-9]{40}$/.test(sourceSha)||now>=COMPONENT_LIMITS.ratesExpireAt)throw Error('component_source_or_rates_invalid');
 await db.batch([db.prepare(COMPONENT_BUDGET_DDL),db.prepare(COMPONENT_RUN_DDL),db.prepare('INSERT OR IGNORE INTO managed_audio_test_budget(id,cap_micros,reserved_micros) VALUES (?,5000000,0)').bind(COMPONENT_BUDGET_ID)]);
 const id=randomUUID(),reservation=randomUUID(),expiry=Math.min(now+COMPONENT_LIMITS.leaseMs,COMPONENT_LIMITS.ratesExpireAt);
 const result=await db.batch([
 db.prepare('INSERT INTO managed_audio_component_runs(id,budget_id,reservation_id,source_sha,reserved_micros,expires_at,created_at) SELECT ?,?,?,?,5000000,?,? WHERE EXISTS(SELECT 1 FROM managed_audio_test_budget WHERE id=? AND cap_micros=5000000 AND reserved_micros=0)').bind(id,COMPONENT_BUDGET_ID,reservation,sourceSha,expiry,now,COMPONENT_BUDGET_ID),
 db.prepare('UPDATE managed_audio_test_budget SET reserved_micros=reserved_micros+5000000 WHERE id=? AND EXISTS(SELECT 1 FROM managed_audio_component_runs WHERE id=? AND reservation_id=?)').bind(COMPONENT_BUDGET_ID,id,reservation),
 ]);
 if(Number(result[0]?.meta?.changes)!==1||Number(result[1]?.meta?.changes)!==1)throw Error('component_shared_budget_already_reserved');
 return {id,sourceSha,expiresAt:expiry,reservedMicros:5000000};
}
export async function resumeComponentLease(db,id,sourceSha,now=Date.now()){
 if(!/^[0-9a-f-]{36}$/.test(id)||!/^[a-f0-9]{40}$/.test(sourceSha)||now>=COMPONENT_LIMITS.ratesExpireAt)throw Error('component_resume_invalid');
 const row=await db.prepare('SELECT r.* FROM managed_audio_component_runs r JOIN managed_audio_test_budget b ON b.id=r.budget_id WHERE r.id=? AND r.source_sha=? AND r.expires_at>? AND r.budget_id=? AND r.reserved_micros=5000000 AND b.cap_micros=5000000 AND b.reserved_micros=5000000').bind(id,sourceSha,now,COMPONENT_BUDGET_ID).first();
 if(!row)throw Error('component_lease_missing_expired_or_wrong_source');
 return {id,sourceSha,expiresAt:row.expires_at,reservedMicros:5000000};
}
export async function claimComponentRequest(db,lease,kind,now=Date.now()){
 if(!['model','stt','tts'].includes(kind)||now>=COMPONENT_LIMITS.ratesExpireAt)throw Error('component_request_invalid');
 const column=kind+'_used';
 const r=await db.prepare(`UPDATE managed_audio_component_runs SET ${column}=${column}+1 WHERE id=? AND source_sha=? AND expires_at>? AND ${column}<30 AND budget_id=? AND reserved_micros=5000000 AND EXISTS(SELECT 1 FROM managed_audio_test_budget b WHERE b.id=managed_audio_component_runs.budget_id AND b.cap_micros=5000000 AND b.reserved_micros=5000000)`).bind(lease.id,lease.sourceSha,now,COMPONENT_BUDGET_ID).run();
 if(Number(r.meta?.changes)!==1)throw Error('component_request_cap_or_lease_refused');
}
export async function readComponentBytes(response,maxBytes){
 if(!response.ok){void response.body?.cancel().catch(()=>{});throw Error('component_provider_http_'+response.status);}
 const reader=response.body?.getReader();if(!reader)throw Error('component_response_missing');let size=0;const chunks=[];
 for(;;){const x=await reader.read();if(x.done)break;size+=x.value.byteLength;if(size>maxBytes){void reader.cancel().catch(()=>{});throw Error('component_response_too_large');}chunks.push(x.value);}
 return Buffer.concat(chunks,size);
}
export function validateComponentModelRequest(body){
 const l=COMPONENT_LIMITS;
 if(body.model!=='gpt-5.6-luna'||body.max_output_tokens>l.outputTokens||body.max_output_tokens<1||body.store!==false||body.stream||body.reasoning?.effort!=='none'||typeof body.instructions!=='string'||typeof body.input!=='string'||Buffer.byteLength(body.instructions,'utf8')+Buffer.byteLength(body.input,'utf8')>l.inputBytes||body.tools||body.previous_response_id)throw Error('component_model_request_unbounded');
}
export function componentNetworkGuard({fetcher,claim,region,voiceId,onRequest=()=>{}}){
 if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(region)||!voiceId)throw Error('component_provider_configuration_invalid');
 let modelSent=false;
 return {beginTurn(){modelSent=false;},async fetch(url,init={}){
  const u=new URL(String(url));let kind;
  init={...init,redirect:init.redirect??'error'};
  init={...init,redirect:init.redirect??'error'};
  if(init.method!=='POST'||init.redirect!=='error')throw Error('component_network_route_refused');
  if(u.href==='https://api.openai.com/v1/responses'){
   kind='model';validateComponentModelRequest(JSON.parse(init.body));
   if(modelSent)return new Response('component_model_retry_suppressed',{status:403});modelSent=true;
  }else if(u.origin===region&&u.pathname==='/v1/speech-to-text'&&!u.search){
   kind='stt';const f=init.body;if(!(f instanceof FormData)||f.get('model_id')!=='scribe_v2'||!(f.get('file') instanceof Blob)||f.get('file').size>44+COMPONENT_LIMITS.inputRate*2*COMPONENT_LIMITS.inputSeconds||f.get('cloud_storage_url')||f.get('webhook')!=='false'||f.get('entity_detection')||f.get('keyterms')||f.get('diarize')!=='false')throw Error('component_stt_request_unbounded');
   const wav=Buffer.from(await f.get('file').arrayBuffer());if(wav.length<3244||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'||wav.toString('ascii',12,16)!=='fmt '||wav.readUInt32LE(16)!==16||wav.readUInt16LE(20)!==1||wav.readUInt16LE(22)!==1||wav.readUInt32LE(24)!==16000||wav.readUInt16LE(34)!==16||wav.toString('ascii',36,40)!=='data'||wav.readUInt32LE(40)!==wav.length-44)throw Error('component_stt_audio_invalid');
  }else if(u.origin===region&&u.pathname==='/v1/text-to-speech/'+encodeURIComponent(voiceId)+'/stream'&&u.search==='?output_format=pcm_16000'){
   kind='tts';const b=JSON.parse(init.body);if(b.model_id!=='eleven_multilingual_v2'||typeof b.text!=='string'||!b.text.length||b.text.length>COMPONENT_LIMITS.ttsCharacters||Object.keys(b).some(k=>!['model_id','text'].includes(k)))throw Error('component_tts_request_unbounded');
  }else throw Error('component_network_route_refused');
  await claim(kind);onRequest(kind);return fetcher(url,init);
 }};
}
