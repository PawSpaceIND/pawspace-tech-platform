import {isSubstantiveVoiceReply} from './voice-uat-evidence.mjs';
import {verifyVoiceSale} from './verify-voice-sale.mjs';
await verifyVoiceSale(); // Confirms the allowlisted tester and isolated staging context; never captures.
const key=process.env.ELEVENLABS_API_KEY,agentId=process.env.GROOMING_AGENT_ID,callId=process.env.UAT_VOICE_CALL_ID;
const r=await fetch('https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id='+encodeURIComponent(agentId)+'&debug_events_request=true',{headers:{'xi-api-key':key},signal:AbortSignal.timeout(30000)});
const b=await r.json();if(!r.ok||!b.signed_url)throw Error('Agent socket authorization refused');
console.log('::add-mask::'+b.signed_url);
const socket=new WebSocket(b.signed_url);let sent=false,started=Date.now(),finished=false;
await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>finish(Error('No substantive agent response within 45 seconds')),45000);
 const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);socket.close();error?reject(error):resolve();};
 socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'conversation_initiation_client_data',custom_llm_extra_body:{pawspace_voice_call_id:callId},dynamic_variables:{pawspace_voice_call_id:callId,pawspace_uat:'true'}})));
 socket.addEventListener('message',event=>{const d=JSON.parse(String(event.data));
  if(d.type==='ping'){socket.send(JSON.stringify({type:'pong',event_id:d.ping_event.event_id}));return;}
  if(d.type==='conversation_initiation_metadata'){const cid=d.conversation_initiation_metadata_event?.conversation_id;if(cid)console.log('::add-mask::'+cid);}
  if(d.type==='agent_response'){
   const reply=String(d.agent_response_event?.agent_response||'');console.log('VOICE_SOCKET_REPLY='+JSON.stringify({ms:Date.now()-started,afterUser:sent,text:reply.slice(0,600)}));
   if(!sent){sent=true;started=Date.now();socket.send(JSON.stringify({type:'user_message',text:String(process.env.PROBE_INPUT||'Hi, I want to book a grooming service for tomorrow at 11 AM for my pet Bruno.')}));}
   else if(/waiting for a PawSpace team member|cannot continue the booking while it is with the team/i.test(reply))finish(Error('Agent is in staff handoff; sales flow did not pass'));
   else if(isSubstantiveVoiceReply(reply))finish();
  }else if(d.type==='error'){console.log('VOICE_SOCKET_ERROR='+JSON.stringify({type:d.type,keys:Object.keys(d),code:d.code??null}));finish(Error('Agent socket returned error'));}
 });
 socket.addEventListener('error',()=>finish(Error('Agent socket transport error')));
 socket.addEventListener('close',event=>{console.log('VOICE_SOCKET_CLOSED='+JSON.stringify({code:event.code,ms:Date.now()-started}));if(!finished)finish(Error('Agent socket closed before substantive reply')); });
});
console.log('VOICE_SOCKET_PROOF='+JSON.stringify({passed:true,dialed:false,agentId}));
