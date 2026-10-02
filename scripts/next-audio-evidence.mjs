/** Event receipt for real provider audio. Receiving ASR text is never proof of hearing a voice. */
export function createAudioEventReceipt(clock=()=>performance.now()) {
 const events=[],audio=[];let conversationId=null;
 return {
  callerSpeechEnded(){events.push({type:'caller_speech_end',atMs:clock()});},
  receive(message){
   const atMs=clock();events.push({type:message.type,atMs,eventId:message.audio_event?.event_id??null});
   if(message.type==='conversation_initiation_metadata')conversationId=message.conversation_initiation_metadata_event?.conversation_id??null;
   if(message.type==='audio'&&message.audio_event?.audio_base_64)audio.push({atMs,eventId:message.audio_event.event_id??null,pcm:Buffer.from(message.audio_event.audio_base_64,'base64')});
  },
  snapshot(){
   const callerEnd=events.findLast(e=>e.type==='caller_speech_end');
   const firstAudio=callerEnd?audio.find(e=>e.atMs>=callerEnd.atMs):null;
   return {conversationId,events:[...events],audioChunks:audio.map(a=>({...a,pcm:Buffer.from(a.pcm)})),
    firstAudioAfterCallerEndMs:firstAudio&&callerEnd?firstAudio.atMs-callerEnd.atMs:null,
    measurement:'local receive time; includes endpointing, transport and generation; no provider clock comparison',
    listened:false,naturalnessAssessment:'requires a listening-capable reviewer'};
  },
 };
}
