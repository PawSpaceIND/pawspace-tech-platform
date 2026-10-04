import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {issueUatToken} from '../atlas-api-only/issue-uat-token.mjs';
import {uploadMetadata,SQL} from '../atlas-api-only/runner.mjs';
import {sanitizeFixtureResponse} from './sanitize-fixture.mjs';
import {apiOnlyConfig} from '../atlas-api-only/make-api-only-config.mjs';
const env=process.env,origin='https://pawspace-staging.karthik-fce.workers.dev';
const normalSha='c18b15caea9551505398746dc9335a962f17e8ae',normalVersion='97c81f4d-f3fe-42d7-958f-1b175e66891b';
const job='Sentinel_f67e3c5a85f88191b07279e0edbe250c',database='1b879a28-c8a9-40b0-830d-1ce439061a00';
const bundleSha='fc38f8546f78b2177826fdf4c6a8f681ae8842b3626341fea9f01221ddda27fe';
const approvedAt=Date.parse(env.EXPLICIT_APPROVAL_UTC??'');
const receipt={kind:'approved_zero_model_fixture_diagnostic',approval:'user-approved-zero-model-20261004-044305',sameCumulativeCapMicros:6000000,modelDispatches:0,sessionClockStarted:false,noRetry:true,operations:[],originRequests:0,restorationRequired:false,restoreProcedure:'Normal deploy-staging.yml pinned c18b15ca followed by actual version/crons/fixture/UI/assets/health verification; sole release owner, no rollback'};
const hash=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const save=()=>writeFileSync(env.EVIDENCE_PATH||'session-receipt.json',JSON.stringify(receipt,null,2)+'\n',{flush:true});
const check=(v,m)=>{if(!v)throw Error(m)};
const redact=s=>[env.CLOUDFLARE_API_TOKEN,env.CLOUDFLARE_ACCOUNT_ID,env.PAWSPACE_UAT_SIGNING_KEY].filter(Boolean).reduce((v,k)=>v.split(k).join('[redacted]'),String(s)).slice(0,2000);
const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`,script=base+'/workers/scripts/pawspace-staging';
async function api(url,method='GET',body,phase='read',mutation=false){
 const op={phase,method,state:mutation?'uncertain_before_dispatch':'read_pending'};receipt.operations.push(op);save();
 let r;try{r=await fetch(url,{method,headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,...(body&&!(body instanceof FormData)?{'content-type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{op.state=mutation?'unknown_no_retry':'read_failed';save();throw Error(phase+'_transport_unknown_no_retry')}
 op.httpStatus=r.status;const p=await r.json().catch(()=>null);op.errors=(p?.errors??[]).map(x=>({code:x.code,message:redact(x.message)}));
 if(!r.ok||p?.success!==true){op.state=p?.success===false?'rejected':mutation?'unknown_no_retry':'read_failed';save();throw Error(phase+'_http_'+r.status+'_'+JSON.stringify(op.errors))}
 op.state='confirmed';save();return p.result;
}
async function query(name){const p=await api(base+'/d1/database/'+database+'/query','POST',{sql:SQL[name],params:[]},'select_'+name);check(p?.length===1&&p[0].success&&Array.isArray(p[0].results)&&p[0].results.length<=10000,'query_shape');check(p[0].meta.rows_written===0&&p[0].meta.changed_db===false,'read_only_query_required');receipt.nativeRowsRead=(receipt.nativeRowsRead||0)+p[0].meta.rows_read;check(receipt.nativeRowsRead<=1000000,'read_envelope');return p[0].results;}
async function originRequest(path,init={}){const url=new URL(origin+path);check(url.origin===origin&&url.pathname==='/__staging/fixture-isolation'&&(!init.method||init.method==='GET')&&++receipt.originRequests<=2,'zero_model_origin_envelope');return fetch(url,{...init,redirect:'manual',signal:AbortSignal.timeout(20000)});}
async function activeVersion(){const p=await api(script+'/deployments'),d=p?.deployments?.[0];check(d?.versions?.length===1&&d.versions[0].percentage===100,'deployment_shape');return d.versions[0].version_id;}
try{
 check(env.CONFIRM==='atlas-zero-model-revision-predicates'&&env.GITHUB_RUN_ATTEMPT==='1'&&/^ops\/atlas-session-/.test(env.GITHUB_REF_NAME??'')&&env.EXPECTED_SHA===env.GITHUB_SHA,'fixed_scope_refused');
 check(approvedAt===Date.parse('2026-10-04T04:43:05Z')&&Date.now()>=approvedAt&&Date.now()<Date.parse('2026-10-04T08:28:00Z'),'approved_diagnostic_readiness_refused');
 check(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??'')&&env.CLOUDFLARE_API_TOKEN&&env.PAWSPACE_UAT_SIGNING_KEY,'existing_connection_missing');
 const deployments=await api(script+'/deployments');const active=deployments?.deployments?.[0];check(active?.versions?.length===1&&active.versions[0].percentage===100&&active.versions[0].version_id===normalVersion,'normal_version_changed');receipt.beforeVersion=normalVersion;
 const schedules=await api(script+'/schedules');const crons=(Array.isArray(schedules)?schedules:schedules?.schedules)?.map(x=>x.cron).sort();check(JSON.stringify(crons)===JSON.stringify(['*/15 * * * *','*/5 * * * *','15 2 * * *']),'normal_crons_changed');receipt.beforeCrons=crons;
 const founder='pawspace_uat='+encodeURIComponent(await issueUatToken({PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY},'founder@pawspace.in',600));
 const fixture=async(sha)=>{const r=await originRequest('/__staging/fixture-isolation?expectedSha='+sha+'&scope=grooming_strict',{headers:{cookie:founder}});const p=await r.json().catch(()=>null);const safe=sanitizeFixtureResponse(r.status,p);receipt.fixtureReads??=[];receipt.fixtureReads.push({expectedSha:sha,...safe});save();return safe;};
 receipt.beforeFixture=await fixture(normalSha);check(receipt.beforeFixture.httpStatus===200&&receipt.beforeFixture.ok&&receipt.beforeFixture.version?.id===normalVersion&&receipt.beforeFixture.version?.buildSha===normalSha,'normal_fixture_refused');save();
 const beforeNormal=await query('normal'),beforeLedger=await query('ledger');receipt.before={normalDigest:hash(beforeNormal),normalRows:beforeNormal.length,ledgerDigest:hash(beforeLedger),ledgerRows:beforeLedger.length};
 check(beforeLedger.length===0,'prior_charge_or_uncertain_request_refused');save();
 const bundle=readFileSync(new URL('./atlas-api-review.js',import.meta.url));check(hash(bundle)===bundleSha,'bundle_changed');
 const vars={PAWSPACE_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_PRODUCTION_ENFORCE:'false',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_RAZORPAYX_ENV:'sandbox',PAWSPACE_RAZORPAYX_LIVE_APPROVED:'false',PAWSPACE_COMMUNICATION_ENV:'uat',PAWSPACE_VOICE_ENV:'disabled',PAWSPACE_STAGING_LIVE_CUSTOMER_OTP:'false',PAWSPACE_SCHEDULING_ENV:'uat',PAWSPACE_UAT_LOGIN:'on',PAWSPACE_AI_PROVIDER:'openai',PAWSPACE_AI_PROVIDER_MODEL:'gpt-5.6-terra',PAWSPACE_AI_EXECUTIVE_ACTIVE:'false',PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true'};
 const config=apiOnlyConfig({name:'pawspace-staging',compatibility_date:'2026-05-22',d1_databases:[{binding:'DB',database_id:database}],vars},{expectedD1:database,expectedSha:env.GITHUB_SHA,jobId:job,origin});
 receipt.restorationRequired=true;save();await api(script+'/schedules','PUT',[],'clear_schedules',true);
 const form=new FormData();form.set('metadata',new Blob([JSON.stringify(uploadMetadata(config))],{type:'application/json'}));form.set('atlas-api-review.js',new Blob([bundle],{type:'application/javascript+module'}),'atlas-api-review.js');await api(script,'PUT',form,'temporary_upload',true);
 receipt.activeAfterUpload=await activeVersion();check(receipt.activeAfterUpload!==normalVersion,'temporary_deployment_not_observed');save();
 receipt.temporaryFixture=await fixture(env.GITHUB_SHA);
 receipt.afterLedger=await query('ledger');check(receipt.afterLedger.length===0,'unexpected_Atlas_admission');
 receipt.diagnosticCaptured=receipt.temporaryFixture.code!==null;check(receipt.diagnosticCaptured,'sanitized_guard_code_missing');
 receipt.ok=true;receipt.completedAt=new Date().toISOString();save();console.log('ZERO_MODEL_GUARD_DIAGNOSTIC '+JSON.stringify(receipt.temporaryFixture));
}catch(error){receipt.ok=false;receipt.failure=redact(error.message);save();console.error(receipt.failure);process.exitCode=1;}
