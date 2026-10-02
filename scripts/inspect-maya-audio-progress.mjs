// Read-only progress for synthetic audit threads. No dialing, generation or repairs.
const env=process.env;
if(!env.CLOUDFLARE_API_TOKEN||!env.STAGING_D1_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID||!env.SPECIALIST_CUSTOMER_ID)throw Error('Isolated audit read prerequisites required');
const base='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
async function read(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)}),b=await r.json();if(!r.ok||!b.success)throw Error('Audit read refused');return b.result;}
const metadata=await read('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID));if(metadata.name!=='pawspace-staging')throw Error('Canonical staging required');
const rows=await read('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql:"SELECT t.created_at,t.status,t.assigned_to,m.direction,m.payload_json,m.created_at AS message_at FROM communication_threads t LEFT JOIN communication_messages m ON m.thread_id=t.id WHERE t.customer_id=? AND t.id LIKE 'THREAD-AUDIOAUDIT-%' ORDER BY t.created_at,m.created_at LIMIT 200",params:[env.SPECIALIST_CUSTOMER_ID]});
const scrub=t=>String(t||'').replace(/\+?\d{10,15}/g,'[number]').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[email]');
console.log('MAYA_AUDIO_PROGRESS='+JSON.stringify((rows[0]?.results||[]).map(r=>{let p;try{p=JSON.parse(r.payload_json||'{}');}catch{p={};}return{startedAt:r.created_at,status:r.status,staffAssigned:Boolean(r.assigned_to&&r.assigned_to!=='ai-orchestrator'),direction:r.direction,text:scrub(p.text).slice(0,2000)};})));
