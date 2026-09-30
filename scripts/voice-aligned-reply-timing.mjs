// Arrival of an audio chunk aligned with the validated answer; not audible playback or carrier timing.
const normalized=value=>value.toLowerCase().replace(/[^a-z0-9]/g,'');
export function createAlignedReplyTiming(){
 let chars='',arrivals=[],seen=false,invalid=false;
 return{
  observe(audioEvent,receivedAt){
   const alignment=audioEvent?.alignment;if(alignment==null)return;
   if(!Array.isArray(alignment.chars)||!Array.isArray(alignment.char_start_times_ms)||alignment.chars.length!==alignment.char_start_times_ms.length||alignment.chars.length>8192||!Number.isFinite(receivedAt)||receivedAt<0){invalid=true;return;}
   if(chars.length+alignment.chars.length>16384){invalid=true;return;}
   for(let i=0;i<alignment.chars.length;i++){
    const char=alignment.chars[i],start=alignment.char_start_times_ms[i];
    if(typeof char!=='string'||[...char].length!==1||!Number.isFinite(start)||start<0||start>300000){invalid=true;return;}
    const part=normalized(char);chars+=part;arrivals.push(...Array(part.length).fill(receivedAt));
   }
   seen=true;
  },
  result(validatedReply,utteranceEndAt){
   if(invalid||!seen||typeof validatedReply!=='string'||validatedReply.length>16384||!Number.isFinite(utteranceEndAt))return null;
   const answer=normalized(validatedReply);if(answer.length<20)return null;
   const prefix=answer.slice(0,Math.min(40,answer.length)),at=chars.indexOf(prefix);
   if(at<0)return null;
   return Math.max(0,arrivals[at]-utteranceEndAt);
  },
 };
}
