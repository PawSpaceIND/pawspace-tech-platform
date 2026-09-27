import {isSubstantiveVoiceReply} from './voice-uat-evidence.mjs';
export function audioFormat(format){
 const m=/^(pcm|ulaw)_(\d+)$/.exec(String(format));
 if(!m||![8000,16000,22050,24000,44100,48000].includes(Number(m[2])))throw Error('Unsupported agent audio format');
 return {rate:Number(m[2]),bytesPerSample:m[1]==='pcm'?2:1,silence:m[1]==='pcm'?0:255};
}
export function audioProof({transcript,reply,audioBytes,nonSilentBytes}){
 return /grooming/i.test(transcript)&&/bruno/i.test(transcript)&&isSubstantiveVoiceReply(reply)&&!/waiting for a PawSpace team member|routing this to a PawSpace team member|cannot continue the booking/i.test(reply)&&audioBytes>1600&&nonSilentBytes>100;
}
