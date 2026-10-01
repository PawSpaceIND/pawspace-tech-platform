import {serviceAddressText} from '../lib/service-address-text.ts';

export function savedQuotePrerequisites(pets,addresses,geocodes){
 const dogCount=Math.min(2,pets.filter(p=>p.species==='dog').length),address=addresses[0];
 return{dogCountBoundedAtTwo:dogCount,savedAddressPresent:Boolean(address),savedAddressGeocoded:Boolean(address&&geocodes.some(g=>g.address_id===address.id))};
}

export function quoteHandoffReceipt(handoffs,turns){
 const reasons=new Set(['customer_requested_human','low_confidence','provider_unavailable','provider_error','provider_unsupported','policy_risk','complaint','safety','refund_payment_dispute','urgent_funeral_memorial','sensitive_relocation','unsupported_request','rollout_gated','high_value_enterprise_objection','staff_initiated','bot_lead_qualified','bot_abandoned']);
 const decisions=new Set(['human_handoff','blocked_high_impact','customer_confirmation_required','clarification_required','customer_confirmed_action_executed','draft_review_required']);
 return{aiPaused:handoffs.some(h=>['queued','staff_active'].includes(h.status)),handoffs:handoffs.slice(0,5).map(h=>({status:['queued','staff_active','resumed'].includes(h.status)?h.status:'other',reason:reasons.has(h.reason)?h.reason:'other'})),recentTurns:turns.slice(0,3).map(t=>({provider:['approved_offer_catalogue','conversation_preference','openai','anthropic','deterministic_clarification'].includes(t.provider)?t.provider:'other',serverOfferModel:t.model_ref==='server_owned_offers',confidence:Number.isFinite(t.intent_confidence)?t.intent_confidence:null,outcome:['handoff','reply_ready','draft_review_required'].includes(t.outcome)?t.outcome:'other',policyDecision:decisions.has(t.policy_decision)?t.policy_decision:'other',handoffReason:reasons.has(t.handoff_reason)?t.handoff_reason:null}))};
}

// Only existing owned records supplied by parameterized staging reads. No invented intake facts.
export function savedQuotePrompt(pets,addresses,geocodes,now=Date.now(),selectedOwnedPetId){
 const allDogs=pets.filter(p=>p.species==='dog');
 const dogs=selectedOwnedPetId?allDogs.filter(p=>p.id===selectedOwnedPetId):allDogs;
 const address=addresses[0];
 if(dogs.length!==1||!address||!geocodes.some(g=>g.address_id===address.id))throw Error('Saved quote prerequisites unavailable');
 const pet=dogs[0];
 if(allDogs.filter(p=>p.name===pet.name).length!==1)throw Error('Saved quote prerequisites unavailable');
 if(typeof pet.name!=='string'||!pet.name.trim()||pet.name.length>80||/[\r\n\x00-\x1f]/.test(pet.name)||typeof address.line1!=='string'||address.line1.length<8||!/^\d{6}$/.test(address.postal_code||''))throw Error('Saved quote prerequisites unavailable');
 const text=serviceAddressText({line1:address.line1,line2:address.line2,area:address.area,city:address.city,postalCode:address.postal_code});
 if(text.length>500||/[\r\n\x00-\x1f]/.test(text))throw Error('Saved quote prerequisites unavailable');
 const date=new Date(now+7*86400000).toISOString().slice(0,10);
 return `Please prepare an unconfirmed quote for one-time Complete Makeover for my saved dog ${JSON.stringify(pet.name)}, prepaid, ${date} at 10 AM India time, at my saved address ${JSON.stringify(text)}, PIN ${address.postal_code}. Do not reserve or create a booking or payment order. Read the quote and ask for my separate confirmation.`;
}

