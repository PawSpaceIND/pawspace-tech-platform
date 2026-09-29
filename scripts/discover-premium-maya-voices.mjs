const apiBase=String(process.env.ELEVENLABS_API_BASE||'https://api.elevenlabs.io').replace(/\/$/,'');
const key=String(process.env.ELEVENLABS_API_KEY||'').trim();
if(!key)throw new Error('ElevenLabs API key is required for voice discovery');

const languages=[
 ['hi','Hindi'],['ta','Tamil'],['ml','Malayalam'],['te','Telugu'],
 ['pa','Punjabi'],['mr','Marathi'],['bn','Bengali'],['kn','Kannada'],
];

const safeVoice=(voice)=>({
 voiceId:String(voice?.voice_id||''),
 name:String(voice?.name||''),
 category:voice?.category??null,
 gender:voice?.labels?.gender??voice?.gender??null,
 accent:voice?.labels?.accent??voice?.accent??null,
 age:voice?.labels?.age??voice?.age??null,
 useCase:voice?.labels?.use_case??voice?.use_case??null,
 language:voice?.labels?.language??voice?.language??voice?.voice_verification?.language??null,
 locale:voice?.locale??null,
 recordingQuality:voice?.recording_quality??null,
 verified:voice?.voice_verification?.is_verified??null,
 owner:voice?.is_owner??null,
});

for(const [code,name] of languages){
 const qs=new URLSearchParams({language:code,include_total_count:'true',high_quality:'true'});
 qs.append('use_cases','conversational');
 let response=await fetch(apiBase+'/v2/voices?'+qs.toString(),{
  headers:{'xi-api-key':key},
  signal:AbortSignal.timeout(30000),
 });
 let body=await response.json().catch(()=>({}));
 let source='workspace';
 if(!response.ok&&(response.status===401||response.status===403)){
  const shared=new URLSearchParams({language:code,category:'professional',page_size:'30',sort:'usage_character_count_1y'});
  shared.append('use_cases','conversational');
  response=await fetch(apiBase+'/v1/shared-voices?'+shared.toString(),{signal:AbortSignal.timeout(30000)});
  body=await response.json().catch(()=>({}));
  source='shared_voice_library';
 }
 if(!response.ok&&(response.status===401||response.status===403)){
  console.log('PREMIUM_VOICE_LIBRARY_ACCESS_BLOCKED='+JSON.stringify({language:name,status:response.status,action:'Use the ElevenLabs dashboard Voice Library or grant this API key voice-library read access before localized voice selection.'}));
  process.exit(0);
 }
 if(!response.ok)throw new Error('Voice discovery failed for '+name+': '+response.status);
 const candidates=(Array.isArray(body.voices)?body.voices:[])
  .map(safeVoice)
  .filter(v=>v.voiceId&&v.name)
  .sort((a,b)=>{
    const female=(v)=>String(v.gender).toLowerCase()==='female'?1:0;
    const conversational=(v)=>String(v.useCase).toLowerCase().includes('convers')?1:0;
    const studio=(v)=>String(v.recordingQuality).toLowerCase()==='studio'?1:0;
    return female(b)-female(a)||conversational(b)-conversational(a)||studio(b)-studio(a);
  })
  .slice(0,8);
 console.log('PREMIUM_VOICE_CANDIDATES_'+code.toUpperCase()+'='+JSON.stringify({language:name,source,total:body.total_count??candidates.length,candidates}));
}
