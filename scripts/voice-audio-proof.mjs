import {isSubstantiveVoiceReply,isControlledVoiceReply} from './voice-uat-evidence.mjs';
export function audioFormat(format){
 const m=/^(pcm|ulaw)_(\d+)$/.exec(String(format));
 if(!m||![8000,16000,22050,24000,44100,48000].includes(Number(m[2])))throw Error('Unsupported agent audio format');
 return {rate:Number(m[2]),bytesPerSample:m[1]==='pcm'?2:1,silence:m[1]==='pcm'?0:255};
}
export function audioProofChecks({transcript,reply,audioBytes,nonSilentBytes}){
 return {asrGrooming:/grooming/i.test(transcript),asrBruno:/bruno/i.test(transcript),substantiveReply:isSubstantiveVoiceReply(reply),noHandoff:!isControlledVoiceReply(reply),audio:audioBytes>1600,nonSilentAudio:nonSilentBytes>100};
}
export function audioProof(state){return Object.values(audioProofChecks(state)).every(Boolean);}
const AGENT_EVENT_KINDS=new Set(['conversation_initiation_metadata','audio','agent_response','agent_response_correction','user_transcript','interruption','ping','error','internal_tentative_agent_response','vad_score','client_tool_call','agent_tool_response','contextual_update','mcp_tool_call','mcp_connection_status','agent_chat_response_part']);
export const audioEventKind=type=>typeof type==='string'&&AGENT_EVENT_KINDS.has(type)?type:'other';
// Legacy probe name: this flags controlled refusals as well as handoffs; it does not prove staff was queued.
export const isHandoffReply=isControlledVoiceReply;
export function createAudioProbeState(){return {greeting:false,listening:false,segments:[],transcript:'',reply:'',audioBytes:0,nonSilentBytes:0,lastAudio:0,playbackEndAt:0,replyInterrupted:false,interruptedEventId:0};}
// A new recognised input supersedes the reply and playback queue. Cancelled output is not proof.
export function applyAudioProbeEvent(s,d,{now,outputFormat}){
 if(d.type==='user_transcript'&&s.listening){
  const text=String(d.user_transcription_event?.user_transcript||'').trim();if(!text)return null;
  s.segments.push(text);s.transcript=s.segments.join(' ');s.reply='';s.audioBytes=0;s.nonSilentBytes=0;s.lastAudio=0;s.playbackEndAt=0;s.replyInterrupted=false;return 'transcript';
 }
 if(d.type==='interruption'){
  if(s.transcript&&s.reply)s.replyInterrupted=true;
  s.interruptedEventId=Math.max(s.interruptedEventId,Number(d.interruption_event?.event_id)||0);return 'interruption';
 }
 if(d.type==='audio'&&s.transcript){
  const id=Number(d.audio_event?.event_id);if(s.interruptedEventId&&Number.isFinite(id)&&id<=s.interruptedEventId)return 'cancelled-audio';
  const b=Buffer.from(d.audio_event?.audio_base_64||'','base64'),f=audioFormat(outputFormat);
  s.audioBytes+=b.length;for(const byte of b)if(byte!==f.silence)s.nonSilentBytes++;
  // Audio may arrive faster than real time. Each chunk extends a serial playback queue.
  s.playbackEndAt=Math.max(now,s.playbackEndAt||0)+b.length/(f.rate*f.bytesPerSample)*1000;
  s.lastAudio=now;return 'audio';
 }
 if(d.type==='agent_response'){
  if(!s.greeting){s.greeting=true;return 'greeting';}
  if(s.transcript){s.reply=String(d.agent_response_event?.agent_response||'');return 'reply';}
  return null;
 }
 if(d.type==='agent_response_correction'&&s.reply){
  const c=d.agent_response_correction_event;
  if(String(c?.original_agent_response||'').trim()!==s.reply.trim())return null;
  s.reply=String(c?.corrected_agent_response||'');return 'correction';
 }
 return null;
}
// Do not accept a truncated substantive prefix or confuse a network gap with full playback.
export function audioProbeComplete(s,now){return Boolean(s.reply)&&!s.replyInterrupted&&s.playbackEndAt>0&&now>=s.playbackEndAt+1500&&now-s.lastAudio>1500&&audioProof(s);}
export function greetingPlaybackFinished({now,firstAudioAt,lastAudioAt,bytes,format}){
 if(!firstAudioAt||!lastAudioAt||bytes<=0)return false;
 const f=audioFormat(format);
 return now-lastAudioAt>=750&&now>=firstAudioAt+bytes/(f.rate*f.bytesPerSample)*1000+750;
}
