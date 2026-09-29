// Explicit post-call participant report. Does not dial, activate voice or enable recording.
import { pathToFileURL } from 'node:url';
import { ATTENDED_HANDSET_STATEMENT } from '../lib/voice-handset-evidence.ts';
import { handsetVerifierConfig, singleHandsetTester } from './voice-handset-preflight.mjs';
import { verifyHandsetAttempt } from './verify-handset-attempt.mjs';
const origin='https://pawspace-staging.karthik-fce.workers.dev';
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
export async function verifyAttendedHandset(env, options={}) {
 handsetVerifierConfig(env);
 const phone=singleHandsetTester(env),appCallId=env.UAT_VOICE_CALL_ID;
 const useCase=env.SPECIALIST_USE_CASE;
 if(!['grooming_sales','training_sales'].includes(useCase))throw Error('Exact specialist use case required');
 const agentId=useCase==='grooming_sales'?env.GROOMING_AGENT_ID:env.TRAINING_AGENT_ID;
 const recordedBy=env.GITHUB_ACTOR;
 if(!identifier(appCallId)||!identifier(agentId)||!identifier(recordedBy))throw Error('Exact call, agent and reporting operator required');
 if(env.ATTENDED_STATEMENT!==ATTENDED_HANDSET_STATEMENT)throw Error('Explicit participant statement required; it must not be inferred');
 const stamp=env.ATTENDED_REPORTED_AT;
 if(typeof stamp!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(stamp))throw Error('Participant report time must be explicit UTC');
 const reportedAtMs=Date.parse(stamp),now=Date.now();
 if(!Number.isSafeInteger(reportedAtMs)||reportedAtMs>now||now-reportedAtMs>86400000)throw Error('Participant report time is not current');
 if(typeof env.PAWSPACE_UAT_ACCESS_CODE!=='string'||!env.PAWSPACE_UAT_ACCESS_CODE.trim())throw Error('Staging access prerequisite missing');
 const request=options.fetchImpl||fetch;
 const login=await request(origin+'/api/staging-login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(12000)});
 const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];
 if(login.status!==200||!/^pawspace_uat=[^\r\n;]+$/.test(cookie))throw Error('Staging staff login refused');
 const attendedReport={schemaVersion:1,source:'participant_report',participant:'recipient',appCallId,recordedBy,reportedAtMs,statement:env.ATTENDED_STATEMENT};
 const result=await verifyHandsetAttempt({appCallId,agentId,phone,cookie},env,{fetchImpl:request,maxAttempts:15,delay:options.delay,attendedReport});
 if(!result.attendedPassed)throw Error('Attended exchange is not verified');
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 verifyAttendedHandset(process.env).then(result=>console.log('HANDSET_ATTENDED_RESULT='+JSON.stringify(result))).catch(error=>{
  console.error(String(error?.message||'Attended verification failed'));process.exitCode=1;
 });
}
