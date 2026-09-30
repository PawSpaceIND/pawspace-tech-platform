import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {assertDemoPhonePauseMetadata,assertDemoRuntimePhonePause} from './voice-demo-scenarios.mjs';

const ORIGIN='https://pawspace-staging.karthik-fce.workers.dev';
const SHA=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SALES_SOURCES=['Inbound sessions','Voice booking journey','Voice sales funnel','Post-call reconciliation','AI processing measurements','CRM write reconciliation'];

export async function inspectStagingFixtures({env=process.env,request=fetch}={}){
 const expected=String(env.EXPECTED_SHA||'');
 if(!SHA.test(expected)||!UUID.test(String(env.STAGING_D1_ID||''))||env.STAGING_D1_ID===env.PRODUCTION_D1_ID||!env.CLOUDFLARE_ACCOUNT_ID||!env.CLOUDFLARE_API_TOKEN||!env.PAWSPACE_UAT_ACCESS_CODE)throw Error('Inspection prerequisites missing');
 const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
 const cf=async(path)=>{
  const response=await request(base+path,{headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN},redirect:'error',signal:AbortSignal.timeout(30000)});
  const body=await response.json();
  if(!response.ok||body.success!==true)throw Error('Infrastructure read refused');
  return body.result;
 };
 const metadata=await cf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID));
 if(metadata.name!=='pawspace-staging')throw Error('Isolated database not proved');
 const settings=async()=>{
  const value=await cf('/workers/scripts/pawspace-staging/settings');
  const vars=Object.fromEntries((value.bindings||[]).filter(b=>b.type==='plain_text').map(b=>[b.name,b.text??b.value]));
  if(value.annotations?.['workers/message']!=='staging '+expected||vars.PAWSPACE_STAGING_BUILD_SHA!==expected||vars.PAWSPACE_DEPLOYMENT_ENV!=='staging'||vars.FORBID_PRODUCTION!=='true'||vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED!=='false'||!(value.bindings||[]).some(b=>b.type==='d1'&&b.name==='DB'&&b.id===env.STAGING_D1_ID))throw Error('Exact build or isolation not proved');
  assertDemoPhonePauseMetadata(vars);
  return vars;
 };
 const vars=await settings();
 const login=await request(ORIGIN+'/api/staging-login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
 const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];
 if(login.status!==200||!cookie.startsWith('pawspace_uat='))throw Error('Founder authentication refused');
 const get=async(path)=>{
  const response=await request(ORIGIN+path,{headers:{cookie},redirect:'error',signal:AbortSignal.timeout(30000)});
  const body=await response.json();
  return {status:response.status,body};
 };
 const gate=await get('/api/voice-outbound');
 if(gate.status!==200)throw Error('Runtime phone pause read refused');
 assertDemoRuntimePhonePause(vars,gate.body.data?.gate);
 const overview=await get('/api/voice-outbound?scope=sales_operations'),operations=overview.body.data;
 if(overview.status!==200||operations?.productionCertified!==false||!Array.isArray(operations.sources))throw Error('Operational overview evidence invalid');
 // Report availability only: no customer rows, call IDs, transcripts or funnel counts leave this read.
 const operationalSources=SALES_SOURCES.map(name=>({name,available:operations.sources.filter(source=>source?.name===name).length===1&&operations.sources.find(source=>source?.name===name)?.available===true}));
 const snapshots=[];
 for(const scope of ['bengaluru_roster','grooming_strict']){
  await settings();
  const result=await get('/__staging/fixture-isolation?expectedSha='+expected+'&scope='+scope),body=result.body;
  if(![200,409,503].includes(result.status)||typeof body.ok!=='boolean')throw Error('Fixture inspection refused');
  if(body.version&&(body.version.buildSha!==expected||!UUID.test(String(body.version.id||''))))throw Error('Snapshot revision invalid');
  if(body.ok===true&&(result.status!==200||body.bookingMutationAuthorized!==false||body.automaticAssignmentCovered!==false||body.productionReadiness!==false))throw Error('Snapshot scope invalid');
  const checks=Object.fromEntries(Object.entries(body.checks||{}).filter(([key,value])=>/^[A-Za-z][A-Za-z0-9]{0,80}$/.test(key)&&typeof value==='boolean'));
  if(body.ok===true&&(!body.version||!Object.keys(checks).length||!Object.values(checks).every(Boolean)))throw Error('Passing snapshot lacks evidence');
  snapshots.push({scope,status:result.status,attested:body.ok===true,checks,failedChecks:Object.keys(checks).filter(key=>!checks[key]),version:body.version?{buildSha:body.version.buildSha,id:body.version.id}:null});
 }
 await settings();
 const versions=snapshots.map(s=>s.version?.id).filter(Boolean);
 if(new Set(versions).size>1)throw Error('Worker version changed during inspection');
 return {inspectionCompleted:true,revision:expected,phonePaused:true,dialed:false,bookingCreated:false,paymentCaptured:false,operationalSources,operationalSourcesAvailable:operationalSources.filter(source=>source.available).length,operationalSourcesComplete:operationalSources.every(source=>source.available),fixtureSnapshots:snapshots,automaticAssignmentCertified:false,providerAcceptanceCertified:false,premiumCertified:false,scope:'Authenticated read-only fixture and operational-source snapshots; no business mutation or launch certification'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const report=await inspectStagingFixtures();
 await mkdir('fixture-inspection-results',{recursive:true});
 await writeFile('fixture-inspection-results/report.json',JSON.stringify(report,null,2));
 console.log('STAGING_FIXTURE_INSPECTION='+JSON.stringify(report));
}
