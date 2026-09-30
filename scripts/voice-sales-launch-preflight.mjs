// Fresh-launch inspection. Never dials, changes customer data, or grants a policy override.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {singleHandsetTester} from './voice-handset-preflight.mjs';
import {testerCandidateQuery,resolveTesterCustomer} from './voice-app-tester.mjs';
export function authorizedLaunchTester(env){
 const phone=singleHandsetTester(env),expected=String(env.EXPECTED_TESTER_SHA256||'');
 const actual=createHash('sha256').update(phone.replace(/\D/g,'').slice(-10)).digest('hex');
 if(!/^[a-f0-9]{64}$/.test(expected)||actual!==expected)throw Error('The configured tester does not match the authorized recipient');
 return phone;
}
export async function inspectVoiceSalesLaunch(env=process.env,request=fetch){
 const phone=authorizedLaunchTester(env),origin='https://pawspace-staging.karthik-fce.workers.dev';
 const base=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.STAGING_D1_ID)}`;
 const cloudHeaders={authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
 async function cloud(url,init={}){const response=await request(url,{headers:cloudHeaders,...init,signal:AbortSignal.timeout(30000)});const body=await response.json();if(!response.ok||!body.success)throw Error('Staging evidence read failed');return body.result;}
 const metadata=await cloud(base);if(metadata?.name!=='pawspace-staging')throw Error('Isolated staging database not verified');
 const result=await cloud(base+'/query',{method:'POST',body:JSON.stringify(testerCandidateQuery(phone))});
 if(!Array.isArray(result)||result.some(row=>row.success===false))throw Error('Tester ownership read failed');
 const customerId=resolveTesterCustomer(result.flatMap(row=>row.results||[]),phone);
 const login=await request(origin+'/api/staging-login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
 const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];if(!login.ok||!cookie.startsWith('pawspace_uat='))throw Error('Staging founder authentication refused');
 const headers={cookie,origin,'content-type':'application/json'};
 const readiness=await request(origin+'/api/voice-outbound',{headers,signal:AbortSignal.timeout(30000)});const rb=await readiness.json();if(!readiness.ok||rb.data?.gate?.mode!=='uat')throw Error('UAT voice environment is not verified');
 const policy=await request(origin+'/api/voice-outbound',{method:'POST',headers,body:JSON.stringify({action:'policy_preview',useCase:'grooming_sales',phone,customerId,cityId:'blr'}),signal:AbortSignal.timeout(30000)});const pb=await policy.json();
 const evidence={customerId,destinationLast4:phone.slice(-4),mode:rb.data.gate.mode,enabled:rb.data.gate.enabled===true,provider:rb.data.transport?.provider||null,policyAllowed:policy.ok&&pb.data?.allowed===true,blockedBy:pb.data?.blockedBy||(!policy.ok?`http_${policy.status}`:null),dialed:false};
 console.log('VOICE_SALES_LAUNCH_PREFLIGHT='+JSON.stringify(evidence));
 if(!evidence.enabled||!evidence.policyAllowed)throw Error('Existing voice policy has not cleared this UAT call');
 return evidence;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await inspectVoiceSalesLaunch();
