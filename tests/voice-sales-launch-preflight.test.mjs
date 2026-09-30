import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {canonicalDialNumber} from '../lib/voice-call-gate.ts';
import {authorizedLaunchTester,inspectVoiceSalesLaunch,specialistPilotAction} from '../scripts/voice-sales-launch-preflight.mjs';
const env={PAWSPACE_VOICE_UAT_ALLOWLIST:'+91 98765 43210',EXPECTED_TESTER_SHA256:createHash('sha256').update('9876543210').digest('hex')};
test('optional deployment preflight stays inside the certified revision concurrency lock',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/deploy-staging.yml',import.meta.url),'utf8');
 const step=workflow.slice(workflow.indexOf('      - name: Inspect voice sales readiness under'),workflow.indexOf('      - name: Send one approved Fast2SMS smoke'));
 assert.match(workflow,/group: pawspace-staging-sweep/);
 assert.match(workflow,/voice_sales_preflight:[\s\S]*?type: boolean\s+default: false/);
 assert.ok(workflow.indexOf('Verify the authorized voice preflight recipient')<workflow.indexOf('Apply D1 migrations'));
 assert.ok(workflow.indexOf('Inspect voice sales readiness under')>workflow.indexOf('run: node tests\/e2e\/staging-certification.mjs'));
 assert.match(step,/voice_sales_preflight == 'true'/);
 assert.match(step,/set -o pipefail/);
 assert.match(step,/scripts\/voice-sales-launch-preflight\.mjs/);
 assert.doesNotMatch(step,/continue-on-error|request_call|specialistPilotAction/);
});
test('fresh launch requires the full authorized number, not a matching last four',()=>{
 assert.equal(authorizedLaunchTester(env),'+919876543210');
 assert.equal(authorizedLaunchTester(env),canonicalDialNumber(env,env.PAWSPACE_VOICE_UAT_ALLOWLIST));
 assert.throws(()=>authorizedLaunchTester({...env,PAWSPACE_VOICE_UAT_ALLOWLIST:'9876543210,9876543211'}));
 assert.throws(()=>authorizedLaunchTester({...env,PAWSPACE_VOICE_UAT_ALLOWLIST:'9999943210'}),/authorized recipient/);
 assert.throws(()=>authorizedLaunchTester({...env,EXPECTED_TESTER_SHA256:''}));
});
test('recipient mismatch fails before any network request',async()=>{
 await assert.rejects(inspectVoiceSalesLaunch({...env,EXPECTED_TESTER_SHA256:'0'.repeat(64)},async()=>{assert.fail('no network before authorized identity')}));
});
test('fresh inspection resolves one canonical owner and previews policy without dialing',async()=>{
 const actions=[];
 const request=async(url,init={})=>{
  const body=init.body?JSON.parse(init.body):null;
  if(String(url).includes('/d1/database/')&&!String(url).endsWith('/query'))return Response.json({success:true,result:{name:'pawspace-staging'}});
  if(String(url).endsWith('/query')){assert.match(body.sql,/^SELECT /);return Response.json({success:true,result:[{success:true,results:[{id:'customer',primary_phone:'+919876543210'}]}]});}
  if(String(url).endsWith('/api/staging-login'))return Response.json({}, {headers:{'set-cookie':'pawspace_uat=test; HttpOnly'}});
  if(String(url).endsWith('/api/voice-outbound?scope=sales_operations'))return Response.json({data:{sources:[{name:'Inbound sessions',available:true},{name:'Voice booking journey',available:false}],productionCertified:false}});
  if(String(url).endsWith('/api/voice-outbound')&&init.method!=='POST')return Response.json({data:{gate:{mode:'uat',enabled:true},transport:{provider:'elevenlabs_exotel'}}});
  if(String(url).endsWith('/api/voice-outbound')){actions.push(body.action);assert.equal(body.phone,'+919876543210');assert.equal(body.customerId,'customer');return Response.json({data:{allowed:true}});}
  assert.fail('unexpected request');
 };
 const result=await inspectVoiceSalesLaunch(env,request);assert.equal(result.dialed,false);assert.equal(result.policyAllowed,true);assert.equal(result.salesDashboardSources,2);assert.equal(result.salesDashboardUnavailable,1);assert.deepEqual(result.salesDashboardUnavailableSources,['Voice booking journey']);assert.deepEqual(actions,['policy_preview']);
});

test('attended pilot requires exact recipient authorization and refuses workflow reruns',()=>{
 assert.equal(specialistPilotAction({PILOT_ACTION:'specialist-call'}),'request_call');
 assert.equal(specialistPilotAction({...env,PILOT_ACTION:'attended-specialist-uat',GITHUB_RUN_ATTEMPT:'1'}),'uat_specialist_sales_test');
 assert.throws(()=>specialistPilotAction({...env,PILOT_ACTION:'attended-specialist-uat',GITHUB_RUN_ATTEMPT:'2'}),/cannot be rerun/);
 assert.throws(()=>specialistPilotAction({...env,PILOT_ACTION:'attended-specialist-uat',GITHUB_RUN_ATTEMPT:'1',EXPECTED_TESTER_SHA256:'0'.repeat(64)}),/authorized recipient/);
 assert.throws(()=>specialistPilotAction({...env,PILOT_ACTION:'unknown',GITHUB_RUN_ATTEMPT:'1'}),/Explicit/);
});
