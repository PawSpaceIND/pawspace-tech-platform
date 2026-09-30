import {isSubstantiveVoiceReply,isControlledVoiceReply} from './voice-uat-evidence.mjs';
const normalized=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export const INTERRUPTION_PROMPTS=Object.freeze([
 {text:'I am considering boarding for Bruno for two nights. Please explain what you would need to arrange suitable care.',recognized:/(?=.*boarding)(?=.*bruno)/i},
 {text:'Sorry, stop. Just tell me what service helps when Bruno misses his daily outdoor exercise.',recognized:/(?=.*bruno)(?=.*(?:exercise|outdoor))(?=.*(?:stop|service))/i},
]);
export function assertInterruptionConversation(detail,{agentId,conversationId,turns,observed}){
 const fail=()=>{throw Error('Actual interruption recovery not proven');};
 const count=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
 if(!count(observed?.interruptionEvents,1,10)||!count(observed?.inputBytes,1001,2097152)||!count(observed?.recoveryAudioBytes,1601,16777216)||!count(observed?.recoveryNonSilentBytes,101,observed?.recoveryAudioBytes)||!Array.isArray(turns)||turns.some(t=>typeof t?.transcript!=='string'||t.transcript.length>16384)||typeof turns[1]?.reply!=='string'||turns[1].reply.length>16384)fail();
 if(detail?.status!=='done'||detail.agent_id!==agentId||detail.conversation_id!==conversationId||detail.metadata?.text_only===true||turns?.length!==2||observed?.interruptionEvents<1||!Number.isFinite(observed?.playbackRemainingAtBargeMs)||observed.playbackRemainingAtBargeMs<1000||observed.playbackRemainingAtBargeMs>300000||observed.inputBytes<1000||observed.recoveryAudioBytes<1600||observed.recoveryNonSilentBytes<100||observed.recoveryPlaybackComplete!==true)fail();
 const transcript=Array.isArray(detail.transcript)?detail.transcript:[],users=transcript.map((row,index)=>({row,index})).filter(x=>x.row.role==='user');
 if(users.length!==2)fail();
 for(let i=0;i<2;i++)if(normalized(users[i].row.message)!==normalized(turns[i].transcript)||!INTERRUPTION_PROMPTS[i].recognized.test(turns[i].transcript))fail();
 const first=transcript.slice(users[0].index+1,users[1].index).filter(row=>row.role==='agent');
 if(!first.some(row=>row.interrupted===true))fail();
 const recovery=transcript.slice(users[1].index+1).filter(row=>row.role==='agent'&&String(row.message||'').trim());
 const answer=recovery.map(row=>String(row.message)).join(' ');
 if(!recovery.length||recovery.some(row=>row.interrupted===true)||normalized(answer)!==normalized(turns[1].reply)||!isSubstantiveVoiceReply(answer)||isControlledVoiceReply(answer)||! /walk/i.test(answer)||/\.{3}|…/.test(answer))fail();
 return{passed:true,userTurns:2,actualProviderInterruption:true,interruptedReplyExcludedFromCompletion:true,recoveryReplyComplete:true,finalTranscriptMatched:true,bidirectionalObservedAudio:true,carrierVerified:false,premiumCertified:false,dialed:false};
}
