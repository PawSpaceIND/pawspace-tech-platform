import {mkdir,readFile,writeFile} from 'node:fs/promises';
const path='artifacts/attended-seven-minute';await mkdir(path,{recursive:true});
const id=process.env.GROOMING_AGENT_ID,key=process.env.ELEVENLABS_API_KEY;
if(!id||!key)throw Error('Exact staging agent credentials required');
const url='https://api.elevenlabs.io/v1/convai/agents/'+encodeURIComponent(id);
async function api(init={}){const r=await fetch(url,{...init,headers:{'xi-api-key':key,'content-type':'application/json'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Staging duration operation refused '+r.status);return r.json();}
const action=process.argv[2];
if(action==='restore'){
 let saved;try{saved=JSON.parse(await readFile(path+'/duration-before.json','utf8'));}catch{console.log('No duration change was recorded');process.exit(0);}
 const current=await api();
 if(current.conversation_config?.conversation?.max_duration_seconds!==420)throw Error('Concurrent duration change: do not overwrite');
 await api({method:'PATCH',body:JSON.stringify({conversation_config:{conversation:{max_duration_seconds:saved.seconds}}})});
 const after=await api();if(after.conversation_config?.conversation?.max_duration_seconds!==saved.seconds)throw Error('Original duration restore not verified');
 console.log('ORIGINAL_DURATION_RESTORED='+saved.seconds);
}else if(action==='open'){
 const before=await api(),c=before.conversation_config;
 if(c?.agent?.prompt?.custom_llm?.url!=='https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1')throw Error('Isolated PawSpace staging brain required');
 const seconds=c?.conversation?.max_duration_seconds;if(!Number.isInteger(seconds)||seconds<1)throw Error('Original duration unavailable');
 await writeFile(path+'/duration-before.json',JSON.stringify({seconds,agentId:id}));
 await api({method:'PATCH',body:JSON.stringify({conversation_config:{conversation:{max_duration_seconds:420}}})});
 const after=await api();if(after.conversation_config?.conversation?.max_duration_seconds!==420)throw Error('Seven-minute duration not verified');
 await writeFile(path+'/engine.json',JSON.stringify({agentId:id,voiceId:c.tts?.voice_id,ttsModel:c.tts?.model_id,asr:c.asr,brain:c.agent?.prompt?.custom_llm?.url,originalDuration:seconds,testDuration:420},null,2));
 console.log('ATTENDED_DURATION_SECONDS=420');
}else throw Error('Explicit open or restore required');
