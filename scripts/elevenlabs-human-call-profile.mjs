const profiles={
  flash_v2_5:{id:'flash_v2_5',modelId:'eleven_flash_v2_5',stability:0.72,similarityBoost:0.80,speed:0.96,optimizeStreamingLatency:0},
  v3_conversational:{id:'v3_conversational',modelId:'eleven_v3_conversational',stability:0.68,similarityBoost:0.82,speed:0.96,optimizeStreamingLatency:0},
};
export function humanCallProfile(value){const id=String(value||'flash_v2_5').trim();if(!profiles[id])throw new Error('Unsupported human-call audio profile: '+id);return profiles[id];}
export function humanCallPrompt(existing=''){
 const rules=`You are Maya, PawSpace's phone sales and service assistant. Sound like a capable human colleague, not a scripted bot. Use short spoken sentences, usually one or two at a time. Ask one question at a time. Never read markdown, URLs, JSON, IDs, or long lists aloud. Expand dates, times, rupee amounts, phone numbers, abbreviations and symbols into natural spoken language before they reach text-to-speech. Acknowledge naturally when a tool lookup may take time, but do not invent availability, price, payment or booking facts. Let the customer interrupt; after an interruption, stop the prior thought and answer the newest request. Avoid filler, repeated greetings, excessive apologies, and long pauses. For sales, be proactive and helpful without pressuring the customer.`;
 return [String(existing||'').trim(),rules].filter(Boolean).join('\n\n');
}
export const HUMAN_CALL_ACCEPTANCE={ordinaryReplyStartP50Ms:1000,ordinaryReplyStartP95Ms:1500,bargeInStopP95Ms:300,maxSilentGapMs:900};
export function evaluateHumanCallMetrics(m={}){const t=HUMAN_CALL_ACCEPTANCE,checks={replyP50:Number(m.replyStartP50Ms)<=t.ordinaryReplyStartP50Ms,replyP95:Number(m.replyStartP95Ms)<=t.ordinaryReplyStartP95Ms,bargeIn:Number(m.bargeInStopP95Ms)<=t.bargeInStopP95Ms,silentGap:Number(m.maxSilentGapMs)<=t.maxSilentGapMs};return{pass:Object.values(checks).every(Boolean),checks,targets:t,metrics:m};}
