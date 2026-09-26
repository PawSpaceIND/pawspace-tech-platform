// Explicit, staging-only reset of the tester's low-confidence handoff. Never dials.
const origin='https://pawspace-staging.karthik-fce.workers.dev';
const entries=String(process.env.PAWSPACE_VOICE_UAT_ALLOWLIST||'').trim().split(/[\s,;]+/).filter(Boolean);
const expected=String(process.env.EXPECTED_DESTINATION_LAST4||'').trim();
const callId=String(process.env.UAT_VOICE_CALL_ID||'').trim();
if(entries.length!==1||!/^\d{4}$/.test(expected)||entries[0].replace(/\D/g,'').slice(-4)!==expected||!/^VCALL-[A-Z0-9-]+$/.test(callId))throw new Error('Confirmed UAT identity is required');
const login=await fetch(origin+'/api/staging-login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'founder@pawspace.in',code:process.env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
if(login.status!==200)throw new Error('Staging login refused');
const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];
if(!cookie.startsWith('pawspace_uat='))throw new Error('Missing staging session');
async function api(path,body){
 const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error('Staging handoff operation refused: '+response.status);
 return result.data;
}
const ledger=await api('/api/voice-outbound?scope=ledger&limit=100');
const call=ledger.find(row=>row.callId===callId);
console.log('VOICE_UAT_CONTEXT_CHECK='+JSON.stringify({found:Boolean(call),mode:call?.mode||null,productionCall:call?.productionCall??null,phoneLast4:call?.phoneLast4||null,expectedLast4:expected,matchingCandidates:ledger.filter(row=>row.mode==='uat'&&!row.productionCall&&row.phoneLast4===expected).map(row=>({callId:row.callId,state:row.state,useCase:row.useCase})).slice(0,5)}));
if(!call||call.mode!=='uat'||call.productionCall||call.phoneLast4!==expected)throw new Error('Call is not the confirmed UAT test context');
const threadId='THREAD-VOICE-'+callId;
const queue=await api('/api/ai-human-handoff?mode=queue&limit=100');
const rows=Array.isArray(queue)?queue:Array.isArray(queue?.queue)?queue.queue:[];
const handoff=rows.find(row=>row.thread_id===threadId||row.threadId===threadId);
if(!handoff)throw new Error('Test handoff was not found in the queue; no state changed');
const customerId=handoff.customer_id||handoff.customerId;
const snapshot=await api('/api/ai-human-handoff?threadId='+encodeURIComponent(threadId)+'&customerId='+encodeURIComponent(customerId));
if(snapshot.current?.status!=='queued'||snapshot.current?.reason!=='low_confidence')throw new Error('Only a queued low-confidence UAT handoff may be reset');
const reason='Owner-authorized voice UAT retry after fixing follow-up context; no customer outreach';
await api('/api/ai-human-handoff',{action:'take_over',threadId,customerId,reason});
await api('/api/ai-human-handoff',{action:'resume_ai',threadId,customerId,reason});
const verified=await api('/api/ai-human-handoff?threadId='+encodeURIComponent(threadId)+'&customerId='+encodeURIComponent(customerId));
if(verified.aiPaused||verified.current?.status!=='resumed')throw new Error('Resume read-back did not confirm completion');
console.log('VOICE_UAT_RESUMED='+JSON.stringify({destinationLast4:expected,aiPaused:false,status:'resumed',dialed:false}));
