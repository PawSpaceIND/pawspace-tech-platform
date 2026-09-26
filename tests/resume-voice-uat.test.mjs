import test from 'node:test';
import assert from 'node:assert/strict';
async function run({status='queued',reason='low_confidence',mode='uat',last4='7878',productionCall=true}={}){
 const priorFetch=globalThis.fetch,priorEnv={...process.env},priorLog=console.log,calls=[];
 Object.assign(process.env,{PAWSPACE_VOICE_UAT_ALLOWLIST:'+919999997878',EXPECTED_DESTINATION_LAST4:'7878',UAT_VOICE_CALL_ID:'VCALL-TEST',PAWSPACE_UAT_ACCESS_CODE:'test-only'});
 let resumed=false;
 console.log=()=>{};
 globalThis.fetch=async(url,options={})=>{
  calls.push({url:String(url),options});const path=new URL(url).pathname;
  if(path==='/api/staging-login')return new Response('{}',{headers:{'set-cookie':'pawspace_uat=test-only; Secure'}});
  if(path==='/api/voice-outbound')return Response.json({data:[{callId:'VCALL-TEST',mode,productionCall,phoneLast4:last4}]});
  if(path!=='/api/ai-human-handoff')throw new Error('unexpected network target');
  if(new URL(url).searchParams.get('mode')==='queue')return Response.json({data:{queue:[{threadId:'THREAD-VOICE-VCALL-TEST',customerId:'CUS-TEST'}]}});
  if(options.method==='POST'){const body=JSON.parse(options.body);if(body.action==='resume_ai')resumed=true;return Response.json({data:{}});}
  return Response.json({data:{aiPaused:!resumed,current:{status:resumed?'resumed':status,reason}}});
 };
 let error;
 try{await import('../scripts/resume-voice-uat.mjs?test='+crypto.randomUUID());}catch(e){error=e;}
 finally{globalThis.fetch=priorFetch;console.log=priorLog;for(const key of ['PAWSPACE_VOICE_UAT_ALLOWLIST','EXPECTED_DESTINATION_LAST4','UAT_VOICE_CALL_ID','PAWSPACE_UAT_ACCESS_CODE']){if(priorEnv[key]===undefined)delete process.env[key];else process.env[key]=priorEnv[key];}}
 return{calls,error};
}
test('confirmed low-confidence UAT handoff uses takeover then resume and no dialing',async()=>{
 const {calls,error}=await run();assert.equal(error,undefined);
 const writes=calls.filter(c=>c.options.method==='POST'&&c.url.includes('/ai-human-handoff'));
 assert.deepEqual(writes.map(c=>JSON.parse(c.options.body).action),['take_over','resume_ai']);
 assert.ok(calls.every(c=>new URL(c.url).hostname==='pawspace-staging.karthik-fce.workers.dev'));
 assert.ok(!calls.some(c=>c.url.includes('/outbound-call')));
});
for(const override of [{status:'staff_active'},{reason:'customer_requested_human'},{mode:'production'},{last4:'0000'}])test('refuses unrelated or protected handoff '+JSON.stringify(override),async()=>{
 const {calls,error}=await run(override);assert.ok(error);
 assert.equal(calls.filter(c=>c.options.method==='POST'&&c.url.includes('/ai-human-handoff')).length,0);
});
