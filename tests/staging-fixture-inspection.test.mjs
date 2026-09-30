import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectStagingFixtures} from '../scripts/inspect-staging-fixtures.mjs';
import {DatabaseSync} from 'node:sqlite';

const env={EXPECTED_SHA:'a'.repeat(40),STAGING_D1_ID:'11111111-1111-1111-1111-111111111111',PRODUCTION_D1_ID:'22222222-2222-2222-2222-222222222222',CLOUDFLARE_ACCOUNT_ID:'account',CLOUDFLARE_API_TOKEN:'private-token',PAWSPACE_UAT_ACCESS_CODE:'private-code'};
const sourceNames=['Inbound sessions','Voice booking journey','Voice sales funnel','Post-call reconciliation','AI processing measurements','CRM write reconciliation'];
function harness({gate={},snapshot={},revision=env.EXPECTED_SHA,phonePaused='true',sources=sourceNames.map(name=>({name,available:true})),productionCertified=false}={}){
 const calls=[];
 const vars={PAWSPACE_STAGING_BUILD_SHA:revision,PAWSPACE_DEPLOYMENT_ENV:'staging',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false',PAWSPACE_VOICE_PHONE_TESTS_PAUSED:phonePaused,PAWSPACE_VOICE_NATIVE_UAT_APPROVED:'false',PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED:'false',PAWSPACE_VOICE_UAT_AUTORUN:'false'};
 const request=async(url,init={})=>{
  calls.push({url:String(url),method:init.method||'GET'});
  const path=new URL(url).pathname;
  if(path.endsWith('/settings'))return Response.json({success:true,result:{annotations:{'workers/message':'staging '+revision},bindings:[{type:'d1',name:'DB',id:env.STAGING_D1_ID},...Object.entries(vars).map(([name,text])=>({type:'plain_text',name,text}))]}});
  if(path.includes('/d1/database/'))return Response.json({success:true,result:{name:'pawspace-staging'}});
  if(path==='/api/staging-login')return Response.json({ok:true},{headers:{'set-cookie':'pawspace_uat=private-cookie; HttpOnly'}});
  if(path==='/api/voice-outbound')return new URL(url).searchParams.get('scope')==='sales_operations'?Response.json({data:{productionCertified,sources,inbound:[{customerId:'private-customer'}],offers:[{transcript:'private-transcript'}],funnel:{paid:999}}}):Response.json({data:{gate:{mode:'disabled',enabled:false,uatApproved:false,salesOutboundApproved:false,...gate}}});
  if(path==='/__staging/fixture-isolation'){
   const strict=new URL(url).searchParams.get('scope')==='grooming_strict';
   return Response.json({ok:strict,checks:{customerFixtureProven:true,providerFixtureProven:strict},version:{buildSha:env.EXPECTED_SHA,id:'33333333-3333-3333-3333-333333333333'},bookingMutationAuthorized:false,automaticAssignmentCovered:false,productionReadiness:false,privateRecipient:'not-for-report',...snapshot},{status:strict?200:409});
  }
  throw Error('Unexpected network path');
 };
 return {calls,request};
}

test('hosted inspection preserves failed whole-roster evidence and makes no business requests',async()=>{
 const {request,calls}=harness();const report=await inspectStagingFixtures({env,request});
 assert.equal(report.inspectionCompleted,true);assert.equal(report.fixtureSnapshots[0].attested,false);assert.deepEqual(report.fixtureSnapshots[0].failedChecks,['providerFixtureProven']);assert.equal(report.fixtureSnapshots[1].attested,true);
 for(const key of ['dialed','bookingCreated','paymentCaptured','automaticAssignmentCertified','providerAcceptanceCertified','premiumCertified'])assert.equal(report[key],false);
 assert.deepEqual(calls.filter(c=>c.method!=='GET').map(c=>new URL(c.url).pathname),['/api/staging-login']);
 assert.equal(report.operationalSourcesComplete,true);assert.equal(report.operationalSourcesAvailable,6);
 assert.doesNotMatch(JSON.stringify(report),/private-token|private-code|private-cookie|not-for-report|private-customer|private-transcript|"paid"/);
});
test('missing, unavailable or duplicate operational sources stay unverified',async()=>{
 for(const sources of [sourceNames.slice(1).map(name=>({name,available:true})),sourceNames.map(name=>({name,available:name!=='CRM write reconciliation'})),[...sourceNames.map(name=>({name,available:true})),{name:'Inbound sessions',available:true}]]){
  const {request}=harness({sources});const report=await inspectStagingFixtures({env,request});assert.equal(report.operationalSourcesComplete,false);assert.equal(report.operationalSourcesAvailable,5);assert.equal(report.premiumCertified,false);
 }
 const {request}=harness({productionCertified:true});await assert.rejects(inspectStagingFixtures({env,request}),/overview evidence invalid/);
});
test('wrong revision and missing phone pause refuse before authentication',async()=>{
 for(const config of [{revision:'b'.repeat(40)},{phonePaused:'false'}]){
  const {request,calls}=harness(config);await assert.rejects(inspectStagingFixtures({env,request}));assert.ok(!calls.some(c=>c.method!=='GET'));
 }
});
test('effective calling permission refuses before fixture inspection',async()=>{
 const {request,calls}=harness({gate:{enabled:true}});await assert.rejects(inspectStagingFixtures({env,request}),/shutdown/);assert.ok(!calls.some(c=>c.url.includes('fixture-isolation')));
});
test('a narrow snapshot cannot certify mutation or automatic assignment',async()=>{
 for(const key of ['bookingMutationAuthorized','automaticAssignmentCovered','productionReadiness']){
  const {request}=harness({snapshot:{[key]:true}});await assert.rejects(inspectStagingFixtures({env,request}),/scope invalid/);
 }
});
test('optional hosted roster diagnosis executes SELECT-only aggregates and exposes no contacts',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE provider_capacity_profiles(id TEXT PRIMARY KEY,city_id TEXT,updated_by TEXT); CREATE TABLE canonical_providers(id TEXT PRIMARY KEY,city_id TEXT,phone TEXT,email TEXT,source TEXT); CREATE TABLE boarding_host_profiles(provider_id TEXT,city_id TEXT);');
  const ids=['groom_arun','groom_kiran','groom_sanjay','train_kiran','train_ramesh','train_meera'];
  for(const id of ids)db.prepare('INSERT INTO provider_capacity_profiles VALUES(?,?,?)').run(id,'blr',id==='groom_arun'?'legacy':'founder_seed');
  db.prepare('INSERT INTO canonical_providers VALUES(?,?,?,?,?)').run('groom_arun','blr','private-phone','private-email','legacy');
  db.prepare('INSERT INTO provider_capacity_profiles VALUES(?,?,?)').run('cross-city','del','founder_seed');
  db.prepare('INSERT INTO canonical_providers VALUES(?,?,?,?,?)').run('cross-city','blr','','','uat_staging_seed');
  db.prepare('INSERT INTO boarding_host_profiles VALUES(?,?)').run('cross-city','blr');
  const fixture=harness(),queries=[];
  const request=async(url,init={})=>{
   if(new URL(url).pathname.endsWith('/query')){
    assert.equal(init.method,'POST');const {sql,params}=JSON.parse(init.body);assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|PRAGMA)\b/i);queries.push(sql);
    return Response.json({success:true,result:[{success:true,results:db.prepare(sql).all(...params)}]});
   }
   return fixture.request(url,init);
  };
  const report=await inspectStagingFixtures({env:{...env,INSPECT_ROSTER_DIAGNOSIS:'true'},request});
  assert.equal(queries.length,2);assert.deepEqual(report.rosterDiagnosis.counts,{rosterRows:7,missingCanonicalRows:5,missingPhoneRows:6,emailPresentRows:1,canonicalProvenanceMismatchRows:6,capacityProvenanceMismatchRows:1,cityMismatchRows:6});
  assert.equal(report.rosterDiagnosis.legacyFixtures.length,6);assert.equal(report.rosterDiagnosis.legacyFixtures.filter(row=>row.canonicalPresent).length,1);
  assert.doesNotMatch(JSON.stringify(report),/private-phone|private-email|private-token|private-code/);assert.equal(report.rosterDiagnosis.assignmentCertified,false);assert.equal(report.rosterDiagnosis.identitiesProvisioned,false);
 }finally{db.close();}
});
