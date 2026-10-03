// Evidence recovery only: no generation, call, payment, booking or message APIs.
import {mkdir,writeFile} from 'node:fs/promises';
const env=process.env,out='artifacts/maya-existing-four-recovery';
const start=Date.parse('2026-10-03T07:57:00Z'),end=Date.parse('2026-10-03T08:07:00Z');
const customer=env.SPECIALIST_CUSTOMER_ID,base=(env.ELEVENLABS_API_BASE||'https://api.in.residency.elevenlabs.io').replace(/\/$/,'');
if(!['https://api.elevenlabs.io','https://api.in.residency.elevenlabs.io'].includes(base)||!customer||!env.GROOMING_AGENT_ID||env.STAGING_D1_ID===env.PRODUCTION_D1_ID)throw Error('Isolated recovery prerequisites missing');
await mkdir(out,{recursive:true});
const scrub=x=>{if(Array.isArray(x))return x.map(scrub);if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,/api_key|authorization|secret|access_token|signed_url|phone_number|primary_phone|secondary_phone|email/i.test(k)?'[REDACTED]':scrub(v)]));return x;};
const save=async(name,data)=>writeFile(out+'/'+name+'.json',JSON.stringify(scrub(data),null,2));
async function get(path){const r=await fetch(base+path,{headers:{'xi-api-key':env.ELEVENLABS_API_KEY},signal:AbortSignal.timeout(30000)});if(!r.ok)return{readBlocked:true,status:r.status,path};return r.json();}
const config=await get('/v1/convai/agents/'+encodeURIComponent(env.GROOMING_AGENT_ID));
await save('current-agent-config-not-historical',config);
await save('subscription-current-not-run-receipt',await get('/v1/user/subscription'));
const recovered=[];let cursor;
for(let page=0;page<10;page++){
 const params=new URLSearchParams({agent_id:env.GROOMING_AGENT_ID,page_size:'100',call_start_after_unix:String(Math.floor(start/1000)),call_start_before_unix:String(Math.ceil(end/1000))});
 if(cursor)params.set('cursor',cursor);
 const list=await get('/v1/convai/conversations?'+params);
 if(list.readBlocked){await save('provider-list-error',list);break;}
 for(const c of list.conversations||[]){
  const d=await get('/v1/convai/conversations/'+encodeURIComponent(c.conversation_id));
  const body=d.conversation_initiation_client_data?.custom_llm_extra_body||{},t=Number(d.metadata?.start_time_unix_secs||c.start_time_unix_secs)*1000;
  if(d.agent_id!==env.GROOMING_AGENT_ID||body.pawspace_customer_id!==customer||!String(body.pawspace_thread_id||'').startsWith('THREAD-AUDIOAUDIT-')||t<start||t>end)continue;
  await save('session-'+c.conversation_id,d);
  recovered.push({sessionId:c.conversation_id,agentId:d.agent_id,threadId:body.pawspace_thread_id,startUnix:d.metadata?.start_time_unix_secs,status:d.status,metadata:d.metadata,versionId:d.agent_version_id??d.metadata?.agent_version_id??null});
  const audio=await fetch(base+'/v1/convai/conversations/'+encodeURIComponent(c.conversation_id)+'/audio',{headers:{'xi-api-key':env.ELEVENLABS_API_KEY},signal:AbortSignal.timeout(30000)});
  if(audio.ok)await writeFile(out+'/session-'+c.conversation_id+'.mp3',new Uint8Array(await audio.arrayBuffer()));else await save('audio-error-'+c.conversation_id,{status:audio.status});
 }
 cursor=list.next_cursor;if(!list.has_more||!cursor)break;
}
await save('provider-session-manifest',{readOnly:true,phoneDialed:false,start,end,agentId:env.GROOMING_AGENT_ID,recovered});
const cf='https://api.cloudflare.com/client/v4/accounts/'+encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID);
async function cfRead(path,body){const r=await fetch(cf+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const b=await r.json();if(!r.ok||!b.success)throw Error('Recovery database read refused '+r.status);return b.result;}
const db=await cfRead('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID));if(db.name!=='pawspace-staging')throw Error('Exact staging database required');
const q=async(sql,params=[])=>{if(!/^SELECT|^PRAGMA/.test(sql))throw Error('Read-only SQL only');const r=await cfRead('/d1/database/'+encodeURIComponent(env.STAGING_D1_ID)+'/query',{sql,params});return r[0]?.results||[];};
const settings=await cfRead('/workers/scripts/pawspace-staging/settings');
await save('current-staging-not-historical',{annotation:settings.annotations?.['workers/message'],aiModelBindings:settings.bindings.filter(b=>b.type==='plain_text'&&/^PAWSPACE_AI_(VOICE_MODEL|PROVIDER_MODEL|PROVIDER)$/.test(b.name)).map(b=>({name:b.name,value:b.text??b.value}))});
const tables=await q("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'ai_%' OR name LIKE '%pet%' OR name LIKE '%booking%' OR name LIKE '%voice%' OR name LIKE '%payment%' OR name LIKE '%communication%')");
await save('schema-table-names',tables);
for(const name of ['canonical_pets','canonical_bookings','ai_voice_calls','ai_conversation_turns','ai_handoffs','ai_tool_executions','ai_provider_runtime_requests','ai_runtime_requests','ai_usage_events','communication_messages','communication_threads']){
 if(!tables.some(t=>t.name===name))continue;
 const schema=await q('PRAGMA table_info('+name+')');await save('schema-'+name,schema);
 const cols=schema.map(x=>x.name);
 let sql,params;
 if(name==='canonical_pets'&&cols.includes('customer_id')){sql='SELECT * FROM '+name+' WHERE customer_id=?';params=[customer];}
 else if(name==='canonical_bookings'&&cols.includes('customer_id')){sql='SELECT * FROM '+name+' WHERE customer_id=?';params=[customer];}
 else if(name==='ai_voice_calls'&&cols.includes('customer_id')){sql='SELECT * FROM '+name+' WHERE customer_id=? AND started_at BETWEEN ? AND ?';params=[customer,start,end];}
 else if(cols.includes('thread_id')){sql="SELECT * FROM "+name+" WHERE thread_id IN (SELECT id FROM communication_threads WHERE customer_id=? AND id LIKE 'THREAD-AUDIOAUDIT-%' AND created_at BETWEEN ? AND ?)";params=[customer,start,end];}
 else if(name==='communication_threads'){sql="SELECT * FROM communication_threads WHERE customer_id=? AND id LIKE 'THREAD-AUDIOAUDIT-%' AND created_at BETWEEN ? AND ?";params=[customer,start,end];}
 else if(cols.includes('created_at')){sql='SELECT * FROM '+name+' WHERE created_at BETWEEN ? AND ?';params=[start,end];}
 else continue;
 await save('state-'+name,await q(sql,params));
}
console.log('RECOVERY_SUMMARY='+JSON.stringify({readOnly:true,sessions:recovered.length,agentId:env.GROOMING_AGENT_ID,sessionIds:recovered.map(r=>r.sessionId),terminationReasons:recovered.map(r=>r.metadata?.termination_reason),costFields:recovered.map(r=>({sessionId:r.sessionId,cost:r.metadata?.cost,charging:r.metadata?.charging})),noNewPaidRun:true}));

