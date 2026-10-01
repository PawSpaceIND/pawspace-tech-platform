// Only the known non-dialing Food FAQ incident from audio run 36807335313.
export const FOOD_TURN_AT=1790823246976,FOOD_HANDOFF_AT=1790823246986;
export const FOOD_INPUT='What fresh food options can I ask PawSpace about, and how is payment handled?';
export function assertFoodRecovery({customerId,handoff:h,turn:t,calls,messages,otherHandoffs,pending}){
 const payload=m=>{try{return JSON.parse(m.payload_json).text;}catch{return null;}};
 const c=calls.filter(c=>c.started_at<=FOOD_TURN_AT&&c.ended_at>=FOOD_HANDOFF_AT);
 if(!customerId||h?.customer_id!==customerId||t?.customer_id!==customerId||!h.thread_id||h.thread_id!==t.thread_id||!h.session_id||h.session_id!==t.session_id)throw Error('Food recovery ownership mismatch');
 if(h.created_at!==FOOD_HANDOFF_AT||t.created_at!==FOOD_TURN_AT||h.status!=='queued'||h.reason!=='policy_risk'||h.requested_by!=='elevenlabs-voice@system.pawspace'||h.taken_over_by!=null||h.taken_over_at!=null||h.resumed_by!=null||h.resumed_at!=null)throw Error('Food incident is not untouched');
 if(t.outcome!=='handoff'||t.policy_decision!=='blocked_high_impact'||t.handoff_reason!=='policy_risk'||t.intent_code!=='unknown'||t.intent_confidence!==0.4||payload(t)!==FOOD_INPUT)throw Error('Food incident turn differs');
 if(c.length!==1||c[0].customer_id!==customerId||c[0].thread_id!==h.thread_id||c[0].transport_provider!=='sandbox_simulator'||c[0].direction!=='inbound'||c[0].consent_status!=='verified'||c[0].created_by!=='founder@pawspace.in'||c[0].status!=='failed'||c[0].disposition!=='synthetic_audio_demo_failed')throw Error('Known synthetic Food call required');
 if(t.direction!=='inbound'||t.input_actor!=='elevenlabs-voice@system.pawspace'||t.input_provider!=='elevenlabs'||t.input_channel!=='voice')throw Error('Synthetic input actor differs');
 if(messages.length!==1||messages[0].id!==t.input_message_id||payload(messages[0])!==FOOD_INPUT||messages[0].created_by!=='elevenlabs-voice@system.pawspace'||messages[0].channel!=='voice'||pending.length||otherHandoffs.some(x=>x.thread_id===h.thread_id&&['queued','staff_active'].includes(x.status)))throw Error('Later activity or existing ownership prevents recovery');
 return true;
}
