/** Useful status copy while staff retain ownership; this never resumes AI actions. */
export function voiceStaffPauseMessage(input:string,status:string|null,reason:string|null){
 const queue=status==="queued",active=status==="staff_active";
 if(!queue&&!active)return "PawSpace's team needs to help with this request. I can't confirm a booking or availability here, and no live transfer has been made.";
 const state=active?"A PawSpace teammate owns this conversation.":"Your request is queued for a PawSpace teammate; nobody has joined this call yet.";
 if(/\b(?:summary|summarize|status|what was|escalated)\b/i.test(input))return state+(reason==="refund_review"||/\brefund\b/i.test(input)?" Your refund concern needs staff review; I can't approve a refund or confirm a booking.":" Staff will review the service request; I can't confirm availability or a booking.");
 if(/\b(?:information|details|need|before)\b/i.test(input)&&/\b(?:refund|handoff|handing off|team)\b/i.test(input))return "Please have your booking reference or requested service details and a short description of the issue ready."+(reason==="refund_review"||/\brefund\b/i.test(input)?" A teammate must decide any refund; I can't promise an amount.":" The team will review the service request; I can't confirm availability or a booking.");
 if(/\b(?:book|booking|free|discount|override|approve)\b/i.test(input))return state+" I can't approve discounts, refunds or a booking while staff are handling this.";
 if(/\b(?:funeral|cremation|burial|ashes|freezer|died|passed away)\b/i.test(input))return state+" I'm sorry for your loss. The team must confirm the farewell option and pickup arrangements before any booking.";
 return state+" Please keep your booking reference or requested service details ready for their review.";
}
