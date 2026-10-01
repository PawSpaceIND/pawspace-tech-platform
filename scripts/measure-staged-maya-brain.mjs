import {assertFoodRecovery,FOOD_TURN_AT,FOOD_HANDOFF_AT} from './food-audio-recovery-proof.mjs';
import {PREMIUM_AUDIO_SCENARIOS} from './premium-audio-scenarios.mjs';
// Actual isolated staged brain timings or unconfirmed saved-address quote; never confirms a booking.
import {writeFile,mkdir} from 'node:fs/promises';
import {readDemoJson,validateDemoContext,actionsMaskCommand} from './voice-demo-output-boundary.mjs';
import {syntheticOfferContinuationClear,scopeSyntheticOfferActivity,offerRepairRevision,offerIncidentStart,offerIncidentEnd,offerIncidentPrompt,syntheticOfferRepairChecks,syntheticOfferRepairProof,quoteReplyDiagnostic,savedQuotePrompt,pendingQuoteProof,safeBrainTiming,savedQuotePrerequisites,quoteHandoffReceipt,syntheticQuoteRepairProof,syntheticQuoteRepairChecks,quoteRepairRevision,quoteIncidentStart,quoteIncidentEnd} from './staged-quote-proof.mjs';
import {authorizedLaunchTester} from './voice-sales-launch-preflight.mjs';
import {assertDemoPhonePauseMetadata,assertDemoRuntimePhonePause} from './voice-demo-scenarios.mjs';
function classifySyntheticInput(raw){
 let input;try{input=JSON.parse(raw||'{}').text;}catch{return {kind:'invalid_json'};}
 if(typeof input!=='string')return {kind:'missing_text'};
 const normalized=input.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 const known=PREMIUM_AUDIO_SCENARIOS.flatMap(x=>x.turns).find(x=>x.text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()===normalized);
 const greetings=['hello','hi','hey','hello maya','hi maya','are you there','can you hear me','start','begin'];
 return {kind:known?'normalized_scenario':greetings.includes(normalized)?'greeting':'unclassified',scenario:known?.id??null,greeting:greetings.includes(normalized)?normalized:null,diagnostic:quoteReplyDiagnostic({output_text:input})};
}
const env=process.env,offerRepair=env.MAYA_BRAIN_PROBE_MODE==='repair_offer_handoff',repairOnly=offerRepair||env.MAYA_BRAIN_PROBE_MODE==='repair_quote_handoff',inspectOnly=env.MAYA_BRAIN_PROBE_MODE==='quote_prerequisites',quoteOnly=['quote_only','quote_prerequisites','repair_quote_handoff','repair_offer_handoff'].includes(env.MAYA_BRAIN_PROBE_MODE),origin='https://pawspace-staging.karthik-fce.workers.dev';
authorizedLaunchTester(env);
if(!/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA||'')||!env.SPECIALIST_CUSTOMER_ID||!env.ELEVENLABS_API_KEY||!env.GROOMING_AGENT_ID)throw Error('Exact demo prerequisites missing');
const eleven=(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(eleven))throw Error('Approved voice provider region required');
const headers={'xi-api-key':env.ELEVENLABS_API_KEY};
const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
async function readCf(path,body){const r=await fetch(cf+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok||b.success!==true)throw Error('Staging verification failed');return b.result;}
async function isolation(verifyRuntime=true){
 const db=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID));if(db.name!=='pawspace-staging'||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Isolated demo database required');
 const settings=await readCf('/workers/scripts/pawspace-staging/settings');
 if(settings.annotations?.['workers/message']!=='staging '+env.EXPECTED_SHA)throw Error('Demo staging revision changed');
 const vars=Object.fromEntries(settings.bindings.filter(x=>x.type==='plain_text').map(x=>[x.name,x.text??x.value]));
 assertDemoPhonePauseMetadata(vars);
 if(verifyRuntime){const readiness=await fetch(origin+'/api/voice-outbound',{headers:{cookie},signal:AbortSignal.timeout(30000)}),body=await readDemoJson(readiness);if(!readiness.ok)throw Error('Authenticated runtime phone-shutdown read refused');assertDemoRuntimePhonePause(vars,body.data?.gate);}
 if(vars.PAWSPACE_PAYMENT_ENV!=='sandbox'||vars.PAWSPACE_PAYMENT_LIVE_APPROVED==='true'||!settings.bindings.some(x=>x.type==='d1'&&x.name==='DB'&&x.id===env.STAGING_D1_ID))throw Error('Demo sandbox bindings not proven');
}
async function paymentIds(){const rows=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT id FROM booking_payments WHERE customer_id=? ORDER BY id',params:[env.SPECIALIST_CUSTOMER_ID]});if(!Array.isArray(rows)||rows.length!==1||rows[0]?.success===false||!Array.isArray(rows[0]?.results))throw Error('Business-state readback refused');return rows[0].results.map(x=>x.id);}
async function bookingIds(){const rows=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT id FROM canonical_bookings WHERE customer_id=? ORDER BY id',params:[env.SPECIALIST_CUSTOMER_ID]});if(!Array.isArray(rows)||rows.length!==1||rows[0]?.success===false||!Array.isArray(rows[0]?.results))throw Error('Business-state readback refused');return rows[0].results.map(x=>x.id);}
await isolation(false);
const configResponse=await fetch(eleven+'/v1/convai/agents/'+encodeURIComponent(env.GROOMING_AGENT_ID),{headers,signal:AbortSignal.timeout(30000)}),config=await readDemoJson(configResponse);
if(!configResponse.ok||config.conversation_config?.agent?.prompt?.custom_llm?.url!==origin+'/api/elevenlabs/v1')throw Error('Demo must use the actual PawSpace staging brain');
const login=await fetch(origin+'/api/staging-login',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:'founder@pawspace.in',code:env.PAWSPACE_UAT_ACCESS_CODE}),redirect:'manual',signal:AbortSignal.timeout(20000)});
const cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];if(login.status!==200||!cookie.startsWith('pawspace_uat='))throw Error('Authenticated demo login refused');
await isolation();
async function app(body){const r=await fetch(origin+'/api/ai-voice-uat',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok)throw Error('Governed simulator request refused ('+r.status+')');return b.data;}
const identity=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:'SELECT primary_phone FROM canonical_customers WHERE id=?',params:[env.SPECIALIST_CUSTOMER_ID]});
const customerPhone=String(identity[0]?.results?.[0]?.primary_phone||'').replace(/\D/g,'');
const testerPhone=authorizedLaunchTester(env).replace(/\D/g,'');
if(![testerPhone,testerPhone.slice(2)].includes(customerPhone))throw Error('Demo customer does not own the authorized tester number');

