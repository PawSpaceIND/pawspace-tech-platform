// Select the isolated service model, optionally delaying repetitive static filler. Never enable phone transport.
import {isDeepStrictEqual} from 'node:util';
import {pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {readDemoJson} from './voice-demo-output-boundary.mjs';
import {assertDemoPhonePauseMetadata,assertDemoRuntimePhonePause} from './voice-demo-scenarios.mjs';
const origin='https://pawspace-staging.karthik-fce.workers.dev';
export function serviceModelPatch(current,tuneFiller=false){
 const agent=current?.conversation_config?.agent,prompt=agent?.prompt,llm=prompt?.custom_llm;
 if(prompt?.llm!=='custom-llm'||llm?.url!==origin+'/api/elevenlabs/v1'||llm?.api_type!=='responses'||!['pawspace-grooming-sales','pawspace-service-sales'].includes(llm?.model_id))throw Error('Known isolated staging sales agent required');
 return {conversation_config:{agent:{...agent,prompt:{...prompt,custom_llm:{...llm,model_id:'pawspace-service-sales'}}},...(tuneFiller?{turn:{...current.conversation_config.turn,soft_timeout_config:{...current.conversation_config.turn?.soft_timeout_config,timeout_seconds:8}}}:{})}};
}
export function verifyServiceModelChange(before,after,tuneFiller=false){
 serviceModelPatch(after);if(after.conversation_config.agent.prompt.custom_llm.model_id!=='pawspace-service-sales')throw Error('Multi-service selector did not persist');
 const normalized=structuredClone(after.conversation_config);normalized.agent.prompt.custom_llm.model_id=before.conversation_config.agent.prompt.custom_llm.model_id;
 if(tuneFiller){if(after.conversation_config.turn?.soft_timeout_config?.timeout_seconds!==8)throw Error('Filler threshold did not persist');normalized.turn=structuredClone(before.conversation_config.turn);const expected={...before.conversation_config.turn,soft_timeout_config:{...before.conversation_config.turn?.soft_timeout_config,timeout_seconds:8}};if(!isDeepStrictEqual(after.conversation_config.turn,expected))throw Error('Unexpected turn setting change');}
 if(!isDeepStrictEqual(normalized,before.conversation_config))throw Error('Unexpected agent configuration change; further testing stopped');return true;
}
export async function selectStagingModel(env=process.env,request=fetch){
 if(!/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA||'')||!env.GROOMING_AGENT_ID||!env.ELEVENLABS_API_KEY)throw Error('Exact staging prerequisites missing');
 const eleven=(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
 if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(eleven))throw Error('Approved provider region required');
 const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
 async function get(url,headers,init={}){const r=await request(url,{...init,headers,signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok)throw Error('Staging configuration request refused: '+r.status);return {r,b};}
 const login=await get(origin+'/api/staging-login',{'content-type':'application/json',origin},{method:'POST',body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual'});
 const cookie=(login.r.headers.get('set-cookie')||'').split(';',1)[0];if(!cookie.startsWith('pawspace_uat='))throw Error('Staging authentication refused');
 async function isolation(){
  const {b}=await get(cf+'/workers/scripts/pawspace-staging/settings',{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN});
  if(b.success!==true)throw Error('Staging settings unavailable');const settings=b.result,bindings=settings.bindings||[];
  if(settings.annotations?.['workers/message']!=='staging '+env.EXPECTED_SHA||!env.STAGING_D1_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID||!bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID))throw Error('Exact isolated staging build required');
  const vars=Object.fromEntries(bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
  if(vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='true')throw Error('Sandbox payments required');assertDemoPhonePauseMetadata(vars);
  const readiness=await get(origin+'/api/voice-outbound',{cookie});assertDemoRuntimePhonePause(vars,readiness.b.data?.gate);
 }
 await isolation();
 const coverage=(await get(origin+'/api/ai-business-configuration?mode=coverage',{cookie})).b.data;
 if(!Number.isInteger(coverage?.requiredTopics)||coverage.requiredTopics<1||coverage.activeTopics!==coverage.requiredTopics||coverage.sourceMatchedTopics!==coverage.requiredTopics)throw Error('Reviewed service knowledge is not fully active on staging');
 const url=eleven+'/v1/convai/agents/'+encodeURIComponent(env.GROOMING_AGENT_ID),headers={'xi-api-key':env.ELEVENLABS_API_KEY,'content-type':'application/json'};
 const tuneFiller=env.MAYA_TUNE_FILLER==='true',before=(await get(url,headers)).b,patch=serviceModelPatch(before,tuneFiller);
 if(before.conversation_config.agent.prompt.custom_llm.model_id!=='pawspace-service-sales'||tuneFiller&&before.conversation_config.turn?.soft_timeout_config?.timeout_seconds!==8)await get(url,headers,{method:'PATCH',body:JSON.stringify(patch)});
 const after=(await get(url,headers)).b;verifyServiceModelChange(before,after,tuneFiller);await isolation();
 const report={revision:env.EXPECTED_SHA,model:'pawspace-service-sales',onlyModelSelectorChanged:!tuneFiller,onlyModelAndFillerThresholdChanged:tuneFiller,softTimeoutSeconds:after.conversation_config.turn?.soft_timeout_config?.timeout_seconds??null,reviewedKnowledgeTopics:coverage.requiredTopics,phoneCallsPaused:true,dialed:false,productionChanged:false,premiumCertified:false};
 await mkdir('voice-model-results',{recursive:true});await writeFile('voice-model-results/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await selectStagingModel();
