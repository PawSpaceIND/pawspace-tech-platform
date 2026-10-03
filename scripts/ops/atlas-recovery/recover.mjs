import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {issueUatToken} from '../atlas-api-only/issue-uat-token.mjs';
const ORIGINAL='66d593c5-ce73-458e-925c-ca23c92c0934',TEMP='2b9f4ac0-8bc9-4449-848b-dd98e9e29758',SHA='c18b15caea9551505398746dc9335a962f17e8ae';
const crons=['*/5 * * * *','*/15 * * * *','15 2 * * *'];
const env=process.env,origin='https://pawspace-staging.karthik-fce.workers.dev';
const receipt={kind:'certified_staging_incident_recovery',modelRequests:0,operations:[],originalVersion:ORIGINAL,expectedServingSha:SHA,originalFailedRun:37148795839};
const save=()=>writeFileSync(env.EVIDENCE_PATH||'recovery-receipt.json',JSON.stringify(receipt,null,2)+'\n');
const check=(v,m)=>{if(!v)throw Error(m)};
const redact=s=>[env.CLOUDFLARE_API_TOKEN,env.CLOUDFLARE_ACCOUNT_ID,env.PAWSPACE_UAT_SIGNING_KEY].filter(Boolean).reduce((v,k)=>v.split(k).join('[redacted]'),String(s)).slice(0,1000);
const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/pawspace-staging`;
async function api(suffix,method='GET',body){
 const op={path:suffix,method,state:method==='GET'?'read_pending':'uncertain_before_dispatch'};receipt.operations.push(op);save();
 let r;try{r=await fetch(base+suffix,{method,headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{op.state=method==='GET'?'read_failed':'unknown_no_retry';save();throw Error('transport_unknown_'+suffix)}
 op.httpStatus=r.status;const p=await r.json().catch(()=>null);op.success=p?.success===true;op.errors=(p?.errors??[]).map(e=>({code:e.code,message:redact(e.message)}));
 if(!r.ok||p?.success!==true){op.state=p?.success===false?'rejected':method==='GET'?'read_failed':'unknown_no_retry';save();throw Error('http_'+r.status+'_'+suffix+'_'+JSON.stringify(op.errors))}
 op.state='confirmed';save();return p.result;
}
async function active(){const p=await api('/deployments');check(Array.isArray(p?.deployments)&&p.deployments.length>0,'deployments_shape');const d=p.deployments[0];check(d.versions?.length===1&&d.versions[0].percentage===100,'mixed_or_unknown_deployment');return{deploymentId:d.id,versionId:d.versions[0].version_id};}
async function schedules(){const p=await api('/schedules');const a=Array.isArray(p)?p:p?.schedules;check(Array.isArray(a),'schedules_shape');return a.map(x=>x.cron).sort();}
try{
 check(env.CONFIRM==='restore-certified-staging'&&env.GITHUB_RUN_ATTEMPT==='1'&&/^ops\/atlas-restore-/.test(env.GITHUB_REF_NAME??'')&&env.EXPECTED_SHA===env.GITHUB_SHA,'fixed_recovery_refused');
 check(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??'')&&env.CLOUDFLARE_API_TOKEN&&env.PAWSPACE_UAT_SIGNING_KEY,'existing_connection_missing');
 receipt.before=await active();receipt.schedulesBefore=await schedules();save();
 check([ORIGINAL,TEMP].includes(receipt.before.versionId),'unrelated_deployment_refused');
 if(receipt.before.versionId!==ORIGINAL){
  try{await api('/deployments','POST',{strategy:'percentage',versions:[{version_id:ORIGINAL,percentage:100}],annotations:{'workers/message':'Recover certified staging for attended human tests'}});}catch(error){receipt.restoreError=redact(error.message);receipt.afterFailedRestore=await active();save();if(receipt.afterFailedRestore.versionId!==ORIGINAL)throw error;receipt.restoreResultReconciled=true;}
 }
 receipt.after=await active();check(receipt.after.versionId===ORIGINAL,'certified_version_not_restored');save();
 if(JSON.stringify(receipt.schedulesBefore)!==JSON.stringify([...crons].sort()))await api('/schedules','PUT',crons.map(cron=>({cron})));
 receipt.schedulesAfter=await schedules();check(JSON.stringify(receipt.schedulesAfter)===JSON.stringify([...crons].sort()),'cron_restore_unproven');save();
 const cookie='pawspace_uat='+encodeURIComponent(await issueUatToken({PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY},'founder@pawspace.in',600));
 const get=async path=>{const r=await fetch(origin+path,{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(20000)});check(r.ok,'origin_'+r.status+'_'+path);return r;};
 const fixture=await(await get('/__staging/fixture-isolation?expectedSha='+SHA+'&scope=grooming_strict')).json();check(fixture.ok===true&&fixture.version?.id===ORIGINAL&&fixture.version?.buildSha===SHA,'restored_fixture_or_auth_failed');receipt.fixture={ok:true,versionId:fixture.version.id,buildSha:fixture.version.buildSha};
 const health=await(await get('/healthz')).json();check(health.status==='ok','health_failed');receipt.health=true;
 const favicon=Buffer.from(await(await get('/favicon.svg')).arrayBuffer());check(createHash('sha256').update(favicon).digest('hex')==='e6d2e59b7b5bbb0342e0fb496dfc262decbfe4426bbb7b047aec8d467d1dc6f7','assets_hash_failed');receipt.assets=true;
 const ui=await get('/staging-login');check((ui.headers.get('content-type')??'').includes('text/html'),'normal_ui_failed');receipt.ui=true;
 receipt.ok=true;receipt.completedAt=new Date().toISOString();receipt.schedulePropagation='API read confirms all3; edge propagation may take15minutes';save();console.log('Certified staging version,3crons,authenticated fixture,UI/assets/health restored.');
}catch(error){receipt.ok=false;receipt.failure=redact(error.message);save();console.error(receipt.failure);process.exitCode=1;}