export function pendingQuoteProof(rows,reply,now=Date.now()){
 if(!Array.isArray(rows)||rows.length!==1)throw Error('One persisted pending quote required');
 const row=rows[0];
 if(row.status!=='pending'||row.service_code!=='grooming'||!Number.isFinite(Number(row.expires_at))||Number(row.expires_at)<=now||typeof row.summary!=='string'||row.summary.length>3000||typeof row.quote_json!=='string'||row.quote_json.length>16000||typeof reply!=='string'||reply.length>12000||reply.trim()!==row.summary.trim())throw Error('Pending quote evidence invalid');
 let quote;try{quote=JSON.parse(row.quote_json);}catch{throw Error('Pending quote evidence invalid');}
 if(quote.packageCode!=='dog-makeover'||!Number.isFinite(quote.totalAmount)||quote.totalAmount<=0||quote.coupon||!/\bavailability was checked\b[^.!?]{0,60}\bnot reserved\b/i.test(row.summary)||!/confirm|shall I reserve/i.test(row.summary)||!/Complete Makeover/i.test(reply)||!/not reserved/i.test(reply))throw Error('Pending quote evidence invalid');
 return{pendingQuotes:1,service:'grooming',packageCode:quote.packageCode,totalAmount:quote.totalAmount,expiresInMs:Number(row.expires_at)-now,separateConfirmationRequired:true,reservationCreated:false,bookingCreated:false,paymentOrderCreated:false,assignmentCertified:false};
}

export function safeBrainTiming(input){
 const marks=['runtimeEnv','auth','bodyRead','bodyParse','database','schema','context','inboundWriteStarted','handoffChecked','provider','groundingStarted','groundingCompleted','governanceStarted','governanceCompleted','reservationStarted','reservationCompleted','canonicalContext','model','replyWrite','orchestrator'];
 if(!input||typeof input!=='object'||!['orchestrator','fast','emergency_guidance','human_handoff'].includes(input.path))throw Error('Staged timing evidence invalid');
 const out={path:input.path};
 for(const key of marks){const v=input[key];if(v!==undefined){if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>120000)throw Error('Staged timing evidence invalid');out[key]=v;}}
 return out;
}

// One known self-generated sandbox incident only; never accepts arbitrary staff/customer cases.
export const quoteRepairRevision='1e62e969512b70614e8badcc8fdb3c7bbd4140a6';
export const quoteIncidentStart=Date.parse('2026-09-30T22:36:19Z');
export const quoteIncidentEnd=Date.parse('2026-09-30T22:36:24Z');
export function syntheticQuoteRepairChecks({revision,customerId,handoffs,calls,turns,expectedPrompt}){
 const h=handoffs?.[0]||{},c=calls?.[0]||{},t=turns?.[0]||{};
 const incidentTime=x=>typeof x==='number'&&Number.isFinite(x)&&x>=quoteIncidentStart&&x<quoteIncidentEnd;
 let payload;try{payload=JSON.parse(t.payload_json);}catch{}
 const actual=['text','message','body','content'].map(k=>payload?.[k]).find(v=>typeof v==='string'&&v.trim());
 return{
  repairedRevision:revision===quoteRepairRevision,
  expectedPromptBounded:typeof expectedPrompt==='string'&&expectedPrompt.length<=2000,
  singleHandoff:Array.isArray(handoffs)&&handoffs.length===1,
  singleCall:Array.isArray(calls)&&calls.length===1,
  singleTurn:Array.isArray(turns)&&turns.length===1,
  ownedRecords:Boolean(customerId)&&h.customer_id===customerId&&c.customer_id===customerId&&t.customer_id===customerId,
  sameThread:Boolean(h.thread_id)&&h.thread_id===c.thread_id&&h.thread_id===t.thread_id,
  sameSession:Boolean(h.session_id)&&h.session_id===t.session_id,
  handoffIdentity:/^AIHO-[a-f0-9-]{36}$/.test(h.id||''),
  handoffRequester:h.requested_by==='elevenlabs-voice@system.pawspace',
  queuedPolicyRisk:h.status==='queued'&&h.reason==='policy_risk',
  noStaffActivity:h.taken_over_by==null&&h.taken_over_at==null&&h.resumed_by==null&&h.resumed_at==null,
  handoffInIncident:incidentTime(h.created_at),callInIncident:incidentTime(c.started_at),turnInIncident:incidentTime(t.created_at),
  syntheticInbound:c.transport_provider==='sandbox_simulator'&&c.direction==='inbound'&&c.consent_status==='verified',
  callCreator:c.created_by==='founder@pawspace.in',callFailed:c.status==='failed',
  policyTurn:t.outcome==='handoff'&&t.policy_decision==='blocked_high_impact'&&t.handoff_reason==='policy_risk',
  canonicalVoiceInput:t.direction==='inbound'&&t.input_actor==='elevenlabs-voice@system.pawspace'&&t.input_channel==='voice'&&t.input_provider==='elevenlabs',
  exactInput:typeof expectedPrompt==='string'&&actual?.trim()===expectedPrompt.trim(),
 };
}
export function syntheticQuoteRepairProof(input){
 if(!Object.values(syntheticQuoteRepairChecks(input)).every(v=>v===true))throw Error('Exact synthetic quote incident not proven');
 return{singleKnownSyntheticIncident:true,staffTakeoverObserved:false,exactInputVerified:true,governedStaffResumeRequired:true,dialed:false};
}

