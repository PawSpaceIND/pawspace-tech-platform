import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {issueUatToken} from '../atlas-api-only/issue-uat-token.mjs';
const ORIGINAL='f3205b4b-ca77-487a-b5fc-830fd84f9424',SHA='c18b15caea9551505398746dc9335a962f17e8ae';
const crons=['*/5 * * * *','*/15 * * * *','15 2 * * *'];
const env=process.env,origin='https://pawspace-staging.karthik-fce.workers.dev';
const receipt={kind:'certified_staging_read_only_verification',modelRequests:0,operations:[],originalVersion:ORIGINAL,expectedServingSha:SHA,normalRestoreRun:37181815772};
const save=()=>writeFileSync(env.EVIDENCE_PATH||'recovery-receipt.json',JSON.stringify(receipt,null,2)+'\n');
const check=(v,m)=>{if(!v)throw Error(m)};
const redact=s=>[env.CLOUDFLARE_API_TOKEN,env.CLOUDFLARE_ACCOUNT_ID,env.PAWSPACE_UAT_SIGNING_KEY].filter(Boolean).reduce((v,k)=>v.split(k).join('[redacted]'),String(s)).slice(0,1000);
const base=`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/pawspace-staging`;
async function api(suffix,method='GET',body){
 check(method==='GET'&&!body,'read_only_required');
 const op={path:suffix,method,state:method==='GET'?'read_pending':'uncertain_before_dispatch'};receipt.operations.push(op);save();
 let r;try{r=await fetch(base+suffix,{method,headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});}catch{op.state=method==='GET'?'read_failed':'unknown_no_retry';save();throw Error('transport_unknown_'+suffix)}
 op.httpStatus=r.status;const p=await r.json().catch(()=>null);op.success=p?.success===true;op.errors=(p?.errors??[]).map(e=>({code:e.code,message:redact(e.message)}));
 if(!r.ok||p?.success!==true){op.state=p?.success===false?'rejected':method==='GET'?'read_failed':'unknown_no_retry';save();throw Error('http_'+r.status+'_'+suffix+'_'+JSON.stringify(op.errors))}
 op.state='confirmed';save();return p.result;
}
async function active(){const p=await api('/deployments');check(Array.isArray(p?.deployments)&&p.deployments.length>0,'deployments_shape');const d=p.deployments[0];check(d.versions?.length===1&&d.versions[0].percentage===100,'mixed_or_unknown_deployment');return{deploymentId:d.id,versionId:d.versions[0].version_id};}
async function schedules(){const p=await api('/schedules');const a=Array.isArray(p)?p:p?.schedules;check(Array.isArray(a),'schedules_shape');return a.map(x=>x.cron).sort();}
try{
 check(env.CONFIRM==='read-only-normal-restore-verification'&&env.GITHUB_RUN_ATTEMPT==='1'&&/^ops\/atlas-session-/.test(env.GITHUB_REF_NAME??'')&&env.EXPECTED_SHA===env.GITHUB_SHA,'fixed_recovery_refused');
 check(/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID??'')&&env.CLOUDFLARE_API_TOKEN&&env.PAWSPACE_UAT_SIGNING_KEY,'existing_connection_missing');
 receipt.before=await active();receipt.schedulesBefore=await schedules();save();
 check(receipt.before.versionId===ORIGINAL,'unexpected_deployment_refused');
 const version=await api('/versions/'+ORIGINAL),bindings=version.resources?.bindings;check(Array.isArray(bindings),'native_bindings_unproven');check(bindings.filter(b=>b.type==='d1').length===1&&bindings.some(b=>b.type==='d1'&&b.name==='DB'&&(b.id??b.database_id)==='1b879a28-c8a9-40b0-830d-1ce439061a00'),'dedicated_db_refused');const vars=Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,String(b.text??b.value??'')]));check(vars.PAWSPACE_STAGING_BUILD_SHA===SHA&&vars.FORBID_PRODUCTION==='true'&&vars.PAWSPACE_PAYMENT_ENV==='sandbox'&&vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='false'&&vars.PAWSPACE_RAZORPAYX_ENV==='sandbox'&&vars.PAWSPACE_RAZORPAYX_LIVE_APPROVED==='false','sandbox_flags_unproven');check(!bindings.some(b=>b.name==='PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE'&&b.type!=='plain_text')&&!['on','true','1','yes'].includes(String(vars.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE??'').trim().toLowerCase()),'fixture_not_restored');receipt.isolation={dedicatedD1:true,sandbox:true,fixtureOff:true,buildSha:SHA};
 // Historical control-plane metadata only; this never routes traffic to the temporary version.
 const historicalId='b2445f9c-7bc8-4d6a-8540-dd8274845c98',historical=await api('/versions/'+historicalId);
 const hb=historical.resources?.bindings;check(Array.isArray(hb)&&hb.length<=100,'historical_bindings_unproven');
 const hv=Object.fromEntries(hb.filter(b=>b.type==='plain_text').map(b=>[b.name,String(b.text??b.value??'')]));
 const safeName=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:/-]{1,128}$/.test(v)?v:null;
 const scriptMetadata=historical.resources?.script??{};
 receipt.historicalTemporaryVersion={id:historicalId,bindings:hb.map(b=>({name:safeName(b.name),type:safeName(b.type)})),flags:{expectedOperationSha:hv.PAWSPACE_STAGING_BUILD_SHA==='9dcbcdf9ba4f53907926fc1913eaf4747470b0c9',expectedOrigin:hv.FINANCE_TEST_ORIGIN===origin,expectedJob:hv.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID==='Sentinel_f67e3c5a85f88191b07279e0edbe250c',staging:hv.PAWSPACE_DEPLOYMENT_ENV==='staging',sandbox:hv.PAWSPACE_PAYMENT_ENV==='sandbox',isolated:hv.PAWSPACE_ISOLATED_FINANCE_TEST==='true',forbidProduction:hv.FORBID_PRODUCTION==='true'},script:{size:Number.isSafeInteger(scriptMetadata.size)&&scriptMetadata.size>=0?scriptMetadata.size:null,etag:typeof scriptMetadata.etag==='string'&&/^[a-f0-9"-]{1,128}$/i.test(scriptMetadata.etag)?scriptMetadata.etag:null,entry:safeName(scriptMetadata.main_module??scriptMetadata.entry_point),moduleKeys:scriptMetadata.modules&&typeof scriptMetadata.modules==='object'?Object.keys(scriptMetadata.modules).slice(0,100).map(safeName):[]},note:'Control-plane metadata only; not edge source attestation. Secret binding values are never retained.'};save();
 receipt.after=await active();check(receipt.after.versionId===ORIGINAL,'certified_version_not_restored');save();

 receipt.schedulesAfter=await schedules();check(JSON.stringify(receipt.schedulesAfter)===JSON.stringify([...crons].sort()),'cron_restore_unproven');save();
 const cookie='pawspace_uat='+encodeURIComponent(await issueUatToken({PAWSPACE_UAT_SIGNING_KEY:env.PAWSPACE_UAT_SIGNING_KEY},'founder@pawspace.in',600));
 const get=async path=>{const r=await fetch(origin+path,{headers:{cookie},redirect:'manual',signal:AbortSignal.timeout(20000)});check(r.ok,'origin_'+r.status+'_'+path);return r;};
 const fixture=await(await get('/__staging/fixture-isolation?expectedSha='+SHA+'&scope=grooming_strict')).json();check(fixture.ok===true&&fixture.version?.id===ORIGINAL&&fixture.version?.buildSha===SHA,'restored_fixture_or_auth_failed');receipt.fixture={ok:true,versionId:fixture.version.id,buildSha:fixture.version.buildSha};
 const health=await(await get('/healthz')).json();check(health.status==='ok','health_failed');receipt.health=true;
 const favicon=Buffer.from(await(await get('/favicon.svg')).arrayBuffer());check(createHash('sha256').update(favicon).digest('hex')==='e6d2e59b7b5bbb0342e0fb496dfc262decbfe4426bbb7b047aec8d467d1dc6f7','assets_hash_failed');receipt.assets=true;
 const ui=await get('/staging-login');check((ui.headers.get('content-type')??'').includes('text/html'),'normal_ui_failed');receipt.ui=true;
 receipt.ok=true;receipt.completedAt=new Date().toISOString();receipt.schedulePropagation='API read confirms all3; edge propagation may take15minutes';save();console.log('Certified staging version,3crons,authenticated fixture,UI/assets/health restored.');
}catch(error){receipt.ok=false;receipt.failure=redact(error.message);save();console.error(receipt.failure);process.exitCode=1;}
