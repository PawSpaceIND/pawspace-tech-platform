import {setTimeout as delay} from 'node:timers/promises';
import {isSubstantiveVoiceReply} from './voice-uat-evidence.mjs';
import {isHandoffReply} from './voice-audio-proof.mjs';
const normalized=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function assertFinalConversation(detail,{agentId,turns,liveAudioEvidence}){
 if(detail?.status!=='done'||detail.agent_id!==agentId)throw Error('Final conversation identity/status not verified');
 // Availability flags describe retained recordings, not whether live audio was exchanged.
 const retained=Boolean(detail.has_user_audio&&detail.has_response_audio);
 const live=Boolean(detail.conversation_id)&&liveAudioEvidence?.conversationId===detail.conversation_id&&detail.metadata?.text_only!==true&&liveAudioEvidence?.inputMode==='audio'&&liveAudioEvidence.inputBytes>1000&&liveAudioEvidence.outputBytes>1600&&liveAudioEvidence.nonSilentBytes>100&&liveAudioEvidence.playbackComplete===true;
 if(!retained&&!live)throw Error('Final conversation lacks bidirectional audio evidence');
 const transcript=Array.isArray(detail.transcript)?detail.transcript:[];
 const users=transcript.map((row,index)=>({row,index})).filter(x=>x.row.role==='user');
 if(!turns.length||users.length!==turns.length)throw Error('Final conversation has missing or duplicate user turns');
 for(let i=0;i<turns.length;i++){
  if(normalized(users[i].row.message)!==normalized(turns[i].transcript))throw Error('Final user transcript differs from observed speech');
  const end=users[i+1]?.index??transcript.length;
  const responses=transcript.slice(users[i].index+1,end).filter(row=>row.role==='agent'&&String(row.message||'').trim());
  if(responses.some(row=>row.interrupted===true))throw Error('Final agent answer was interrupted');
  const response=responses.map(row=>String(row.message||'')).join(' ');
  if(!isSubstantiveVoiceReply(response)||isHandoffReply(response)||/\.{3}|…/.test(response))throw Error('Final agent answer is incomplete or handed off');
  if(normalized(response)!==normalized(turns[i].reply))throw Error('Final agent answer differs from complete streamed reply');
 }
 return {passed:true,userTurns:users.length,finalTranscriptMatched:true,bidirectionalAudio:true,audioEvidence:retained?'retained_recording':'observed_live_stream'};
}
export async function verifyFinalConversation({key,conversationId,agentId,turns,liveAudioEvidence,request=fetch}){
 if(!conversationId)throw Error('Conversation ID missing');
 for(let attempt=0;attempt<30;attempt++){
  const r=await request('https://api.elevenlabs.io/v1/convai/conversations/'+encodeURIComponent(conversationId),{headers:{'xi-api-key':key},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('Final provider conversation read refused: '+r.status);
  const detail=await r.json();
  if(['done','failed'].includes(detail.status))return assertFinalConversation(detail,{agentId,turns,liveAudioEvidence});
  await delay(2000);
 }
 throw Error('Final provider conversation did not settle');
}