// Receipt emits fixed classifications only; never the persisted customer-facing text.
export function quoteReplyDiagnostic(turn){
 const text=typeof turn?.output_text==='string'&&turn.output_text.length<=12000?turn.output_text:'';
 const known={
  unsupported_fields:'Sales proposal contains unsupported or server-authoritative fields',
  action_order:'Sales checkout must propose reservation, booking and payment order in that order',
  pet_mismatch:'Booking pets differ from the proposed appointment',
  missing_pet:'Select one to four saved pets before checkout',
  missing_address:'A complete service address and six-digit PIN are required',
  future_appointment:'A future appointment is required',
  prepaid_only:'This sales flow supports prepaid Grooming purchases only',
  availability_unverified:'Current availability could not be verified',
  no_provider:'No eligible provider is available for this proposed schedule',
  coupon_ineligible:'That coupon is not an offer PawSpace AI can apply for this customer',
  info_action_rejected:'This was an information-only question',
 };
 const matches=Object.entries(known).filter(([,phrase])=>text.includes(phrase)).map(([key])=>key);
 const common=new Set('i im can cannot could would you your yours my me our we it its this that the a an to for from of with without and or but not no yes do does did am is are be been as at on in if once after before first then now here there please thanks sorry help prepare provide unconfirmed quote draft separate confirmation confirm like want need requires required able unable access retrieve calculate check read back exact details information terms price pricing booking payment order reservation saved dog pet address time date system customer service account verified contact profile permission proceed amounts current total start ready available asked asking request requested'.split(' '));
 const redactedWording=text.toLowerCase().match(/[a-z]+|[?.!,:;]/g)?.slice(0,160).map(token=>common.has(token)||/^[?.!,:;]$/.test(token)?token:'[omitted]').join(' ')||'';
 return{redactedWording,characters:text.length,knownWords:['quote','prepare','coat','size','weight','aggression','vaccination','duration','service','prepaid','grooming','confirm','saved','pet','dog','health','requirements','temperament','booking','available','reserve','price','payment','order','need','cannot','sorry','safety','offer','details','consent','one-time','subscription','information','provide','could','check','you','anything','else','help','with','that','confirming','confirmation','unconfirmed','draft','read','separate','terms','once','ready','want','like','proceed','would','can','will','make','changes','before','first','for','your','my','the','an','not','without','create'].filter(word=>new RegExp('\\b'+word+'\\b','i').test(text)),reason:matches.length===1?matches[0]:'unclassified',serverQuoteRetry:text.startsWith("I couldn't prepare that booking yet:"),asksQuestion:text.includes('?'),questionTopics:{pet:/\b(?:which pet|pet name|which dog|breed|age)\b/i.test(text),address:/\b(?:address|PIN|pincode)\b/i.test(text),appointment:/\b(?:date|time|appointment)\b/i.test(text),package:/\b(?:package|grooming|makeover)\b/i.test(text)},policyDecision:['customer_confirmation_required','clarification_required','sales_offer_retry_required','information_only_action_rejected'].includes(turn?.policy_decision)?turn.policy_decision:'other'};
}

