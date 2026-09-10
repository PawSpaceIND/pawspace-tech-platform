import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
installWorkersHooks('__VOICE_AGENTSTREAM_DB__','__VOICE_AGENTSTREAM_ENV__');
const {exotelTelephony}=await import('../lib/voice-telephony-provider.ts');

const baseEnv={
 EXOTEL_SID:'acme',EXOTEL_API_KEY:'key',EXOTEL_API_TOKEN:'token',
 EXOTEL_CALLER_ID:'+911234567890',EXOTEL_VOICE_APP_ID:'app-1',EXOTEL_WEBHOOK_SECRET:'secret',
 EXOTEL_SUBDOMAIN:'api.exotel.com',PAWSPACE_VOICE_ENV:'uat',
 PAWSPACE_VOICE_STATUS_CALLBACK_URL:'https://uat.example.test/voice/status',
};
const intent={callRef:'VCALL-TEST',toNumber:'+919999999999',statusCallbackUrl:baseEnv.PAWSPACE_VOICE_STATUS_CALLBACK_URL,recordingAllowed:false,timeoutSeconds:45};

async function capture(env){
 let request;
 const prior=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{request={url:String(url),init};return new Response(JSON.stringify({call:{sid:'provider-call-1',status:'queued'}}),{status:200,headers:{'content-type':'application/json'}})};
 try{return {result:await exotelTelephony(env).createCall(intent),request};}
 finally{globalThis.fetch=prior;}
}

test('direct AgentStream uses Exotel multipart contract without overriding the boundary',async()=>{
 const {result,request}=await capture({...baseEnv,PAWSPACE_VOICE_STREAM_URL:'wss://uat.example.test/voice/exotel/agentstream'});
 assert.equal(result.providerCallId,'provider-call-1');
 assert.equal(request.url,'https://api.exotel.com/v1/accounts/acme/calls/connect');
 assert.ok(request.init.body instanceof FormData);
 assert.equal(new Headers(request.init.headers).has('content-type'),false);
 const fields=Object.fromEntries(request.init.body.entries());
 assert.deepEqual(fields,{from:intent.toNumber,callerid:baseEnv.EXOTEL_CALLER_ID,streamurl:'wss://uat.example.test/voice/exotel/agentstream',streamtype:'bidirectional',statuscallback:intent.statusCallbackUrl,customfield:intent.callRef,record:'false',timelimit:'45'});
});

test('classic Voicebot call keeps the existing urlencoded Connect API contract',async()=>{
 const {result,request}=await capture(baseEnv);
 assert.equal(result.providerCallId,'provider-call-1');
 assert.equal(request.url,'https://api.exotel.com/v1/Accounts/acme/Calls/connect.json');
 assert.ok(request.init.body instanceof String||typeof request.init.body==='string');
 assert.equal(new Headers(request.init.headers).get('content-type'),'application/x-www-form-urlencoded');
 const fields=Object.fromEntries(new URLSearchParams(String(request.init.body)));
 assert.equal(fields.From,intent.toNumber);
 assert.equal(fields.CallerId,baseEnv.EXOTEL_CALLER_ID);
 assert.equal(fields.Url,'http://my.exotel.com/acme/exoml/start_voice/app-1');
 assert.equal(fields.CallType,'trans');
 assert.equal(fields.StatusCallback,intent.statusCallbackUrl);
 assert.equal(fields.CustomField,intent.callRef);
 assert.equal(fields.Record,'false');
 assert.equal(fields.TimeOut,'45');
});
