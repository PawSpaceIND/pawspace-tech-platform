import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {readDemoJson} from './voice-demo-output-boundary.mjs';
export async function prepareNextAudioDuration(env=process.env,request=fetch){
 const region=String(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,''),id=env.GROOMING_AGENT_ID,key=env.ELEVENLABS_API_KEY;
 if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(region)||!key||!id||!env.EXPECTED_SHA||env.GITHUB_SHA!==env.EXPECTED_SHA||env.GITHUB_RUN_ATTEMPT!=='1')throw Error('Pinned native-duration preparation prerequisites missing');
 const url=region+'/v1/convai/agents/'+encodeURIComponent(id),headers={'xi-api-key':key,'content-type':'application/json'};
 async function get(){const r=await request(url,{headers,method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Native agent read refused ('+r.status+')');return readDemoJson(r);}
 const before=await get();
 if(before.conversation_config?.agent?.prompt?.custom_llm?.url!=='https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1')throw Error('Exact isolated staging brain required');
 const previousDuration=before.conversation_config?.conversation?.max_duration_seconds;
 if(!Number.isInteger(previousDuration)||previousDuration<60||previousDuration>7200)throw Error('Native duration is unproven');
 if(previousDuration!==120){const r=await request(url,{method:'PATCH',headers,body:JSON.stringify({conversation_config:{conversation:{...before.conversation_config.conversation,max_duration_seconds:120}}}),redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Native duration update refused ('+r.status+')');}
 const after=await get();
 if(after.conversation_config?.conversation?.max_duration_seconds!==120||after.conversation_config?.agent?.prompt?.custom_llm?.url!=='https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1')throw Error('Native hard duration readback failed');
 return {sourceSha:env.EXPECTED_SHA,region,previousDuration,providerHardDurationSeconds:120,configurationChanged:previousDuration!==120,agentConfigSha256:createHash('sha256').update(JSON.stringify(after)).digest('hex'),paidGenerationRequests:0,phoneDialed:false,paidExecutionAllowed:false,remainingGate:'Account charge-ceiling receipt and exact guarded lease readiness are still required'};
}

export async function inspectNextAudioStoredState(env=process.env,request=fetch){
 if(env.GITHUB_SHA!==env.EXPECTED_SHA||env.GITHUB_RUN_ATTEMPT!=='1'||!env.CLOUDFLARE_API_TOKEN||!env.CLOUDFLARE_ACCOUNT_ID||!env.STAGING_D1_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Pinned isolated read-only diagnostic required');
 const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
 async function cf(path,body){const r=await request(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok||b.success!==true)throw Error('Read-only diagnostic refused');return b.result;}
 if((await cf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID))).name!=='pawspace-staging')throw Error('Staging database required');
 const query=async(sql,params=[])=>{if(!sql.startsWith('SELECT '))throw Error('SELECT only');const r=await cf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql,params});if(r.some(x=>x.success===false))throw Error('Read-only SELECT failed');return r[0]?.results||[];};
 const id='next-ten-audio-additional-usd5-20261002',tables=new Set((await query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('next_audio_budget','next_audio_rate_evidence','next_audio_leases','next_audio_attempts','next_audio_speech_attempts','next_audio_batch_claims')")).map(x=>x.name));
 const expectedShapes={next_audio_budget:['id','cap_micros','reserved_micros','conversations','receipt_json','expires_at'],next_audio_rate_evidence:['id','region','receipt_json']},tableShapes={};
 for(const [table,expected] of Object.entries(expectedShapes)){if(!tables.has(table))continue;const names=(await query('SELECT name FROM pragma_table_info(?)',[table])).map(x=>x.name);tableShapes[table]={missingKnownColumns:expected.filter(x=>!names.includes(x)),unknownColumnCount:names.filter(x=>!expected.includes(x)).length};}
 const budget=tables.has('next_audio_budget')?(await query('SELECT cap_micros,reserved_micros,conversations,expires_at,receipt_json FROM next_audio_budget WHERE id=?',[id]))[0]:null;
 const evidence=tables.has('next_audio_rate_evidence')?(await query('SELECT receipt_json FROM next_audio_rate_evidence WHERE id=?',[id]))[0]:null;
 const parsed=x=>{try{return JSON.parse(x?.receipt_json||'null')}catch{return null}},br=parsed(budget),er=parsed(evidence),hash=x=>x?.receipt_json?createHash('sha256').update(x.receipt_json).digest('hex'):null;
 const receiptKeys=new Set(['currency','inclusiveOfFeesAndTaxes','sourceSha','agentConfigSha256','provider','model','validUntil','nativeMicrosPerMinute','optionalBatchMicros','inputMicrosPerToken','outputMicrosPerToken','framingTokenUpper','evidenceReference']);
 const differing=[...new Set([...Object.keys(br||{}),...Object.keys(er||{})])].filter(k=>JSON.stringify(br?.[k])!==JSON.stringify(er?.[k])),differentKeys=differing.filter(k=>receiptKeys.has(k)),unknownDifferentKeyCount=differing.length-differentKeys.length;
 const counts={};for(const table of ['next_audio_leases','next_audio_attempts','next_audio_speech_attempts','next_audio_batch_claims'])counts[table]=tables.has(table)?Number((await query('SELECT COUNT(*) AS n FROM '+table))[0]?.n||0):null;
 const telemetry=await cf('/workers/observability/telemetry/query',{queryId:'next-audio-readiness-runtime-error',dry:true,view:'events',limit:50,timeframe:{from:Date.parse('2026-10-03T05:19:30Z'),to:Date.parse('2026-10-03T05:20:00Z')},parameters:{filterCombination:'and',filters:[{key:'$workers.scriptName',operation:'eq',type:'string',value:'pawspace-staging'}]}}).catch(()=>null);
 const raw=JSON.stringify(telemetry||{}),signatures=['D1_ERROR','SQLITE_ERROR','Cannot perform I/O on behalf of a different request','TypeError','ReferenceError','next_audio_budget_receipt_already_pinned','next_audio_inclusive_rate_evidence_unproven'].filter(x=>raw.includes(x));
 const schemaNames=new Set(['next_audio_budget','next_audio_rate_evidence','next_audio_leases','next_audio_attempts','next_audio_speech_attempts','next_audio_batch_claims','canonical_customers','canonical_pets','customer_addresses','customer_account_mutations','ai_voice_calls','ai_voice_segments','ai_voice_events','communication_threads','communication_messages','id','thread_id','budget_id','customer_id','cap_micros','reserved_micros','conversations','receipt_json','expires_at','region','attempts','token','run_id','source_sha','claimed_at','kind','units','created_at','age_years','weight_kg','profile_json','source_pet_id','primary_phone','status','consent_status']);
 const matchedSchema=[...raw.matchAll(/no such (?:column|table):\s*([A-Za-z_][A-Za-z0-9_.]*)/g)].map(x=>x[1]),knownSchema=[...new Set(matchedSchema.filter(x=>schemaNames.has(x)))].slice(0,50),unknownSchemaMatchCount=matchedSchema.filter(x=>!schemaNames.has(x)).length;
 return {readOnly:true,budgetId:id,tableNames:[...tables],tableShapes,budgetPresent:Boolean(budget),evidencePresent:Boolean(evidence),budgetReceiptHash:hash(budget),evidenceReceiptHash:hash(evidence),exactEqual:Boolean(budget&&evidence&&budget.receipt_json===evidence.receipt_json),canonicalEqual:Boolean(br&&er&&differing.length===0),differentKeys,unknownDifferentKeyCount,budget:budget?{capMicros:budget.cap_micros,reservedMicros:budget.reserved_micros,conversations:budget.conversations,expiresAt:budget.expires_at}:null,counts,telemetry:{available:telemetry!==null,signatures,schemaNames:knownSchema,unknownSchemaMatchCount},paidGenerationRequests:0,phoneDialed:false};
}
export async function provisionNextAudioCeiling(env=process.env,request=fetch){
 const {validateAudioRateReceipt,NEXT_AUDIO_BUDGET_ID}=await import('../lib/next-audio-budget.ts');
 if(env.GITHUB_SHA!==env.EXPECTED_SHA||env.GITHUB_RUN_ATTEMPT!=='1'||!env.NEXT_AUDIO_RATE_RECEIPT_JSON||!env.CLOUDFLARE_API_TOKEN||!env.CLOUDFLARE_ACCOUNT_ID||!env.STAGING_D1_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Pinned trusted ceiling prerequisites missing');
 const receipt=JSON.parse(env.NEXT_AUDIO_RATE_RECEIPT_JSON);if(receipt?.readOnlyDiagnostic===true)return inspectNextAudioStoredState(env,request);validateAudioRateReceipt(receipt,Date.now());
 if(/UNIT TEST|invented/i.test(receipt.evidenceReference))throw Error('Reviewed live ceiling evidence required');
 const region=env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io';
 if(region!=='https://api.elevenlabs.io'&&region!=='https://api.in.residency.elevenlabs.io')throw Error('Exact provider region required');
 async function providerGet(){const r=await request(region+'/v1/convai/agents/'+encodeURIComponent(env.GROOMING_AGENT_ID),{headers:{'xi-api-key':env.ELEVENLABS_API_KEY},method:'GET',redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Agent configuration read refused');return readDemoJson(r);}
 const agent=await providerGet();
 if(agent.conversation_config?.agent?.prompt?.custom_llm?.url!=='https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1'||agent.conversation_config?.conversation?.max_duration_seconds!==120||createHash('sha256').update(JSON.stringify(agent)).digest('hex')!==receipt.agentConfigSha256)throw Error('Native config or 120-second enforcement changed');
 const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
 async function cf(path,body){const r=await request(base+path,{headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)}),data=await readDemoJson(r);if(!r.ok||data.success!==true)throw Error('Trusted staging administration refused');return data.result;}
 const db=await cf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)),settings=await cf('/workers/scripts/pawspace-staging/settings');
 const vars=Object.fromEntries(settings.bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
 const modelBinding=(name,value)=>settings.bindings.some(x=>x.name===name&&(x.type==='secret_text'||(x.type==='plain_text'&&(x.text??x.value)===value)));
 if(db.name!=='pawspace-staging'||settings.annotations?.['workers/message']!=='staging '+receipt.sourceSha||vars.PAWSPACE_STAGING_BUILD_SHA!==receipt.sourceSha||vars.PAWSPACE_DEPLOYMENT_ENV!=='staging'||vars.FORBID_PRODUCTION!=='true'||vars.PAWSPACE_VOICE_PHONE_TESTS_PAUSED!=='true'||vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED!=='false'||vars.PAWSPACE_RAZORPAYX_ENV!=='sandbox'||vars.PAWSPACE_RAZORPAYX_LIVE_APPROVED!=='false'||!modelBinding('PAWSPACE_AI_PROVIDER',receipt.provider)||!modelBinding('PAWSPACE_AI_VOICE_MODEL',receipt.model)||!settings.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID))throw Error('Exact staging runtime/isolation not proven');
 const query=(sql,params=[])=>cf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql,params});
 await query('CREATE TABLE IF NOT EXISTS next_audio_rate_evidence (id TEXT PRIMARY KEY,region TEXT NOT NULL,receipt_json TEXT NOT NULL)');
 await query('INSERT OR IGNORE INTO next_audio_rate_evidence (id,region,receipt_json) VALUES (?,?,?)',[NEXT_AUDIO_BUDGET_ID,region,JSON.stringify(receipt)]);
 const stored=(await query('SELECT region,receipt_json FROM next_audio_rate_evidence WHERE id=?',[NEXT_AUDIO_BUDGET_ID]))[0]?.results?.[0];
 if(stored?.region!==region||stored?.receipt_json!==JSON.stringify(receipt))throw Error('Ceiling already pinned differently; no overwrite or reset');
 // Secret bindings reveal names only. The authenticated runtime gate checks their actual values
 // against this trusted receipt before any batch claim or provider generation is possible.
 const origin='https://pawspace-staging.karthik-fce.workers.dev';
 if(!env.PAWSPACE_UAT_ACCESS_CODE)throw Error('Authenticated runtime readiness prerequisite missing');
 const login=await request(origin+'/api/staging-login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
 const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];
 if(login.status!==200||!/^pawspace_uat=[^\r\n;]+$/.test(cookie))throw Error('Authenticated runtime login refused');
 const ready=await request(origin+'/api/ai-voice-uat/audio-lease',{method:'GET',headers:{origin,cookie},redirect:'error',signal:AbortSignal.timeout(30000)}),readyBody=await readDemoJson(ready),data=readyBody.data;
 if(!ready.ok||data?.paidExecutionAllowed!==true||data.sourceSha!==receipt.sourceSha||data.agentConfigSha256!==receipt.agentConfigSha256||data.providerHardDurationSeconds!==120)throw Error('Actual runtime provider/model readiness refused: HTTP '+ready.status+' '+(/^[A-Za-z0-9_ .:-]{1,160}$/.test(String(readyBody.error||''))?readyBody.error:'unreported gate'));
 return {runtimeProviderModelVerified:true,inspectorCheckoutSha:env.GITHUB_SHA,sourceSha:receipt.sourceSha,agentConfigSha256:receipt.agentConfigSha256,budgetId:NEXT_AUDIO_BUDGET_ID,capUsd:10,trustedCeilingStored:true,paidGenerationRequests:0,phoneDialed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const provision=process.env.NEXT_AUDIO_RATE_RECEIPT_JSON!==undefined,report=provision?await provisionNextAudioCeiling():await prepareNextAudioDuration();await mkdir('artifacts/agent-deadlines',{recursive:true});await writeFile('artifacts/agent-deadlines/'+(provision?'trusted-ceiling':'native-duration')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
