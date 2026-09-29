const profiles={
  flash_v2:{id:'flash_v2',modelId:'eleven_flash_v2',stability:0.72,similarityBoost:0.80,speed:0.96,optimizeStreamingLatency:0},
  flash_v2_5:{id:'flash_v2_5',modelId:'eleven_flash_v2_5',stability:0.72,similarityBoost:0.80,speed:0.96,optimizeStreamingLatency:0},
  v3_conversational:{id:'v3_conversational',modelId:'eleven_v3_conversational',stability:0.45,similarityBoost:0.75,speed:1.0,optimizeStreamingLatency:0,expressiveMode:true},
};
export function humanCallProfile(value){const id=String(value||'v3_conversational').trim();if(!profiles[id])throw new Error('Unsupported human-call audio profile: '+id);return profiles[id];}
export function humanCallPrompt(existing=''){
 const marker='[PawSpace human-call profile v2]';
 const legacyStart="You are Maya, PawSpace's phone sales and service assistant. Sound like a capable human colleague, not a scripted bot.";
 let base=String(existing||'').trim();
 for(const cut of [marker,legacyStart]){const index=base.indexOf(cut);if(index>=0)base=base.slice(0,index).trim();}
 const rules=`${marker}\nYou are Maya, PawSpace's phone sales and service assistant. Speak like a warm, capable Indian customer-care colleague: natural, concise and relaxed, never theatrical or robotic. Use short spoken sentences, usually one or two at a time. Ask one question at a time. Use brief natural acknowledgements such as “Got it”, “Sure”, or “Okay” only when they fit; do not repeat the same filler every turn. Never read markdown, URLs, JSON, IDs, or long lists aloud. Expand dates, times, rupee amounts, phone numbers, abbreviations and symbols into natural spoken language before they reach text-to-speech. If a lookup genuinely takes time, use one short acknowledgement, then continue when the result arrives; do not invent availability, price, payment or booking facts. Let the customer interrupt; after an interruption, stop the prior thought and answer the newest request. Avoid repeated greetings, excessive apologies, canned phrases, and long pauses. For sales, be proactive and helpful without pressuring the customer. Do not pretend to be a human if asked directly; simply say you are PawSpace's automated assistant and offer a human teammate.`;
 return [base,rules].filter(Boolean).join('\n\n');
}
export const HUMAN_CALL_ACCEPTANCE={ordinaryReplyStartP50Ms:1000,ordinaryReplyStartP95Ms:1500,bargeInStopP95Ms:300,maxSilentGapMs:900};
export function evaluateHumanCallMetrics(m={}){const t=HUMAN_CALL_ACCEPTANCE,checks={replyP50:Number(m.replyStartP50Ms)<=t.ordinaryReplyStartP50Ms,replyP95:Number(m.replyStartP95Ms)<=t.ordinaryReplyStartP95Ms,bargeIn:Number(m.bargeInStopP95Ms)<=t.bargeInStopP95Ms,silentGap:Number(m.maxSilentGapMs)<=t.maxSilentGapMs};return{pass:Object.values(checks).every(Boolean),checks,targets:t,metrics:m};}
