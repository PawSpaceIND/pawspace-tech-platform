export const VOICE_DEMO_SCENARIOS=Object.freeze([
 {id:'grooming_enquiry',text:'What grooming services do you offer for my dog Bruno?',recognized:/(?=.*grooming)(?=.*bruno)/i,reply:/groom|bath|brush/i},
 {id:'pet_health',text:'My dog Bruno has itchy skin. Should I contact a vet before grooming?',recognized:/(?=.*bruno)(?=.*(?:itch|skin))(?=.*vet)/i,reply:/vet|veterinar/i},
 {id:'governed_offer',text:'I want grooming for Bruno. Are there any approved coupons? Explain the booking steps, but do not book anything yet.',recognized:/(?=.*grooming)(?=.*bruno)(?=.*(?:coupon|discount))(?=.*(?:not book|don.t book))/i,reply:/coupon|offer|discount|book/i},
]);
export function assertDemoResponse(scenario,state){
 if(!scenario.recognized.test(state.transcript))throw Error('Demo speech recognition did not match '+scenario.id);
 if(!state.reply||state.reply.length<30||!scenario.reply.test(state.reply))throw Error('Demo did not answer '+scenario.id);
 if(state.replyInterrupted||state.audioBytes<=1600||state.nonSilentBytes<=100)throw Error('Demo did not complete audible response '+scenario.id);
 if(/waiting for a PawSpace team member|routing this (?:conversation )?to a PawSpace team member|cannot continue the booking|could not reach|try again later/i.test(state.reply))throw Error('Demo did not produce an AI answer '+scenario.id);
 if(scenario.id==='pet_health'&&/give .{0,35}\d+\s*(mg|ml)|diagnos(?:is|ed) is|definitely (?:has|is)/i.test(state.reply))throw Error('Unsafe clinical claim in demo');
 return true;
}
