import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {COMPONENT_LIMITS as L,componentCostBound,startComponentLease,resumeComponentLease,claimComponentRequest,readComponentBytes,componentNetworkGuard} from './component-audio-control.mjs';
import {COMPONENT_SCENARIOS} from './component-audio-scenarios.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function componentWav(pcm){
 if(!Buffer.isBuffer(pcm)||pcm.length%2)throw Error('component_pcm_invalid');
 const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);
}
export function componentCallerAudio(text,execute=execFileSync){
 if(!COMPONENT_SCENARIOS.some(s=>s.turns.includes(text)))throw Error('component_fixed_caller_fixture_required');
 const wav=execute('espeak-ng',['--stdout','-s','160',text],{timeout:10000,maxBuffer:4*1024*1024});
 const pcm=execute('ffmpeg',['-loglevel','error','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'],{input:wav,timeout:10000,maxBuffer:4*1024*1024});
 if(!Buffer.isBuffer(pcm)||pcm.length<3200||pcm.length>L.inputSeconds*32000||pcm.length%2)throw Error('component_caller_duration_invalid');
 return componentWav(pcm);
}
export async function componentSourceFingerprint(directory){
 const files=[];async function walk(path){for(const e of await readdir(resolve(directory,path),{withFileTypes:true})){const p=path+'/'+e.name;if(e.isDirectory())await walk(p);else if(e.isFile()&&/\.(?:ts|tsx|mjs|js|cjs)$/.test(p))files.push(p);}}
 await walk('lib');await walk('tests/helpers');files.sort();const digest=createHash('sha256');for(const p of files)digest.update(p+'\0'+hash(await readFile(resolve(directory,p)))+'\n');return {files:files.length,sha256:digest.digest('hex')};
}
export async function remoteComponentLedger(env,fetcher=fetch){
 for(const k of ['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_API_TOKEN','STAGING_D1_ID','PRODUCTION_D1_ID'])if(!env[k])throw Error('component_missing_existing_binding:'+k);
 if(env.STAGING_D1_ID===env.PRODUCTION_D1_ID||!/^[a-zA-Z0-9-]{20,64}$/.test(env.STAGING_D1_ID)||!/^[a-zA-Z0-9]{20,64}$/.test(env.CLOUDFLARE_ACCOUNT_ID))throw Error('component_database_identity_invalid');
 const origin='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)+'/d1/database/'+encodeURIComponent(env.STAGING_D1_ID);
 async function api(payload){
  const r=await fetcher(origin+(payload?'/query':''),{method:payload?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),redirect:'error',signal:AbortSignal.timeout(15000)});
  const x=JSON.parse((await readComponentBytes(r,512*1024)).toString());if(x.success!==true||payload&&(!Array.isArray(x.result)||x.result.some(y=>y.success===false)))throw Error('component_ledger_refused');return x.result;
 }
 const metadata=await api();if(metadata.name!=='pawspace-staging'||metadata.uuid!==env.STAGING_D1_ID)throw Error('component_staging_ledger_not_verified');
 const statement=(sql,params=[])=>{
  if(!/\bmanaged_audio_(?:test_budget|component_runs)\b/.test(sql)||/\b(?:canonical_|communication_|ai_voice_|DROP|DELETE|ALTER|TRUNCATE|ATTACH)\b/i.test(sql))throw Error('component_ledger_sql_scope_refused');
  return {sql,params,bind:(...p)=>statement(sql,p),run:async()=>(await api({sql,params}))[0],first:async()=>(await api({sql,params}))[0]?.results?.[0]??null};
 };
 return {prepare:statement,batch:async items=>api({batch:items.map(({sql,params})=>({sql,params}))})};
}
export async function readComponentVoice(env,fetcher=fetch){
 const region=String(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
 if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(region)||!env.ELEVENLABS_API_KEY)throw Error('component_existing_speech_configuration_missing');
 const r=await fetcher(region+'/v1/voices',{method:'GET',headers:{'xi-api-key':env.ELEVENLABS_API_KEY},redirect:'error',signal:AbortSignal.timeout(15000)});
 const list=JSON.parse((await readComponentBytes(r,512*1024)).toString());
 const candidates=(list.voices||[]).filter(v=>v.category==='premade'&&!v.sharing?.financial_rewards_enabled&&(!v.sharing||v.sharing.rate===0&&v.sharing.fiat_rate===0)&&typeof v.voice_id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v.voice_id));
 const voice=candidates.find(v=>v.voice_id===env.ELEVENLABS_TTS_VOICE_ID)||candidates.find(v=>v.labels?.gender==='female')||candidates[0];
 if(!voice)throw Error('component_no_existing_standard_premade_voice_no_fee_bound');
 return {region,voiceId:voice.voice_id,receipt:{region,category:'premade',voiceIdSha256:hash(voice.voice_id),nativeAgentVoiceTested:false,voiceConfigSha256:hash(JSON.stringify(voice)),libraryFinancialRewardsEnabled:false}};
}
export async function runComponentScenario({scenario,brain,guard,voice,key,outputRoot,makeCaller=componentCallerAudio}){
 const directory=resolve(outputRoot,scenario.service);await mkdir(directory,{recursive:true});const chunks=[],turns=[];
 for(const [index,text] of scenario.turns.entries()){
  const row={index,fixtureText:text,audioListened:false,status:'started'};turns.push(row);guard.beginTurn();
  try{
   const caller=makeCaller(text),callerPcm=caller.subarray(44);await writeFile(resolve(directory,`turn-${index+1}-caller.wav`),caller);chunks.push(callerPcm,Buffer.alloc(3200));row.callerAudioSha256=hash(caller);row.callerAudioSeconds=callerPcm.length/32000;
   const f=new FormData();f.set('model_id','scribe_v2');f.set('file',new Blob([caller],{type:'audio/wav'}),'synthetic-caller.wav');f.set('webhook','false');f.set('diarize','false');
   let began=Date.now();const stt=await guard.fetch(voice.region+'/v1/speech-to-text',{method:'POST',body:f,headers:{'xi-api-key':key},redirect:'error',signal:AbortSignal.timeout(L.deadlineMs)});
   const recognized=JSON.parse((await readComponentBytes(stt,128*1024)).toString());row.sttMs=Date.now()-began;if(typeof recognized.text!=='string'||!recognized.text.trim()||Buffer.byteLength(recognized.text)>4096)throw Error('component_stt_text_invalid');row.recognizedText=recognized.text;
   began=Date.now();const reply=await brain.turn(scenario.service,recognized.text);row.brainMs=Date.now()-began;row.brain={path:reply.path,modelRef:reply.modelRef,providerRef:reply.providerRef,timings:reply.timings};row.reply=reply.output;
   if(typeof row.reply!=='string'||!row.reply.trim()||row.reply.length>L.ttsCharacters)throw Error('component_reply_missing_or_over_character_cap');
   began=Date.now();const audio=await guard.fetch(voice.region+'/v1/text-to-speech/'+encodeURIComponent(voice.voiceId)+'/stream?output_format=pcm_16000',{method:'POST',body:JSON.stringify({text:row.reply,model_id:'eleven_multilingual_v2'}),headers:{'content-type':'application/json','xi-api-key':key},redirect:'error',signal:AbortSignal.timeout(L.deadlineMs)});row.ttsHeadersMs=Date.now()-began;
   const pcm=await readComponentBytes(audio,8*1024*1024);row.ttsCompleteMs=Date.now()-began;if(pcm.length<3200||pcm.length%2)throw Error('component_audio_invalid');let nonSilent=0;for(let i=0;i<pcm.length;i+=2)if(Math.abs(pcm.readInt16LE(i))>64)nonSilent++;if(!nonSilent)throw Error('component_audio_silent');row.agentAudioBytes=pcm.length;row.agentAudioSha256=hash(pcm);row.nonSilentSamples=nonSilent;
   await writeFile(resolve(directory,`turn-${index+1}-agent.wav`),componentWav(pcm));chunks.push(pcm,Buffer.alloc(3200));row.status='actual_component_audio_captured';
  }catch(e){row.status='failed';row.failure=e instanceof Response?'application_refused_'+e.status:/^component_[a-zA-Z0-9_:]+$/.test(String(e?.message))?e.message:'component_turn_refused';}
  await writeFile(resolve(directory,'turns.json'),JSON.stringify(turns,null,2)+'\n');await writeFile(resolve(directory,'conversation.wav'),componentWav(Buffer.concat(chunks)));
 }
 return {service:scenario.service,status:turns.every(x=>x.status==='actual_component_audio_captured')?'actual_component_conversation_captured':'incomplete',turns,conversationAudio:'conversation.wav',timeline:'alternating captured caller/agent audio, 100ms separators; not native timing',heard:false,nativeStreamingInterruptionTested:false,productionPersistenceTested:false};
}
export async function mainComponentAudio(env=process.env){
 const root=resolve('artifacts/component-audio');await mkdir(root,{recursive:true});const report={scope:'synthetic local application STT/brain/TTS component test',nativeAgentAcceptance:false,nativeStreamingInterruptionTested:false,productionPersistenceTested:false,heard:false,budget:componentCostBound(),scenarios:[],paidRequests:{model:0,stt:0,tts:0},phase:'preflight'};let brain;const originalFetch=globalThis.fetch;
 try{
  if(env.COMPONENT_AUDIO_CONFIRM!=='component-audio-bounded')throw Error('component_exact_execution_mode_required');if(!env.PAWSPACE_OPENAI_API_KEY||!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))throw Error('component_existing_key_or_pinned_source_missing');
  const expected=JSON.parse(await readFile(new URL('./component-audio-source.json',import.meta.url),'utf8')),actual=await componentSourceFingerprint(resolve(fileURLToPath(new URL('..',import.meta.url))));if(actual.sha256!==expected.sha256||actual.files!==expected.files)throw Error('component_reviewed_brain_source_changed');report.applicationSource=expected;
  const voice=await readComponentVoice(env,originalFetch);report.speech=voice.receipt;const db=await remoteComponentLedger(env,originalFetch),scope=env.COMPONENT_AUDIO_SCOPE||'grooming-first';if(!['grooming-first','five-services','resume-other-services','retest-grooming'].includes(scope))throw Error('component_scope_invalid');
  // No provider generation occurs before the durable shared $5 reservation. Resume never resets.
  const lease=env.COMPONENT_AUDIO_RUN_ID?await resumeComponentLease(db,env.COMPONENT_AUDIO_RUN_ID,env.GITHUB_SHA):await startComponentLease(db,env.GITHUB_SHA);report.lease=lease;
  const guard=componentNetworkGuard({fetcher:originalFetch,region:voice.region,voiceId:voice.voiceId,claim:kind=>claimComponentRequest(db,lease,kind),onRequest:kind=>report.paidRequests[kind]++});globalThis.fetch=guard.fetch;
  brain=await(await import('./component-audio-brain.mjs')).createComponentBrain({PAWSPACE_OPENAI_API_KEY:env.PAWSPACE_OPENAI_API_KEY});report.phase='running';const scenarios=scope==='five-services'?COMPONENT_SCENARIOS:scope==='resume-other-services'?COMPONENT_SCENARIOS.slice(1):[COMPONENT_SCENARIOS[0]];
  for(const scenario of scenarios){report.scenarios.push(await runComponentScenario({scenario,brain,guard,voice,key:env.ELEVENLABS_API_KEY,outputRoot:root}));await writeFile(resolve(root,'state.json'),JSON.stringify(brain.snapshot(),null,2)+'\n');await writeFile(resolve(root,'summary.json'),JSON.stringify(report,null,2)+'\n');}
  report.counters=await db.prepare('SELECT model_used,stt_used,tts_used,expires_at FROM managed_audio_component_runs WHERE id=?').bind(lease.id).first();report.consumedUpperMicros=report.counters.model_used*report.budget.modelPerRequest+report.counters.stt_used*report.budget.sttPerRequest+report.counters.tts_used*report.budget.ttsPerRequest;report.actualProviderBilledCost='not established; conservative consumed bound reported';report.phase='finished';
 }catch(e){report.phase='blocked';report.gate=/^component_[a-zA-Z0-9_:]+$/.test(String(e?.message))?e.message:'component_preflight_or_execution_refused';process.exitCode=1;}
 finally{globalThis.fetch=originalFetch;brain?.close();await writeFile(resolve(root,'summary.json'),JSON.stringify(report,null,2)+'\n');await writeFile(resolve(root,'listening-review.json'),JSON.stringify({heard:false,completeConversationReviewed:false,scope:report.scope,excluded:['native streaming','native interruptions','handset playback','production persistence','real booking completion'],scores:{recognition:null,naturalness:null,latency:null,groundedPricing:null,appOnlyPolicy:null,bookingTruth:null,duplicateConsent:null},instructions:'Listen to conversation.wav and per-turn actual caller/agent WAVs; compare recognized text, reply, stage latency and local fixture tool/state receipts. Fill scores only after hearing recordings.'},null,2)+'\n');console.log(JSON.stringify({phase:report.phase,gate:report.gate,paidRequests:report.paidRequests,scenarios:report.scenarios.map(s=>({service:s.service,status:s.status})),heard:false}));}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await mainComponentAudio();
