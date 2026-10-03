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
export async function provisionNextAudioCeiling(env=process.env,request=fetch){
 const {validateAudioRateReceipt,NEXT_AUDIO_BUDGET_ID}=await import('../lib/next-audio-budget.ts');
 if(env.GITHUB_SHA!==env.EXPECTED_SHA||env.GITHUB_RUN_ATTEMPT!=='1'||!env.NEXT_AUDIO_RATE_RECEIPT_JSON||!env.CLOUDFLARE_API_TOKEN||!env.CLOUDFLARE_ACCOUNT_ID||!env.STAGING_D1_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Pinned trusted ceiling prerequisites missing');
 const receipt=JSON.parse(env.NEXT_AUDIO_RATE_RECEIPT_JSON);validateAudioRateReceipt(receipt,Date.now());
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
