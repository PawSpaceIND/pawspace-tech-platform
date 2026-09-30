// Inspect one failed synthetic audio session. GET requests only; never start a conversation or dial.
const env=process.env;
const base=String(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(base))throw Error('Unapproved voice provider region');
const agentId=env.GROOMING_AGENT_ID,key=env.ELEVENLABS_API_KEY;
const start=Date.parse(env.DEMO_STARTED_AT||''),end=Date.parse(env.DEMO_ENDED_AT||'');
if(!key||!agentId||!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>300000)throw Error('Exact bounded demo interval required');
const scrub=value=>String(value||'').replaceAll(key,'[secret]').replace(/Bearer\s+\S+/gi,'Bearer [secret]').replace(/https?:\/\/[^\s"<>]+/g,'[url]').replace(/\+?\d{10,}/g,'[number]').replace(/(?:conv|agent)_[A-Za-z0-9_-]+/g,'[id]').slice(0,500);
async function get(path){const r=await fetch(base+path,{headers:{'xi-api-key':key},signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('Provider read refused: '+r.status);return r.json();}
const config=await get('/v1/convai/agents/'+encodeURIComponent(agentId));
const list=await get('/v1/convai/conversations?agent_id='+encodeURIComponent(agentId)+'&page_size=100');
const candidates=(list.conversations||[]).filter(row=>{const t=Number(row.start_time_unix_secs||row.metadata?.start_time_unix_secs||0)*1000;return t>=start&&t<=end;});
if(candidates.length!==1)throw Error('Exact demo session is ambiguous or missing: '+candidates.length);
const id=candidates[0].conversation_id;console.log('::add-mask::'+id);
const detail=await get('/v1/convai/conversations/'+encodeURIComponent(id));
if(detail.agent_id!==agentId||detail.metadata?.phone_call)throw Error('Expected a synthetic session, not a phone call');
const users=(detail.transcript||[]).filter(row=>row.role==='user');
const normalized=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const transcriptMatched=users.length===1&&normalized(users[0].message)===normalized('What grooming services do you offer for my dog Bruno?');
const metadata=detail.metadata||{},prompt=config.conversation_config?.agent?.prompt||{};
console.log('FAILED_DEMO_DIAGNOSIS='+JSON.stringify({dialed:false,status:detail.status,duration:metadata.call_duration_secs,terminationReason:scrub(metadata.termination_reason),error:scrub(typeof metadata.error==='object'?JSON.stringify(metadata.error):metadata.error),transcriptMatched,userTurns:users.length,agentTurns:(detail.transcript||[]).filter(row=>row.role==='agent').map(row=>({characters:String(row.message||'').length,interrupted:row.interrupted===true})),customLlm:{apiType:prompt.custom_llm?.api_type,model:prompt.custom_llm?.model_id,stagingEndpoint:prompt.custom_llm?.url==='https://pawspace-staging.karthik-fce.workers.dev/api/elevenlabs/v1',authConfigured:Boolean(prompt.custom_llm?.api_key)}}));
// Export only trace status and timing; request/response bodies and attributes can contain credentials.
try{
 const trace=await get('/v1/convai/conversations/'+encodeURIComponent(id)+'?format=opentelemetry');
 const spans=[];
 function visit(value){if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(visit);return;}if(value.spanId||value.span_id)spans.push({name:scrub(value.name),status:value.status?{code:value.status.code,message:scrub(value.status.message)}:null,start:value.startTimeUnixNano,end:value.endTimeUnixNano});Object.values(value).forEach(visit);}
 visit(trace);console.log('FAILED_DEMO_TRACE='+JSON.stringify({available:true,spans:spans.slice(0,60)}));
}catch(error){console.log('FAILED_DEMO_TRACE='+JSON.stringify({available:false,error:scrub(error.message)}));}
// Preserve the identity refusal, but retain diagnostic status when transcripts were redacted,
// split, or absent. A diagnostic observation never counts as successful conversation proof.
if(!transcriptMatched)throw Error('Failed demo final transcript identity differs; diagnostic status retained');
