import {testerCandidateQuery,resolveTesterCustomer} from './voice-app-tester.mjs';
import {exotelApiOrigin} from './repair-staging-voice-config.mjs';
// A staging demo through the same policy preview and request_call route as the staff app.
// No direct provider dialing, import mutation, policy bypass, or payment operation.
import {setTimeout as delay} from 'node:timers/promises';
import {verifyVoiceSale} from './verify-voice-sale.mjs';
import {conversationEvidence} from './voice-uat-evidence.mjs';
const env=process.env,origin='https://pawspace-staging.karthik-fce.workers.dev';
if(env.VOICE_SALE_ACTION!=='inspect-app-voice')throw Error('This diagnostic revision never dials');
if(!['inspect-app-voice','direct-grooming-call'].includes(env.VOICE_SALE_ACTION))throw Error('Explicit app voice action required');
await verifyVoiceSale({...env,VOICE_SALE_ACTION:'probe-agent-socket'});
const read=async(url,headers,init={})=>{const r=await fetch(url,{headers,...init,signal:AbortSignal.timeout(30000)});const b=await r.json();if(!r.ok)throw Error('Voice demo request refused: '+r.status);return b;};
const login=await fetch(origin+'/api/staging-login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];
if(login.status!==200||!cookie.startsWith('pawspace_uat='))throw Error('Staging staff login refused');
const headers={cookie,origin,'content-type':'application/json'};
const app=body=>read(origin+'/api/voice-outbound',headers,{method:'POST',body:JSON.stringify(body)});
const readiness=(await read(origin+'/api/voice-outbound',headers)).data;
console.log('APP_VOICE_READINESS='+JSON.stringify({mode:readiness.gate?.mode,enabled:readiness.gate?.enabled,blockedReason:readiness.gate?.blockedReason,transport:readiness.transport}));
if(readiness.gate?.mode!=='uat'||!readiness.gate.enabled)throw Error('App voice gate is not enabled for UAT');
const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)+'/d1/database/'+encodeURIComponent(env.STAGING_D1_ID);
const ch={authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'};
const context=await read(base+'/query',ch,{method:'POST',body:JSON.stringify({sql:'SELECT customer_id,city_id FROM voice_call_orders WHERE id=?',params:[env.UAT_VOICE_CALL_ID]})});
if(!context.success)throw Error('Verified staging context query refused');
const row=context.result?.[0]?.results?.[0];if(!row?.customer_id)throw Error('Canonical tester customer missing');
const entries=String(env.PAWSPACE_VOICE_UAT_ALLOWLIST||'').split(/[\s,;]+/).filter(Boolean);
if(entries.length!==1||entries[0].replace(/\D/g,'').slice(-4)!==env.EXPECTED_DESTINATION_LAST4)throw Error('Confirmed single tester required');
const candidates=await read(base+'/query',ch,{method:'POST',body:JSON.stringify(testerCandidateQuery(entries[0]))});
if(!candidates.success||candidates.result?.some(r=>r.success===false))throw Error('Tester ownership read refused');
const ownerIds=[];
for(const candidate of candidates.result.flatMap(r=>r.results||[])){try{ownerIds.push(resolveTesterCustomer([candidate],entries[0]));}catch{}}
if(ownerIds.length){
 const sql='SELECT c.id,c.name,c.source,c.city_id,c.created_at,c.updated_at,substr(c.primary_phone,-4) primary_last4,substr(c.secondary_phone,-4) secondary_last4,(SELECT count(*) FROM canonical_bookings b WHERE b.customer_id=c.id) booking_count,(SELECT count(*) FROM canonical_pets p WHERE p.customer_id=c.id) pet_count FROM canonical_customers c WHERE c.id IN ('+ownerIds.map(()=>'?').join(',')+')';
 const diagnostics=await read(base+'/query',ch,{method:'POST',body:JSON.stringify({sql,params:ownerIds})});
 console.log('APP_TESTER_DUPLICATE_RECORDS='+JSON.stringify(diagnostics.result?.flatMap(r=>r.results||[]).map(r=>({...r,legacyContextOwner:r.id===row.customer_id}))));
}
const customerId=resolveTesterCustomer(candidates.result.flatMap(r=>r.results||[]),entries[0]);
console.log('APP_VOICE_TESTER='+JSON.stringify({uniqueCanonicalOwner:true,legacyContextMatches:customerId===row.customer_id,dialed:false}));
const intent={useCase:'grooming_sales',phone:entries[0],cityId:row.city_id||'blr',customerId};
const policy=(await app({action:'policy_preview',...intent})).data;
console.log('APP_VOICE_POLICY='+JSON.stringify({allowed:policy.allowed,blockedBy:policy.blockedBy,blockedDetail:policy.blockedDetail,dialled:false}));
if(!policy.allowed)throw Error('App policy refused demo: '+policy.blockedBy);
if(env.VOICE_SALE_ACTION==='inspect-app-voice'){console.log('APP_VOICE_INSPECTION_COMPLETE='+JSON.stringify({allowed:policy.allowed,dialed:false}));process.exit(0);}
if(!policy.allowed)throw Error('App policy refused demo: '+policy.blockedBy);
if(!/^\d+$/.test(env.GITHUB_RUN_ID||''))throw Error('Stable workflow idempotency key required');
console.log('APP_VOICE_DIAL_READY='+JSON.stringify({destinationLast4:env.EXPECTED_DESTINATION_LAST4,startedAt:new Date().toISOString()}));
const call=(await app({action:'request_call',idempotencyKey:'voice-app-demo:'+env.GITHUB_RUN_ID,...intent})).data;
if(!call?.providerCallId||String(call.state).startsWith('blocked_'))throw Error('App did not accept a provider call');
console.log('APP_VOICE_CALL_ACCEPTED='+JSON.stringify({callId:call.callId,state:call.state,provider:call.provider,providerCallSuffix:call.providerCallId.slice(-8)}));
const exOrigin=exotelApiOrigin(env.EXOTEL_SUBDOMAIN);
const exHeaders={authorization:'Basic '+Buffer.from(env.EXOTEL_API_KEY+':'+env.EXOTEL_API_TOKEN).toString('base64')};
let carrier;
for(let i=0;i<36;i++){
 await delay(5000);
 const b=await read(exOrigin+'/v1/Accounts/'+encodeURIComponent(env.EXOTEL_SID)+'/Calls/'+encodeURIComponent(call.providerCallId)+'.json',exHeaders);
 const c=b.Call||b.call||b;carrier={status:String(c.Status||c.status||''),duration:Number(c.Duration||c.duration||0)};
 console.log('APP_VOICE_CARRIER='+JSON.stringify(carrier));
 if(['no-answer','busy','failed','canceled'].includes(carrier.status))throw Error('Carrier did not connect: '+carrier.status);
 if(carrier.status==='completed')break;
}
const eh={'xi-api-key':env.ELEVENLABS_API_KEY};
let detail;
for(let attempt=0;attempt<15&&!detail;attempt++){
 const list=await read('https://api.elevenlabs.io/v1/convai/conversations?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID)+'&page_size=20',eh);
 for(const c of list.conversations||[]){
  const d=await read('https://api.elevenlabs.io/v1/convai/conversations/'+encodeURIComponent(c.conversation_id),eh);
  if(d.metadata?.phone_call?.call_sid===call.providerCallId&&['done','failed'].includes(d.status)){detail=d;break;}
 }
 if(!detail)await delay(2000);
}
if(!detail)throw Error('No final provider conversation matched the app call');
const evidence=conversationEvidence(detail,carrier,env.GROOMING_AGENT_ID);
console.log('APP_VOICE_FINAL='+JSON.stringify({callId:call.callId,carrier,evidence,transcript:(detail.transcript||[]).map(t=>({role:t.role,message:String(t.message||'').replace(/\+?\d{10,15}/g,'[number]').slice(0,600)}))}));
if(!evidence.passed)throw Error('App voice conversation not proven: '+evidence.reason);
