import {isSubstantiveVoiceReply} from './voice-uat-evidence.mjs';
const HANDOFF=/waiting for a PawSpace team member|routing this to a PawSpace team member|cannot continue the booking/i;
export function audioFormat(format){
 const m=/^(pcm|ulaw)_(\d+)$/.exec(String(format));
 if(!m||![8000,16000,22050,24000,44100,48000].includes(Number(m[2])))throw Error('Unsupported agent audio format');
 return {rate:Number(m[2]),bytesPerSample:m[1]==='pcm'?2:1,silence:m[1]==='pcm'?0:255};
}
// Each requirement reported separately so a stalled probe says which proof is missing.
export function audioProofChecks({transcript,reply,audioBytes,nonSilentBytes}){
 return {asrGrooming:/grooming/i.test(transcript),asrBruno:/bruno/i.test(transcript),substantiveReply:isSubstantiveVoiceReply(reply),noHandoff:!HANDOFF.test(reply),audio:audioBytes>1600,nonSilentAudio:nonSilentBytes>100};
}
export function audioProof(state){return Object.values(audioProofChecks(state)).every(Boolean);}
const AGENT_EVENT_KINDS=new Set(['conversation_initiation_metadata','audio','agent_response','agent_response_correction','user_transcript','interruption','ping','error','internal_tentative_agent_response','vad_score','client_tool_call','agent_tool_response','contextual_update','mcp_tool_call','mcp_connection_status','agent_chat_response_part']);
// Maps a socket event type onto a fixed allowlisted name so remote data never chooses a property or log key.
export const audioEventKind=type=>typeof type==='string'&&AGENT_EVENT_KINDS.has(type)?type:'other';
export const isHandoffReply=reply=>HANDOFF.test(String(reply||''));
export function createAudioProbeState(){return {greeting:false,listening:false,segments:[],transcript:'',reply:'',audioBytes:0,nonSilentBytes:0,lastAudio:0,interruptedEventId:0};}
/**
 * Applies one agent socket event to the probe state and returns what changed
 * ('greeting'|'transcript'|'reply'|'correction'|'interruption'|'audio'|'cancelled-audio'|null).
 * Interruption: audio at or before the interrupted event id was cancelled by the agent and is never
 * counted or waited for; an agent_response_correction replaces the reply with what was actually spoken.
 * A new recognised user segment supersedes any earlier reply and its audio, so proof always judges
 * the answer to the latest recognised speech.
 */
export function applyAudioProbeEvent(s,d,{now,outputFormat}){
 if(d.type==='user_transcript'&&s.listening){
  const text=String(d.user_transcription_event?.user_transcript||'').trim();if(!text)return null;
  s.segments.push(text);s.transcript=s.segments.join(' ');s.reply='';s.audioBytes=0;s.nonSilentBytes=0;s.lastAudio=0;return 'transcript';
 }
 if(d.type==='interruption'){s.interruptedEventId=Math.max(s.interruptedEventId,Number(d.interruption_event?.event_id)||0);return 'interruption';}
 if(d.type==='audio'&&s.transcript){
  const id=Number(d.audio_event?.event_id);if(s.interruptedEventId&&Number.isFinite(id)&&id<=s.interruptedEventId)return 'cancelled-audio';
  const b=Buffer.from(d.audio_event?.audio_base_64||'','base64'),silence=audioFormat(outputFormat).silence;
  s.audioBytes+=b.length;for(const byte of b)if(byte!==silence)s.nonSilentBytes++;s.lastAudio=now;return 'audio';
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
// Complete once every proof holds and no uncancelled reply audio has arrived for 1.5 s.
export function audioProbeComplete(s,now){return Boolean(s.reply)&&now-s.lastAudio>1500&&audioProof(s);}
