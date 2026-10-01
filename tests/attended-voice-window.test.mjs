import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {openAttendedVoiceWindow} from '../scripts/attended-voice-window.mjs';
const env={PILOT_ACTION:'attended-specialist-uat',GITHUB_RUN_ATTEMPT:'1',SPECIALIST_USE_CASE:'grooming_sales',EXPECTED_SHA:'a'.repeat(40),SPECIALIST_CUSTOMER_ID:'tester',PAWSPACE_VOICE_UAT_ALLOWLIST:'9876543210',EXPECTED_TESTER_SHA256:createHash('sha256').update('9876543210').digest('hex'),CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'test-only',STAGING_D1_ID:'stage',PRODUCTION_D1_ID:'prod'};
const vars={PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_VOICE_RUNTIME:'elevenlabs',PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'true',PAWSPACE_VOICE_ENV:'disabled'};
const settings=()=>({bindings:[...Object.entries(vars).map(([name,text])=>({name,type:'plain_text',text})),{name:'DB',type:'d1',id:'stage'},{name:'KEY',type:'secret_text'}],annotations:{'workers/message':'fixture'}});
test('one attended window inherits encrypted runtime is verified through authenticated readiness while secret bindings are inherited',async()=>{
 let current=settings(),patches=0,runtimeReads=0,delays=0;
 current.bindings.find(x=>x.name==='PAWSPACE_VOICE_RUNTIME').type='secret_text';
 delete current.bindings.find(x=>x.name==='PAWSPACE_VOICE_RUNTIME').text;
 await openAttendedVoiceWindow({...env,PRODUCTION_D1_ID:''},async(url,init)=>{
  if(url.endsWith('/api/staging-login'))return Response.json({}, {headers:{'set-cookie':'pawspace_uat=fixture'}});
  if(url.endsWith('/api/voice-outbound?scope=ai_self_test'))return Response.json({data:{mode:'uat',approved:true,singleRecipient:true}});
  if(url.endsWith('/api/voice-outbound')){if(patches)runtimeReads++;return Response.json({data:{gate:patches&&runtimeReads>1?{mode:'uat',enabled:true,uatApproved:true,salesOutboundApproved:true,allowlistSize:1}:{mode:'disabled',enabled:false},transport:{provider:'elevenlabs_exotel'}}});}
  if(url.includes('/d1/database/'))return Response.json({success:true,result:{name:'pawspace-staging',uuid:'stage'}});
  assert.match(url,/workers\/scripts\/pawspace-staging\/settings$/);
  if(init.method==='PATCH'){
   patches++;
   const patch=JSON.parse(await init.body.get('settings').text());
   assert.deepEqual(patch.bindings.find(x=>x.name==='KEY'),{name:'KEY',type:'inherit',version_id:'latest'});
   assert.equal(patch.bindings.find(x=>x.name==='PAWSPACE_VOICE_NATIVE_UAT_APPROVED').text,'false');
   assert.equal(patch.bindings.find(x=>x.name==='PAWSPACE_VOICE_UAT_AUTORUN').text,'false');
   current.bindings=current.bindings.filter(x=>!patch.bindings.some(y=>y.type==='plain_text'&&y.name===x.name));
   current.bindings.push(...patch.bindings.filter(x=>x.type==='plain_text'));
  }
  return Response.json({success:true,result:current});
 },{delay:async(ms)=>{assert.equal(ms,2000);delays++;}});
 assert.equal(patches,1);assert.equal(runtimeReads,2);assert.equal(delays,1);
});
test('reruns, wrong recipient, live database and other use cases fail before network',async()=>{
 for(const override of [{GITHUB_RUN_ATTEMPT:'2'},{SPECIALIST_USE_CASE:'training_sales'},{EXPECTED_TESTER_SHA256:'0'.repeat(64)},{STAGING_D1_ID:'prod'},{EXPECTED_SHA:''}])await assert.rejects(openAttendedVoiceWindow({...env,...override},()=>assert.fail('must not reach network')));
});
test('unpaused, production or non-ElevenLabs worker never receives an unlock PATCH',async()=>{
 for(const override of [{PAWSPACE_VOICE_PHONE_TESTS_PAUSED:'false'},{PAWSPACE_DEPLOYMENT_ENV:'production'},{PAWSPACE_VOICE_RUNTIME:'native'}]){
  const current=settings();for(const [name,text] of Object.entries(override))current.bindings.find(x=>x.name===name).text=text;
  await assert.rejects(openAttendedVoiceWindow(env,async(url,init)=>{if(url.endsWith('/api/staging-login'))return Response.json({}, {headers:{'set-cookie':'pawspace_uat=fixture'}});if(url.endsWith('/api/voice-outbound'))return Response.json({data:{gate:{mode:'disabled',enabled:false},transport:{provider:'exotel'}}});assert.notEqual(init.method,'PATCH');return Response.json({success:true,result:url.includes('/d1/database/')?{name:'pawspace-staging',uuid:'stage'}:current});}),/Paused isolated/);
 }
});
test('attended workflow always restores pause even when unlock, policy or call fails',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/elevenlabs-provider-preflight.yml',import.meta.url),'utf8');
 const job=workflow.slice(workflow.indexOf('  specialist-call:'),workflow.indexOf('  direct-grooming-call:'));
 assert.ok(job.indexOf('Verify exact isolated build')<job.indexOf('Open only the authorized'));
 assert.ok(job.indexOf('scripts/attended-voice-window.mjs')<job.indexOf('Place one controlled'));
 assert.match(job,/specialistPilotAction\(process.env\)/);
 assert.doesNotMatch(job,/node --experimental-strip-types scripts\/voice-sales-launch-preflight.mjs/);
 assert.match(job,/Restore and verify[\s\S]*?if: \$\{\{ always\(\) && inputs.confirm == 'attended-specialist-uat' \}\}/);
 assert.match(job,/run: node scripts\/pause-staging-phone-calls.mjs/);
 assert.doesNotMatch(job,/continue-on-error|workflow enable/);
});

test('wrong database metadata refuses before any worker mutation',async()=>{
 await assert.rejects(openAttendedVoiceWindow({...env,PRODUCTION_D1_ID:''},async(url,init)=>{assert.ok(url.includes('/d1/database/'));assert.notEqual(init.method,'PATCH');return Response.json({success:true,result:{name:'pawspace-production',uuid:'stage'}});}),/Canonical isolated/);
});
