import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { makeD1 } from './helpers/taxi-harness.mjs';
import { issueDirectBrowserVoiceTicket, handleDirectBrowserVoiceHarnessStream } from '../lib/voice-ai-browser-harness.ts';

class Socket extends EventTarget {
 binaryType='blob';readyState=1;sent=[];acceptedType=null;
 accept(){this.acceptedType=this.binaryType;}
 send(data){this.sent.push(data);}
 receive(data){this.dispatchEvent(new MessageEvent('message',{data:data instanceof ArrayBuffer&&this.binaryType==='blob'?new Blob([data]):data}));}
 close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t){
 const sql=new DatabaseSync(':memory:'),db=makeD1(sql),originalResponse=globalThis.Response,originalPair=globalThis.WebSocketPair;
 let pair;const upstream=new Socket(),calls=[];
 globalThis.WebSocketPair=class{constructor(){this[0]=new Socket();this[1]=new Socket();pair=this;}};
 globalThis.Response=class extends originalResponse{constructor(body,init={}){super(body,init.status===101?{status:200}:init);if(init.status===101){Object.defineProperty(this,'status',{value:101});this.webSocket=init.webSocket;}}};
 t.after(()=>{pair?.[1].close();upstream.close();sql.close();globalThis.Response=originalResponse;globalThis.WebSocketPair=originalPair;});
 const env={DB:db,PAWSPACE_VOICE_ENV:'uat',PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED:'true',PAWSPACE_UAT_SIGNING_KEY:'synthetic-voice-ticket-key-for-unit-test-only',AI:{async run(model,input){calls.push({model,input});if(model==='@cf/deepgram/flux')return{webSocket:upstream};if(model==='@cf/deepgram/aura-1')return new Response(new Uint8Array([1,0,2,0]));return{response:'This is a synthetic service explanation; no booking was made.'};}}};
 const ticket=await issueDirectBrowserVoiceTicket(db,env,'https://uat.pawspace.test');assert.equal(ticket.ok,true);
 const request=()=>new Request(ticket.wsUrl.replace('wss:','https:'),{headers:{upgrade:'websocket'}});
 const response=await handleDirectBrowserVoiceHarnessStream(request(),env);assert.equal(response.status,101);
 return{server:pair[1],upstream,calls,env,request};
}

test('current Worker blob default cannot silently drop browser PCM frames',async t=>{
 const f=await fixture(t);assert.equal(f.server.acceptedType,'arraybuffer','opt in BEFORE accepting browser frames');
 f.server.receive(JSON.stringify({type:'start'}));await tick();await tick();
 const pcm=new Int16Array([1000,-1000,2000,-2000]).buffer;f.server.receive(pcm);await tick();
 const sent=f.upstream.sent.filter(x=>x instanceof ArrayBuffer);assert.equal(sent.length,1);assert.deepEqual(new Int16Array(sent[0]),new Int16Array(pcm));
 assert.ok(f.server.sent.some(x=>typeof x==='string'&&JSON.parse(x).stage==='stt_audio_flowing'));
 f.upstream.receive(JSON.stringify({type:'TurnInfo',event:'EndOfTurn',transcript:'Explain dog grooming; do not book.'}));await tick();await tick();
 const events=f.server.sent.filter(x=>typeof x==='string').map(x=>JSON.parse(x));
 assert.ok(events.some(x=>x.type==='transcript'&&x.text.includes('Explain dog grooming')));
 assert.ok(events.some(x=>x.type==='reply'&&x.text.includes('no booking was made')));
 assert.ok(events.some(x=>x.type==='audio'&&x.purpose==='turn-1'));
 assert.equal(f.calls.filter(x=>x.model==='@cf/openai/gpt-oss-20b').length,1);
 assert.ok(f.calls.find(x=>x.model==='@cf/openai/gpt-oss-20b').input.messages[0].content.includes('do not execute bookings, payments, refunds'));
});
test('single-use ticket and environment denial remain intact',async t=>{
 const f=await fixture(t);
 assert.equal((await handleDirectBrowserVoiceHarnessStream(f.request(),f.env)).status,409);
 assert.equal((await handleDirectBrowserVoiceHarnessStream(f.request(),{...f.env,PAWSPACE_DEPLOYMENT_ENV:'production'})).status,503);
 assert.equal((await handleDirectBrowserVoiceHarnessStream(new Request('https://uat.pawspace.test/voice/ai-self-test?mode=direct',{headers:{upgrade:'websocket'}}),f.env)).status,401);
});
