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
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const report=await prepareNextAudioDuration();await mkdir('artifacts/agent-deadlines',{recursive:true});await writeFile('artifacts/agent-deadlines/native-duration.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