if(!env.ELEVENLABS_LLM_SECRET)throw Error('Staged brain authentication missing');
const before=await bookingIds(),paymentsBefore=await paymentIds();
async function rows(sql,params=[env.SPECIALIST_CUSTOMER_ID]){const data=await readCf('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql,params});if(!Array.isArray(data)||data.length!==1||data[0]?.success===false||!Array.isArray(data[0]?.results))throw Error('Owned quote readback refused');return data[0].results;}
if(env.MAYA_BRAIN_PROBE_MODE==='latest_audio_readonly'){
 const recent=await rows("SELECT t.outcome,t.policy_decision,t.handoff_reason,t.intent_code,t.intent_confidence,t.latency_ms,t.created_at,m.payload_json FROM ai_conversation_turns t JOIN communication_messages m ON m.id=t.input_message_id WHERE t.customer_id=? ORDER BY t.created_at DESC LIMIT 5");
 const turns=recent.map(({payload_json,...turn})=>({...turn,input:classifySyntheticInput(payload_json)}));
 const active=await rows("SELECT status,reason,created_at FROM ai_handoffs WHERE customer_id=? AND status IN ('queued','staff_active') ORDER BY created_at DESC LIMIT 5");
 const turnConfig=config.conversation_config?.turn||{};
 const report={revision:env.EXPECTED_SHA,readOnly:true,dialed:false,turns,activeHandoffs:active,voiceTiming:{softTimeoutSeconds:turnConfig.soft_timeout_config?.timeout_seconds??null,softTimeoutMessage:turnConfig.soft_timeout_config?.message??null,turnTimeout:turnConfig.turn_timeout??null}};
 await isolation();await mkdir('voice-timing-results',{recursive:true});await writeFile('voice-timing-results/report.json',JSON.stringify(report,null,2));console.log('LATEST_AUDIO_DIAGNOSTIC='+JSON.stringify(report));process.exit(0);
}
if(env.MAYA_BRAIN_PROBE_MODE==='repair_food_handoff'){
 if(env.EXPECTED_SHA!=='56ed6d5c831acc8bce523d000c52652b05fe9b00')throw Error('Food FAQ repair must be deployed first');
 const handoffs=await rows('SELECT * FROM ai_handoffs WHERE customer_id=? AND created_at=?',[env.SPECIALIST_CUSTOMER_ID,FOOD_HANDOFF_AT]);if(handoffs.length!==1)throw Error('Exact Food incident missing');const h=handoffs[0];
 const turns=await rows('SELECT t.*,m.payload_json,m.direction,m.created_by input_actor,m.channel input_channel,m.provider input_provider FROM ai_conversation_turns t JOIN communication_messages m ON m.id=t.input_message_id WHERE t.customer_id=? AND t.thread_id=? AND t.created_at=?',[env.SPECIALIST_CUSTOMER_ID,h.thread_id,FOOD_TURN_AT]);if(turns.length!==1)throw Error('Exact Food turn missing');const t=turns[0];
 async function evidence(){return {calls:await rows('SELECT * FROM ai_voice_calls WHERE customer_id=? AND thread_id=? AND started_at<=? AND ended_at>=?',[env.SPECIALIST_CUSTOMER_ID,h.thread_id,FOOD_TURN_AT,FOOD_HANDOFF_AT]),messages:await rows("SELECT id,payload_json,created_by,channel FROM communication_messages WHERE customer_id=? AND thread_id=? AND direction='inbound' AND created_at>=(SELECT created_at FROM communication_messages WHERE id=?) ORDER BY created_at LIMIT 2",[env.SPECIALIST_CUSTOMER_ID,h.thread_id,t.input_message_id]),otherHandoffs:await rows('SELECT id,thread_id,status,taken_over_by,taken_over_at,resumed_by,resumed_at FROM ai_handoffs WHERE customer_id=? AND id<>? ORDER BY id',[env.SPECIALIST_CUSTOMER_ID,h.id]),pending:await rows("SELECT id FROM voice_sales_offers WHERE customer_id=? AND thread_id=? AND status='pending' AND expires_at>=?",[env.SPECIALIST_CUSTOMER_ID,h.thread_id,Date.now()])};}
 const e=await evidence();assertFoodRecovery({customerId:env.SPECIALIST_CUSTOMER_ID,handoff:h,turn:t,...e});
 const addresses=await rows('SELECT * FROM customer_addresses WHERE customer_id=? ORDER BY id'),reservations=await rows('SELECT id,status FROM scheduling_reservations WHERE customer_id=? ORDER BY id');
 async function api(body){const r=await fetch(origin+'/api/ai-human-handoff'+(body?'':'?threadId='+encodeURIComponent(h.thread_id)+'&customerId='+encodeURIComponent(env.SPECIALIST_CUSTOMER_ID)),{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok)throw Error('Governed Food recovery refused');return b.data;}
 await isolation();const snap=await api();if(snap?.current?.id!==h.id||snap.current.status!=='queued'||snap.current.taken_over_by!=null||snap.events?.length!==1||snap.events[0].event_type!=='handoff_requested')throw Error('Staff ownership changed');
 assertFoodRecovery({customerId:env.SPECIALIST_CUSTOMER_ID,handoff:h,turn:t,...await evidence()});
 const body={threadId:h.thread_id,customerId:env.SPECIALIST_CUSTOMER_ID,reason:'Resume only the synthetic Food payment-FAQ false positive from run 36807335313 after tested payment-information repair; no phone outreach'};
 const taken=await api({...body,action:'take_over'});if(taken?.handoff?.id!==h.id||taken.handoff.status!=='staff_active'||taken.handoff.taken_over_by!=='founder@pawspace.in')throw Error('Food takeover not verified');
 await api({...body,action:'resume_ai'});const after=await api();if(after?.aiPaused!==false||after.current?.id!==h.id||after.current.status!=='resumed'||after.current.resumed_by!=='founder@pawspace.in'||after.events?.length!==3||after.events[2].event_type!=='ai_resumed')throw Error('Food resume not verified');
 const unchanged=JSON.stringify(before)===JSON.stringify(await bookingIds())&&JSON.stringify(paymentsBefore)===JSON.stringify(await paymentIds())&&JSON.stringify(addresses)===JSON.stringify(await rows('SELECT * FROM customer_addresses WHERE customer_id=? ORDER BY id'))&&JSON.stringify(reservations)===JSON.stringify(await rows('SELECT id,status FROM scheduling_reservations WHERE customer_id=? ORDER BY id'))&&JSON.stringify(e.otherHandoffs)===JSON.stringify((await evidence()).otherHandoffs);
 if(!unchanged)throw Error('Recovery business state changed');await isolation();const report={revision:env.EXPECTED_SHA,knownSyntheticFoodIncident:true,governedStaffTakeoverVerified:true,governedResumeVerified:true,businessReadbacksUnchanged:true,otherHandoffsUnchanged:true,dialed:false,phoneCallsPaused:true};await mkdir('voice-timing-results',{recursive:true});await writeFile('voice-timing-results/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exit(0);
}
const ordinaryPrompts=['My dog Bruno needs a full bath and a full body haircut. Which one-time grooming package fits that?','I am considering boarding for Bruno for two nights. What information would you need?','No extras please. I only want the grooming information.'];
let prompts=ordinaryPrompts,addressesBefore=[],reservationsBefore=[];
if(quoteOnly){
 const [pets,addresses,geocodes,groups]=await Promise.all([
  rows("SELECT id,name,species FROM canonical_pets WHERE customer_id=? AND species='dog' ORDER BY created_at LIMIT 20"),
  rows('SELECT id,line1,line2,area,city,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,updated_at DESC,created_at DESC'),
  rows('SELECT address_id FROM customer_service_address_geocodes WHERE customer_id=?'),
  rows('SELECT id,status FROM scheduling_reservations WHERE customer_id=? ORDER BY id'),
 ]);

 if(repairOnly){
  const repairRevision=offerRepair?offerRepairRevision:quoteRepairRevision,incidentStart=offerRepair?offerIncidentStart:quoteIncidentStart,incidentEnd=offerRepair?offerIncidentEnd:quoteIncidentEnd;
  if(env.EXPECTED_SHA!==repairRevision||pets.length>=20)throw Error('Verified repair revision required');
  const handoffs=await rows("SELECT * FROM ai_handoffs WHERE customer_id=? AND status IN ('queued','staff_active') AND created_at>=? AND created_at<?",[env.SPECIALIST_CUSTOMER_ID,incidentStart,incidentEnd]);
  if(handoffs.length!==1)throw Error('Exact synthetic quote incident not proven');
  const h=handoffs[0];console.log(actionsMaskCommand(h.thread_id));console.log(actionsMaskCommand(h.id));
  const otherHandoffsBefore=await rows('SELECT id,thread_id,status,taken_over_by,taken_over_at,resumed_by,resumed_at FROM ai_handoffs WHERE customer_id=? AND id<>? ORDER BY id',[env.SPECIALIST_CUSTOMER_ID,h.id]);
  const [calls,windowTurns,windowMessages,pending]=await Promise.all([
   rows("SELECT * FROM ai_voice_calls WHERE customer_id=? AND thread_id=? AND started_at>=? AND started_at<?",[env.SPECIALIST_CUSTOMER_ID,h.thread_id,incidentStart,incidentEnd]),
   rows("SELECT t.*,m.payload_json,m.direction,m.created_by input_actor,m.channel input_channel,m.provider input_provider FROM ai_conversation_turns t JOIN communication_messages m ON m.id=t.input_message_id WHERE t.customer_id=? AND t.thread_id=? AND t.created_at>=? AND t.created_at<?",[env.SPECIALIST_CUSTOMER_ID,h.thread_id,incidentStart,incidentEnd]),
   rows("SELECT payload_json,created_by,channel,created_at FROM communication_messages WHERE customer_id=? AND thread_id=? AND direction='inbound' AND created_at>=? ORDER BY created_at LIMIT 20",[env.SPECIALIST_CUSTOMER_ID,h.thread_id,incidentStart]),
   rows("SELECT id FROM voice_sales_offers WHERE customer_id=? AND thread_id=? AND status='pending' AND expires_at>=?",[env.SPECIALIST_CUSTOMER_ID,h.thread_id,Date.now()]),
  ]);
  const activity=offerRepair?scopeSyntheticOfferActivity({calls,turns:windowTurns,laterMessages:windowMessages}):{turns:windowTurns,laterMessages:windowMessages,diagnostic:null};
  const {turns,laterMessages}=activity;
  if(otherHandoffsBefore.some(x=>x.thread_id===h.thread_id&&['queued','staff_active'].includes(x.status)))throw Error('Another active staff case prevents synthetic cleanup');
  const selected=pets.find(p=>pets.filter(other=>other.name===p.name).length===1);if(!selected)throw Error('Exact synthetic quote incident not proven');
  const expectedPrompt=offerRepair?offerIncidentPrompt:savedQuotePrompt(pets,addresses,geocodes,quoteIncidentStart,selected.id);
  const proof=(offerRepair?syntheticOfferRepairProof:syntheticQuoteRepairProof)({revision:env.EXPECTED_SHA,customerId:env.SPECIALIST_CUSTOMER_ID,handoffs,calls,turns,expectedPrompt});
  if(offerRepair&&!syntheticOfferContinuationClear({activity,otherHandoffs:otherHandoffsBefore,threadId:h.thread_id}))throw Error('Later customer activity or another staff case prevents synthetic cleanup');
  if(!laterMessages.length||laterMessages.length>=20||pending.length||!offerRepair&&laterMessages.some(m=>{let payload;try{payload=JSON.parse(m.payload_json);}catch{return true;}const text=['text','message','body','content'].map(k=>payload?.[k]).find(v=>typeof v==='string'&&v.trim());return text?.trim()!==expectedPrompt.trim()||m.channel!=='voice'||m.created_by!=='elevenlabs-voice@system.pawspace';}))throw Error('Later customer activity prevents synthetic cleanup');
  async function handoffApi(body){const path='/api/ai-human-handoff'+(body?'':'?threadId='+encodeURIComponent(h.thread_id)+'&customerId='+encodeURIComponent(env.SPECIALIST_CUSTOMER_ID));const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)}),b=await readDemoJson(r);if(!r.ok)throw Error('Governed synthetic cleanup refused');return b.data;}
  await isolation();const snapshot=await handoffApi();
  if(snapshot?.current?.id!==h.id||snapshot.current.status!=='queued'||snapshot.current.reason!=='policy_risk'||snapshot.current.taken_over_by!=null||snapshot.current.taken_over_at!=null||!Array.isArray(snapshot.events)||snapshot.events.length!==1||snapshot.events[0].event_type!=='handoff_requested')throw Error('Synthetic handoff changed; no cleanup performed');
  const reason=offerRepair?'Resume only the self-generated named-package offer policy-risk case from non-dialing audio demo 36793666839 after certified offer-response repair; no phone outreach':'Reset only the self-generated unconfirmed-quote policy false-positive from sandbox probe 36786494207 after verified quote-parser repair; no phone outreach';
  const body={threadId:h.thread_id,customerId:env.SPECIALIST_CUSTOMER_ID,reason};
  const taken=await handoffApi({...body,action:'take_over'});
  if(taken?.handoff?.id!==h.id||taken.handoff.status!=='staff_active'||taken.handoff.taken_over_by!=='founder@pawspace.in')throw Error('Explicit staff takeover not verified; AI remains paused');
  await isolation();const claimed=await handoffApi();
  if(claimed?.current?.id!==h.id||claimed.current.status!=='staff_active'||claimed.events?.length!==2||claimed.events[1].event_type!=='staff_takeover'||claimed.events[1].actor_email!=='founder@pawspace.in'||JSON.parse(claimed.events[1].detail_json||'{}').reason!==reason)throw Error('Staff handoff changed; AI remains paused');
  await handoffApi({...body,action:'resume_ai'});const verified=await handoffApi();
  if(verified?.aiPaused!==false||verified.current?.id!==h.id||verified.current.status!=='resumed'||verified.current.resumed_by!=='founder@pawspace.in'||verified.events?.length!==3||verified.events[2].event_type!=='ai_resumed')throw Error('Governed cleanup readback not verified');
  const [bookingsAfter,paymentsAfter,addressesAfter,reservationsAfter]=await Promise.all([bookingIds(),paymentIds(),rows('SELECT id,line1,line2,area,city,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC,updated_at DESC,created_at DESC'),rows('SELECT id,status FROM scheduling_reservations WHERE customer_id=? ORDER BY id')]);
  if(JSON.stringify(before)!==JSON.stringify(bookingsAfter)||JSON.stringify(paymentsBefore)!==JSON.stringify(paymentsAfter)||JSON.stringify(addresses)!==JSON.stringify(addressesAfter)||JSON.stringify(groups)!==JSON.stringify(reservationsAfter))throw Error('Synthetic cleanup business readback changed');
  const otherHandoffsAfter=await rows('SELECT id,thread_id,status,taken_over_by,taken_over_at,resumed_by,resumed_at FROM ai_handoffs WHERE customer_id=? AND id<>? ORDER BY id',[env.SPECIALIST_CUSTOMER_ID,h.id]);if(JSON.stringify(otherHandoffsBefore)!==JSON.stringify(otherHandoffsAfter))throw Error('Other handoff state changed; further test execution stopped');
  await isolation();const report={revision:env.EXPECTED_SHA,...proof,offerActivityScope:activity.diagnostic,otherHandoffStatesUnchanged:true,governedStaffTakeoverVerified:true,governedResumeVerified:true,phoneCallsPaused:true,businessReadbacksUnchanged:true,bookingCreated:false,paymentCaptured:false,modelRequested:false,externalMessageSent:false,premiumCertified:false};
  await mkdir('voice-timing-results',{recursive:true});await writeFile('voice-timing-results/report.json',JSON.stringify(report,null,2));console.log('SYNTHETIC_QUOTE_CLEANUP='+JSON.stringify(report));process.exit(0);
 }
 const prerequisites=savedQuotePrerequisites(pets,addresses,geocodes);
 console.log('SAVED_QUOTE_PREREQUISITES='+JSON.stringify(prerequisites));
 if(inspectOnly){
  await isolation();
  const threads=await rows("SELECT id FROM communication_threads WHERE customer_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1");let handoff={aiPaused:false,handoffs:[],recentTurns:[]},repairPrerequisiteChecks=null,latestQuoteReply=null;const activeCustomerHandoffs=await rows("SELECT id FROM ai_handoffs WHERE customer_id=? AND status IN ('queued','staff_active') LIMIT 3");const activeCustomerHandoffsBoundedAtTwo=Math.min(2,activeCustomerHandoffs.length);
  if(threads.length){const [handoffs,turns]=await Promise.all([
   rows("SELECT * FROM ai_handoffs WHERE customer_id=? AND thread_id=? ORDER BY created_at DESC LIMIT 5",[env.SPECIALIST_CUSTOMER_ID,threads[0].id]),
   rows('SELECT outcome,policy_decision,handoff_reason,output_text,provider,model_ref,intent_code,intent_confidence FROM ai_conversation_turns WHERE customer_id=? AND thread_id=? ORDER BY created_at DESC LIMIT 3',[env.SPECIALIST_CUSTOMER_ID,threads[0].id]),
  ]);handoff=quoteHandoffReceipt(handoffs,turns);latestQuoteReply=quoteReplyDiagnostic(turns[0]);
   const active=handoffs.filter(h=>['queued','staff_active'].includes(h.status));
   const [incidentCalls,incidentTurns]=await Promise.all([rows('SELECT * FROM ai_voice_calls WHERE customer_id=? AND thread_id=? AND started_at>=? AND started_at<?',[env.SPECIALIST_CUSTOMER_ID,threads[0].id,quoteIncidentStart,quoteIncidentEnd]),rows('SELECT t.*,m.payload_json,m.direction,m.created_by input_actor,m.channel input_channel,m.provider input_provider FROM ai_conversation_turns t JOIN communication_messages m ON m.id=t.input_message_id WHERE t.customer_id=? AND t.thread_id=? AND t.created_at>=? AND t.created_at<?',[env.SPECIALIST_CUSTOMER_ID,threads[0].id,quoteIncidentStart,quoteIncidentEnd])]);
   const selected=pets.find(p=>pets.filter(other=>other.name===p.name).length===1);let expectedPrompt;try{expectedPrompt=savedQuotePrompt(pets,addresses,geocodes,quoteIncidentStart,selected?.id);}catch{}
   repairPrerequisiteChecks=syntheticQuoteRepairChecks({revision:env.EXPECTED_SHA,customerId:env.SPECIALIST_CUSTOMER_ID,handoffs:active,calls:incidentCalls,turns:incidentTurns,expectedPrompt});
  }
  const quoteProbeStarted=Date.parse('2026-09-30T23:50:58Z'),quoteProbeEnded=Date.parse('2026-09-30T23:51:32Z');
  const controlledTurns=await rows('SELECT t.output_text,t.policy_decision,m.payload_json FROM ai_conversation_turns t JOIN communication_messages m ON m.id=t.input_message_id WHERE t.customer_id=? AND t.created_at>=? AND t.created_at<? ORDER BY t.created_at DESC LIMIT 2',[env.SPECIALIST_CUSTOMER_ID,quoteProbeStarted,quoteProbeEnded]);
  const selectedProbePet=pets.find(p=>pets.filter(other=>other.name===p.name).length===1);const expectedProbeInput=savedQuotePrompt(pets,addresses,geocodes,quoteProbeStarted,selectedProbePet?.id);
  const controlledQuoteTurnMatched=controlledTurns.length===1&&JSON.parse(controlledTurns[0].payload_json||'{}').text===expectedProbeInput;
  const controlledQuoteReply=controlledQuoteTurnMatched?quoteReplyDiagnostic(controlledTurns[0]):null;
  const offerIncidentStart=Date.parse('2026-10-01T00:00:00Z'),offerIncidentEnd=Date.parse('2026-10-01T00:01:00Z');
  const offerInput='The Complete Makeover price feels high. Is there an approved offer for that package?';
  const offerTurns=await rows('SELECT t.*,m.payload_json,m.created_by input_actor,m.direction,m.channel input_channel,m.provider input_provider FROM ai_conversation_turns t JOIN communication_messages m ON m.id=t.input_message_id WHERE t.customer_id=? AND t.created_at>=? AND t.created_at<? ORDER BY t.created_at DESC LIMIT 20',[env.SPECIALIST_CUSTOMER_ID,offerIncidentStart,offerIncidentEnd]);
  const matchingOfferTurns=offerTurns.filter(t=>JSON.parse(t.payload_json||'{}').text===offerInput);let controlledOfferIncident={singleTurn:matchingOfferTurns.length===1},offerRepairPrerequisiteChecks=null,offerActivityScope=null,offerContinuationClear=null,otherActiveOfferThreadCasesBounded=null;
  if(matchingOfferTurns.length===1){const t=matchingOfferTurns[0];const [hs,cs]=await Promise.all([rows('SELECT * FROM ai_handoffs WHERE customer_id=? AND thread_id=? AND created_at>=? AND created_at<?',[env.SPECIALIST_CUSTOMER_ID,t.thread_id,offerIncidentStart,offerIncidentEnd]),rows('SELECT * FROM ai_voice_calls WHERE customer_id=? AND thread_id=? AND started_at>=? AND started_at<?',[env.SPECIALIST_CUSTOMER_ID,t.thread_id,offerIncidentStart,offerIncidentEnd])]);const [offerLaterMessages,otherActiveCases]=await Promise.all([rows("SELECT payload_json,created_by,channel,created_at FROM communication_messages WHERE customer_id=? AND thread_id=? AND direction='inbound' AND created_at>=? ORDER BY created_at LIMIT 20",[env.SPECIALIST_CUSTOMER_ID,t.thread_id,offerIncidentStart]),rows("SELECT id,thread_id,status FROM ai_handoffs WHERE customer_id=? AND thread_id=? AND id<>? AND status IN ('queued','staff_active') LIMIT 2",[env.SPECIALIST_CUSTOMER_ID,t.thread_id,hs[0]?.id||''])]);otherActiveOfferThreadCasesBounded=otherActiveCases.length;const activity=scopeSyntheticOfferActivity({calls:cs,turns:offerTurns.filter(x=>x.thread_id===t.thread_id),laterMessages:offerLaterMessages});offerActivityScope={...activity.diagnostic,turns:activity.turns.map(row=>({inputClassification:classifySyntheticInput(row.payload_json),knownScenarioId:PREMIUM_AUDIO_SCENARIOS.flatMap(x=>x.turns).find(x=>x.text===JSON.parse(row.payload_json||'{}').text)?.id??null,emptyInput:!JSON.parse(row.payload_json||'{}').text,policyDecision:row.policy_decision,outcome:row.outcome,createdBeforeOffer:row.created_at<t.created_at,actorVerified:row.input_actor==='elevenlabs-voice@system.pawspace'&&row.input_channel==='voice'&&row.direction==='inbound'&&row.input_provider==='elevenlabs'})),inbound:activity.laterMessages.map(row=>({inputClassification:classifySyntheticInput(row.payload_json),knownScenarioId:PREMIUM_AUDIO_SCENARIOS.flatMap(x=>x.turns).find(x=>x.text===JSON.parse(row.payload_json||'{}').text)?.id??null,emptyInput:!JSON.parse(row.payload_json||'{}').text,createdBeforeOffer:row.created_at<t.created_at,actorVerified:row.created_by==='elevenlabs-voice@system.pawspace'&&row.channel==='voice'}))};offerContinuationClear=syntheticOfferContinuationClear({activity,otherHandoffs:otherActiveCases,threadId:t.thread_id});offerRepairPrerequisiteChecks=syntheticOfferRepairChecks({revision:env.EXPECTED_SHA,customerId:env.SPECIALIST_CUSTOMER_ID,handoffs:hs,calls:cs,turns:activity.turns,expectedPrompt:offerInput});controlledOfferIncident={singleTurn:true,turnCreatedAt:t.created_at,turnBlockedRisk:t.outcome==='handoff'&&t.policy_decision==='blocked_high_impact'&&t.handoff_reason==='policy_risk',inputActorVerified:t.input_actor==='elevenlabs-voice@system.pawspace'&&t.direction==='inbound'&&t.input_channel==='voice'&&t.input_provider==='elevenlabs',singleHandoff:hs.length===1,handoffCreatedAt:hs[0]?.created_at??null,handoffQueuedRisk:hs[0]?.status==='queued'&&hs[0]?.reason==='policy_risk',noStaffActivity:hs[0]?.taken_over_by==null&&hs[0]?.resumed_by==null,singleCall:cs.length===1,callStartedAt:cs[0]?.started_at??null,callFailed:cs[0]?.status==='failed',syntheticCall:cs[0]?.transport_provider==='sandbox_simulator'&&cs[0]?.direction==='inbound'&&cs[0]?.consent_status==='verified'&&cs[0]?.created_by==='founder@pawspace.in'};}
  const report={revision:env.EXPECTED_SHA,dialed:false,premiumCertified:false,modelRequested:false,voiceContextCreated:false,bookingCreated:false,paymentCaptured:false,scope:'Read-only owned saved-quote prerequisites; no quote or business execution',prerequisites,offerRepairPrerequisiteChecks,offerActivityScope,offerContinuationClear,otherActiveOfferThreadCasesBounded,controlledOfferIncident,controlledQuoteTurnMatched,controlledQuoteReply,configuredGroomingSalesModel:config.conversation_config.agent.prompt.custom_llm.model_id==='pawspace-grooming-sales',handoff,latestQuoteReply,repairPrerequisiteChecks,activeCustomerHandoffsBoundedAtTwo};
  await mkdir('voice-timing-results',{recursive:true});await writeFile('voice-timing-results/report.json',JSON.stringify(report,null,2));console.log('SAVED_QUOTE_INSPECTION='+JSON.stringify(report));process.exit(0);
 }
 addressesBefore=[...addresses].sort((a,b)=>a.id.localeCompare(b.id));reservationsBefore=groups;if(pets.length>=20)throw Error('Owned pet inspection limit reached');const selected=pets.find(p=>pets.filter(other=>other.name===p.name).length===1);if(!selected)throw Error('Owned pet choice is ambiguous');prompts=[savedQuotePrompt(pets,addresses,geocodes,Date.now(),selected.id)];
}
const context=await app({action:'start',customerId:env.SPECIALIST_CUSTOMER_ID,direction:'inbound',transportProvider:'sandbox_simulator',consent:true,language:'en'});
validateDemoContext(context);console.log(actionsMaskCommand(context.callId));console.log(actionsMaskCommand(context.threadId));
if(!context.callId||!context.threadId)throw Error('Governed timing context missing');
const results=[];let quoteProof=null,phase='quote_baseline',replyObservation=null,readbacksVerified=false;
try{
 if(quoteOnly){const pending=await rows("SELECT id FROM voice_sales_offers WHERE customer_id=? AND thread_id=? AND status='pending' AND expires_at>=?",[env.SPECIALIST_CUSTOMER_ID,context.threadId,Date.now()]);if(pending.length)throw Error('Active customer quote prevents isolated preparation');}
 for(const prompt of prompts){
  phase='request';await isolation();const started=Date.now();
  const response=await fetch(origin+'/api/elevenlabs/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+env.ELEVENLABS_LLM_SECRET},body:JSON.stringify({model:config.conversation_config.agent.prompt.custom_llm.model_id,input:prompt,elevenlabs_extra_body:{pawspace_customer_id:env.SPECIALIST_CUSTOMER_ID,pawspace_thread_id:context.threadId}}),signal:AbortSignal.timeout(30000)});
  if(!response.ok||!response.body)throw Error('Staged brain probe refused');
  phase='response';const headersMs=Date.now()-started;let firstDeltaMs=null,buffer='',completed=null,failed=false,reply='',receivedBytes=0;const decoder=new TextDecoder();
  for await(const chunk of response.body){receivedBytes+=chunk.byteLength;if(receivedBytes>128*1024)throw Error('Staged brain response exceeds evidence limit');buffer+=decoder.decode(chunk,{stream:true});let newline;
   while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);if(!line.startsWith('data: {'))continue;const event=JSON.parse(line.slice(6));
    if(event.type==='response.output_text.delta'){reply+=String(event.delta||'');if(reply.length>12000)throw Error('Staged brain reply exceeds evidence limit');if(reply.trim()&&firstDeltaMs===null)firstDeltaMs=Date.now()-started;}
    if(event.type==='response.failed')failed=true;
    if(event.type==='response.completed')completed=event.response;
   }
  }
  if(failed||!completed||firstDeltaMs===null||!completed.pawspace_timing)throw Error('Staged brain probe did not complete with timing evidence');
  replyObservation={characters:reply.length,mentionsCompleteMakeover:/Complete Makeover/i.test(reply),mentionsNotReserved:/not reserved/i.test(reply),mentionsStaff:/team member|human|staff|cannot continue/i.test(reply),asksQuestion:/\?/.test(reply)};phase='business_readback';
  if(JSON.stringify(before)!==JSON.stringify(await bookingIds())||JSON.stringify(paymentsBefore)!==JSON.stringify(await paymentIds()))throw Error('Informational timing probe changed booking or payment sets');
  if(quoteOnly){
   const [offers,addresses,groups]=await Promise.all([
    rows('SELECT status,service_code,summary,expires_at,quote_json FROM voice_sales_offers WHERE customer_id=? AND thread_id=? ORDER BY created_at',[env.SPECIALIST_CUSTOMER_ID,context.threadId]),
    rows('SELECT id,line1,line2,area,city,postal_code FROM customer_addresses WHERE customer_id=? ORDER BY id'),
    rows('SELECT id,status FROM scheduling_reservations WHERE customer_id=? ORDER BY id'),
   ]);
   if(JSON.stringify(addressesBefore)!==JSON.stringify(addresses)||JSON.stringify(reservationsBefore)!==JSON.stringify(groups))throw Error('Quote changed address or reservation records');
   readbacksVerified=true;phase='pending_quote_proof';quoteProof=pendingQuoteProof(offers.filter(x=>Number(x.expires_at)>=Date.now()&&x.status==='pending'),reply);
  }
  results.push({prompt:quoteOnly?'Saved-address unconfirmed Grooming quote (private intake omitted)':prompt,headersMs,firstValidatedDeltaMs:firstDeltaMs,totalMs:Date.now()-started,timing:safeBrainTiming(completed.pawspace_timing)});
 }
 await isolation();await app({action:'complete',callId:context.callId,outcome:quoteOnly?'synthetic_quote_only_probe':'synthetic_timing_probe',disposition:'info_shared'});
 const report={revision:env.EXPECTED_SHA,dialed:false,premiumCertified:false,bookingSetUnchanged:true,paymentSetUnchanged:true,scope:quoteOnly?'Actual staged unconfirmed saved-address quote only; no customer confirmation, delivered checkout, capture, assignment or audio certification':'Actual staged brain timings; excludes ASR, TTS and handset',...(quoteOnly?{quoteProof,addressSetUnchanged:true,reservationRecordsUnchanged:true}:{}),results};
 await mkdir('voice-timing-results',{recursive:true});await writeFile('voice-timing-results/report.json',JSON.stringify(report,null,2));console.log('STAGED_BRAIN_TIMINGS='+JSON.stringify(report));
}catch(error){
 const known=new Set(['Active customer quote prevents isolated preparation','Staged brain probe refused','Staged brain probe did not complete with timing evidence','Informational timing probe changed booking or payment sets','Quote changed address or reservation records','One persisted pending quote required','Pending quote evidence invalid','Staged timing evidence invalid']);
 const report={revision:env.EXPECTED_SHA,dialed:false,premiumCertified:false,passed:false,phase,reason:known.has(error?.message)?error.message:'Staged verification failed',replyObservation,readbacksVerified,confirmationSent:false,scope:'Failed non-dialing quote/timing probe; private input and raw provider errors omitted'};
 await mkdir('voice-timing-results',{recursive:true});await writeFile('voice-timing-results/report.json',JSON.stringify(report,null,2));console.log('STAGED_PROBE_FAILURE='+JSON.stringify(report));
 await app({action:'transport_failure',callId:context.callId,reason:quoteOnly?'synthetic_quote_only_probe_failed':'synthetic_timing_probe_failed',reconnected:false}).catch(()=>{});throw Error('Staged brain verification failed; no phone call or confirmation was sent');}
