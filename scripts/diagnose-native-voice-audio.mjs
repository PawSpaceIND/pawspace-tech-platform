// Read-only historical call inspection plus a synthetic TTS request. Never dials.
import {createHash} from 'node:crypto';
import {authorizedLaunchTester} from './voice-sales-launch-preflight.mjs';
const env=process.env;
authorizedLaunchTester(env);
const account=String(env.CLOUDFLARE_ACCOUNT_ID||'').trim(),token=String(env.CLOUDFLARE_API_TOKEN||'').trim(),database=String(env.STAGING_D1_ID||'').trim();
if(!/^[a-f0-9]{32}$/i.test(account)||!token||!database||database===env.PRODUCTION_D1_ID)throw Error('Isolated staging diagnostic prerequisites missing');
const base='https://api.cloudflare.com/client/v4/accounts/'+account;
async function cf(path,body){
 const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
 const result=await response.json();
 if(!response.ok||result.success!==true)throw Error('Read-only staging inspection failed ('+response.status+')');
 return result.result;
}
const db=await cf('/d1/database/'+encodeURIComponent(database));
if(db.name!=='pawspace-staging')throw Error('Diagnostic database is not staging');
async function query(sql,params=[]){const data=await cf('/d1/database/'+encodeURIComponent(database)+'/query',{sql,params});return (Array.isArray(data)?data[0]:data)?.results||[];}
// Fixed narrow window of the user-attended silent call; refuse ambiguous matches.
const rows=await query("SELECT id,dial_number,state,provider FROM voice_call_orders WHERE campaign_id='controlled_native_agentstream_uat' AND requested_at>=? AND requested_at<?",[Date.parse('2026-09-30T10:46:00Z'),Date.parse('2026-09-30T10:48:30Z')]);
if(rows.length!==1)throw Error('Exact attended call is missing or ambiguous; never inspect a guessed latest call');
const row=rows[0];
if(createHash('sha256').update(String(row.dial_number||'').replace(/\D/g,'').slice(-10)).digest('hex')!==env.EXPECTED_TESTER_SHA256||row.provider!=='exotel')throw Error('Attended native recipient/provider mismatch');
const thread='THREAD-VOICE-'+String(row.id).replace(/[^A-Za-z0-9_-]/g,'').slice(0,96);
const calls=await query('SELECT id,status,outcome,disposition FROM ai_voice_calls WHERE thread_id=?',[thread]);
if(calls.length!==1)throw Error('Exact AI stream call missing or ambiguous');
const events=await query('SELECT event_type,detail_json,created_at FROM ai_voice_events WHERE call_id=? ORDER BY created_at',[calls[0].id]);
const segments=await query('SELECT speaker,COUNT(*) AS count,MIN(created_at) AS first_at,MAX(created_at) AS last_at FROM ai_voice_segments WHERE call_id=? GROUP BY speaker',[calls[0].id]);
const counts={};for(const event of events)counts[event.event_type]=(counts[event.event_type]||0)+1;
const reasons=events.flatMap(event=>{if(!['agentstream_stopped','agentstream_transport_interrupted'].includes(event.event_type))return [];try{return [JSON.parse(event.detail_json).reason].filter(x=>['agentstream_error','socket_closed','socket_error','callended','hangup','disconnect'].includes(x));}catch{return [];}});
const startedAt=events.find(x=>x.event_type==='agentstream_started')?.created_at;
console.log('NATIVE_AUDIO_DIAGNOSTIC='+JSON.stringify({state:row.state,status:calls[0].status,outcome:calls[0].outcome,eventCounts:counts,segments:segments.map(x=>({speaker:x.speaker,count:x.count,firstAfterStartMs:startedAt?x.first_at-startedAt:null})),eventTimings:events.map(x=>({type:x.event_type,afterStartMs:startedAt?x.created_at-startedAt:null})),reasons,dialed:false}));
const telemetry=await cf('/workers/observability/telemetry/query',{queryId:'native-attended-audio-diagnostic',dry:true,view:'events',limit:40,timeframe:{from:Date.parse('2026-09-30T10:46:00Z'),to:Date.parse('2026-09-30T10:49:00Z')},parameters:{filterCombination:'and',filters:[{key:'$workers.scriptName',operation:'eq',type:'string',value:'pawspace-staging'}],needle:{value:'/voice/exotel/agentstream',isRegex:false,matchCase:false}}}).catch(()=>null);
// Emit only fixed known error signatures, never arbitrary log text, headers or payloads.
const rawTelemetry=JSON.stringify(telemetry||{}),signatures=['WebSocket is not open','WebSocket has been closed','TTS model returned no audio bytes','Cannot perform I/O on behalf of a different request','Invalid PCM media','Invalid base64 media','Malformed AgentStream JSON','InvalidStateError','TypeError','RangeError'].filter(x=>rawTelemetry.includes(x));
console.log('NATIVE_STREAM_TELEMETRY='+JSON.stringify({available:telemetry!==null,signatures,dialed:false}));
const response=await fetch(base+'/ai/run/@cf/deepgram/aura-2-en',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({text:'Hi, I am Maya from PawSpace. How can I help you and your pet today?',speaker:'luna',encoding:'linear16',container:'none',sample_rate:8000}),redirect:'error',signal:AbortSignal.timeout(30000)});
const bytes=new Uint8Array(await response.arrayBuffer());
const safe={status:response.status,contentType:response.headers.get('content-type'),bytes:bytes.length,evenBytes:bytes.length%2===0,dialed:false};
if(!response.ok){try{const body=JSON.parse(new TextDecoder().decode(bytes));safe.errorCodes=(body.errors||[]).map(x=>x.code);safe.errorMessages=(body.errors||[]).map(x=>String(x.message||'').slice(0,180));}catch{}}
console.log('NATIVE_SYNTHETIC_GREETING_PROBE='+JSON.stringify(safe));