// Known non-dialing audio demo 36793666839 only; not a general customer-case reset.
export const offerRepairRevision='5c4d7e780024574dd7f900c1026d5e355e04a47c';
export const offerIncidentStart=Date.parse('2026-10-01T00:00:00Z');
export const offerIncidentEnd=Date.parse('2026-10-01T00:01:00Z');
export const offerIncidentPrompt='The Complete Makeover price feels high. Is there an approved offer for that package?';
export function syntheticOfferRepairChecks({revision,customerId,handoffs,calls,turns,expectedPrompt}){
 const h=handoffs?.[0]||{},c=calls?.[0]||{},t=turns?.[0]||{};
 const incidentTime=x=>typeof x==='number'&&Number.isFinite(x)&&x>=offerIncidentStart&&x<offerIncidentEnd;
 let payload;try{payload=JSON.parse(t.payload_json);}catch{}
 const actual=['text','message','body','content'].map(k=>payload?.[k]).find(v=>typeof v==='string'&&v.trim());
 return{
  repairedRevision:revision===offerRepairRevision,
  expectedPromptBounded:expectedPrompt===offerIncidentPrompt,
  singleHandoff:Array.isArray(handoffs)&&handoffs.length===1,
  singleCall:Array.isArray(calls)&&calls.length===1,
  singleTurn:Array.isArray(turns)&&turns.length===1,
  ownedRecords:Boolean(customerId)&&h.customer_id===customerId&&c.customer_id===customerId&&t.customer_id===customerId,
  sameThread:Boolean(h.thread_id)&&h.thread_id===c.thread_id&&h.thread_id===t.thread_id,
  sameSession:Boolean(h.session_id)&&h.session_id===t.session_id,
  handoffIdentity:/^AIHO-[a-f0-9-]{36}$/.test(h.id||''),
  handoffRequester:h.requested_by==='elevenlabs-voice@system.pawspace',
  queuedPolicyRisk:h.status==='queued'&&h.reason==='policy_risk',
  noStaffActivity:h.taken_over_by==null&&h.taken_over_at==null&&h.resumed_by==null&&h.resumed_at==null,
  handoffInIncident:incidentTime(h.created_at),callInIncident:incidentTime(c.started_at),turnInIncident:incidentTime(t.created_at),
  syntheticInbound:c.transport_provider==='sandbox_simulator'&&c.direction==='inbound'&&c.consent_status==='verified',
  callCreator:c.created_by==='founder@pawspace.in',callFailed:c.status==='failed'&&c.disposition==='synthetic_audio_demo_failed'&&incidentTime(c.ended_at),
  policyTurn:t.provider==='openai'&&t.outcome==='handoff'&&t.policy_decision==='blocked_high_impact'&&t.handoff_reason==='policy_risk',
  canonicalVoiceInput:t.direction==='inbound'&&t.input_actor==='elevenlabs-voice@system.pawspace'&&t.input_channel==='voice'&&t.input_provider==='elevenlabs',
  exactInput:typeof expectedPrompt==='string'&&actual?.trim()===expectedPrompt.trim(),
 };
}
export function syntheticOfferRepairProof(input){
 if(!Object.values(syntheticOfferRepairChecks(input)).every(v=>v===true))throw Error('Exact synthetic offer incident not proven');
 return{singleKnownSyntheticIncident:true,staffTakeoverObserved:false,exactInputVerified:true,governedStaffResumeRequired:true,dialed:false};
}
