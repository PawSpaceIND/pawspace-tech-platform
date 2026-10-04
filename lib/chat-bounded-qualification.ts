import {reserveBoundedChatAllocation,completeBoundedChatAllocation,markBoundedChatAllocationUnknown} from './atlas-text-test-admission';
import {readBoundedText} from './provider-response-bounds';

// Publisher supplies a reviewed, server-owned approval; this boundary has no default activation.
export type ChatQualificationApproval={jobId:string;customerId:string;threadId:string;sourceSha:string;startsAt:number;expiresAt:number;capMicros:number;maxTurns:1|2;reservationMicros:number;billingVerified:true;transportVerified:true};
type Db={prepare(sql:string):{bind(...values:unknown[]):{run():Promise<{meta?:{changes?:number}}>;first():Promise<Record<string,unknown>|null>}}};
const INPUT=20_000,OUTPUT=650,API_RESERVATION=100_870;
const COUNT='https://api.openai.com/v1/responses/input_tokens',GENERATE='https://api.openai.com/v1/responses';
export async function runBoundedChatQualification(input:{db:Db;approval:ChatQualificationApproval;env:Record<string,unknown>;customerId:string;threadId:string;turnKey:string;systemPrompt:string;userPrompt:string;outputTokens:number;informationOnly:boolean;signal?:AbortSignal;fetcher:typeof fetch;credential:string;now?:()=>number}){
 const a=Object.freeze({...input.approval}),env=input.env,now=input.now??Date.now,outputTokens=input.outputTokens;
 const {db,signal,fetcher,credential,turnKey}=input;
 const assertCurrent=()=>{if(signal?.aborted)throw Error('chat_cancelled');if(now()<a.startsAt||now()>=a.expiresAt)throw Error('chat_approval_expired');};
 if(!a||a.billingVerified!==true||a.transportVerified!==true||!a.jobId||a.jobId===String(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID??'')||input.customerId!==a.customerId||input.threadId!==a.threadId||!a.threadId||!turnKey||!credential||input.informationOnly!==true||env.PAWSPACE_DEPLOYMENT_ENV!=='staging'||env.PAWSPACE_STAGING_BUILD_SHA!==a.sourceSha||!/^[0-9a-f]{40}$/.test(a.sourceSha)||!Number.isSafeInteger(a.startsAt)||!Number.isSafeInteger(a.expiresAt)||a.expiresAt<=a.startsAt||a.expiresAt-a.startsAt>3_600_000||![1,2].includes(a.maxTurns)||!Number.isSafeInteger(a.capMicros)||a.capMicros<1||a.capMicros>500_000||!Number.isSafeInteger(a.reservationMicros)||a.reservationMicros<API_RESERVATION||a.reservationMicros>a.capMicros||typeof input.systemPrompt!=='string'||typeof input.userPrompt!=='string'||!Number.isSafeInteger(outputTokens)||outputTokens<1||outputTokens>OUTPUT)throw Error('chat_scope_refused');
 assertCurrent();
 const payload=Object.freeze({model:'gpt-5.6-terra',instructions:input.systemPrompt,input:input.userPrompt,max_output_tokens:outputTokens,store:false,service_tier:'default',truncation:'disabled',prompt_cache_options:Object.freeze({mode:'explicit'})});
 const body=JSON.stringify(payload);
 if(new TextEncoder().encode(body).length>32_000)throw Error('chat_payload_oversize');
 const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
 const payloadHash=await digest(body),id='CHATBOUND-'+await digest(JSON.stringify([a.jobId,a.threadId,turnKey]));
 assertCurrent();
 // The existing retained ledger is shared; no DDL, sweeps, refunds or parallel allowance.
 const allocation=await reserveBoundedChatAllocation(db,{id,jobId:a.jobId,payloadHash,threadId:a.threadId,inputUpper:INPUT,outputUpper:outputTokens,reservedMicros:a.reservationMicros,maxTurns:a.maxTurns,capMicros:a.capMicros,now:now()});
 const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,Math.min(30_000,Math.max(1,a.expiresAt-now())));
 const post=async(url:string,requestBody:string,maxBytes:number)=>{assertCurrent();if(controller.signal.aborted)throw Error('chat_cancelled');const r=await fetcher(url,{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:requestBody});if(!r.ok)throw Error('chat_provider_refused');return JSON.parse(await readBoundedText(r,maxBytes));};
 try{
  const count=await post(COUNT,JSON.stringify({model:payload.model,instructions:payload.instructions,input:payload.input}),4096);
  if(count?.object!=='response.input_tokens'||!Number.isSafeInteger(count.input_tokens)||count.input_tokens<0||count.input_tokens>INPUT)throw Error('chat_input_bound_refused');
  const result=await post(GENERATE,body,512*1024),u=result?.usage;
  const cache=u?.input_tokens_details;
  const cacheWrites=[...Object.entries(cache??{}),...Object.entries(u??{})].filter(([key])=>/cache.*(write|creation)/i.test(key)).map(([,value])=>value);
  if(result?.model!==payload.model||result?.service_tier!=='default'||![u?.input_tokens,u?.output_tokens,u?.total_tokens].every(v=>Number.isSafeInteger(v)&&v>=0)||u.input_tokens>INPUT||u.input_tokens>count.input_tokens||u.output_tokens>outputTokens||u.total_tokens!==u.input_tokens+u.output_tokens||cacheWrites.some(v=>v!==0))throw Error('chat_usage_unknown');
  assertCurrent();
  await completeBoundedChatAllocation(db,allocation,Math.ceil((u.input_tokens*4+u.output_tokens*18)*1.1));
  return{result,payloadHash,inputTokens:count.input_tokens,reservedMicros:a.reservationMicros};
 }catch(error){await markBoundedChatAllocationUnknown(db,allocation);throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
