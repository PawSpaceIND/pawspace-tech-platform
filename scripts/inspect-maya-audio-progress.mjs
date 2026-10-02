// Read-only progress for synthetic audit threads. No dialing, generation or repairs.
const env=process.env;
if(!env.CLOUDFLARE_API_TOKEN||!env.STAGING_D1_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID||!env.SPECIALIST_CUSTOMER_ID)throw Error('Isolated audit read prerequisites required');
const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
async function read(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)}),b=await r.json();if(!r.ok||!b.success)throw Error('Audit read refused');return b.result;}
const metadata=await read('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID));if(metadata.name!=='pawspace-staging')throw Error('Canonical staging required');
const rows=await read('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:"SELECT t.created_at,t.status,t.assigned_to,m.direction,m.payload_json,m.created_at AS message_at FROM communication_threads t LEFT JOIN communication_messages m ON m.thread_id=t.id WHERE t.customer_id=? AND t.id LIKE 'THREAD-AUDIOAUDIT-%' ORDER BY t.created_at,m.created_at LIMIT 200",params:[env.SPECIALIST_CUSTOMER_ID]});
const scrub=t=>String(t||'').replace(/\+?\d{10,15}/g,'[number]').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[email]');
console.log('MAYA_AUDIO_PROGRESS='+JSON.stringify((rows[0]?.results||[]).map(r=>{let p;try{p=JSON.parse(r.payload_json||'{}');}catch{p={};}return{startedAt:r.created_at,status:r.status,staffAssigned:Boolean(r.assigned_to&&r.assigned_to!=='ai-orchestrator'),direction:r.direction,text:scrub(p.text).slice(0,2000)};})));
const eleven=(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(eleven)||!env.ELEVENLABS_API_KEY||!env.GROOMING_AGENT_ID)throw Error('Approved audio provider read required');
const get=async p=>{const r=await fetch(eleven+p,{headers:{'xi-api-key':env.ELEVENLABS_API_KEY},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Audio audit read refused '+r.status);return r.json();};
const list=await get('/v1/convai/conversations?agent_id='+encodeURIComponent(env.GROOMING_AGENT_ID)+'&page_size=20');
for(const c of (list.conversations||[]).slice(0,5)){
 const d=await get('/v1/convai/conversations/'+encodeURIComponent(c.conversation_id));
 const context=d.conversation_initiation_client_data?.custom_llm_extra_body||{};
 if(d.agent_id!==env.GROOMING_AGENT_ID||context.pawspace_customer_id!==env.SPECIALIST_CUSTOMER_ID||!String(context.pawspace_thread_id||'').startsWith('THREAD-AUDIOAUDIT-'))continue;
 console.log('MAYA_AUDIO_PROVIDER_PROGRESS='+JSON.stringify({status:d.status,duration:d.metadata?.call_duration_secs,transcript:(d.transcript||[]).slice(0,25).map(t=>({role:t.role,time:t.time_in_call_secs,text:scrub(t.message).slice(0,2000)}))}));
}
