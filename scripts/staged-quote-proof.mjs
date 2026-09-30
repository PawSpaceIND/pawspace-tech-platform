import {serviceAddressText} from '../lib/service-address-text.ts';

export function savedQuotePrerequisites(pets,addresses,geocodes){
 const dogCount=Math.min(2,pets.filter(p=>p.species==='dog').length),address=addresses[0];
 return{dogCountBoundedAtTwo:dogCount,savedAddressPresent:Boolean(address),savedAddressGeocoded:Boolean(address&&geocodes.some(g=>g.address_id===address.id))};
}

export function quoteHandoffReceipt(handoffs,turns){
 const reasons=new Set(['customer_requested_human','low_confidence','provider_unavailable','provider_error','provider_unsupported','policy_risk','complaint','safety','refund_payment_dispute','urgent_funeral_memorial','sensitive_relocation','unsupported_request','rollout_gated','high_value_enterprise_objection','staff_initiated','bot_lead_qualified','bot_abandoned']);
 const decisions=new Set(['human_handoff','blocked_high_impact','customer_confirmation_required','clarification_required','customer_confirmed_action_executed','draft_review_required']);
 return{aiPaused:handoffs.some(h=>['queued','staff_active'].includes(h.status)),handoffs:handoffs.slice(0,5).map(h=>({status:['queued','staff_active','resumed'].includes(h.status)?h.status:'other',reason:reasons.has(h.reason)?h.reason:'other'})),recentTurns:turns.slice(0,3).map(t=>({outcome:['handoff','reply_ready','draft_review_required'].includes(t.outcome)?t.outcome:'other',policyDecision:decisions.has(t.policy_decision)?t.policy_decision:'other',handoffReason:reasons.has(t.handoff_reason)?t.handoff_reason:null}))};
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
