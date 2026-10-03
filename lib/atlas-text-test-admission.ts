import { bindReservedAtlasGeneration } from "./atlas-native-boundary.mjs";
/** One generation, no counting endpoint; normal model-context ceiling bounds input. */
type Db={prepare(sql:string):{bind(...values:unknown[]):{run():Promise<{meta?:{changes?:number}}>;first():Promise<Record<string,unknown>|null>}}};
type Env=Record<string,unknown>;
export const APPROVAL=Object.freeze({jobId:"Sentinel_f67e3c5a85f88191b07279e0edbe250c",provider:"openai",model:"gpt-5.6-terra",customerId:"CUS0000",fixture:"FINANCE-TEST-OPS-GROOMING-01",capMicros:5_000_000,maxTurns:10,capBasis:"api_usage_tax_excluded",taxScopeApproval:"Sentinel_2adfdd39a5b48191b4ba13d4a82e2d67",replacementApproval:"user-combined-six-total-20261003-195955",startsAt:Date.parse("2026-10-03T19:59:55Z"),expiresAt:Date.parse("2026-10-03T20:59:55Z"),maxInputTokens:20_000,maxOutputTokens:1200});
export const INPUT_UPPER=1_050_000,OUTPUT_UPPER=1200;
// Long-context input2x/output1.5x, plus conservative10%regional uplift; no caching.
export const RESERVED_MICROS=4_643_760;
type InputBoundEvidence="utf8_bytes_plus_framing"|"responses_input_tokens"|"model_context_ceiling";
const inputBoundEvidence:InputBoundEvidence="model_context_ceiling";
export const REVIEWED_RATE=Object.freeze({version:"terra-direct-explicit-no-cache-standard-20261003",validUntil:APPROVAL.expiresAt,inputBoundEvidence});
export type Scope={customerId:string;threadId:string};export type Claim={id:string;reservedMicros:number;inputUpper:number};
const text=(v:unknown)=>String(v??"").trim();
export function directPayload(model:string,systemPrompt:string,userPrompt:string,maxOutput:number){
 if(model!==APPROVAL.model||typeof systemPrompt!=="string"||typeof userPrompt!=="string"||!Number.isSafeInteger(maxOutput)||maxOutput<1||maxOutput>OUTPUT_UPPER)throw Error("job_request_shape_mismatch");
 const payload={model,instructions:systemPrompt,input:userPrompt,max_output_tokens:maxOutput,store:false,service_tier:"default",truncation:"disabled",prompt_cache_options:{mode:"explicit"}};
 if(new TextEncoder().encode(JSON.stringify(payload)).length>20000)throw Error("job_request_oversize");
 return payload;
}
export async function reserveTextTest(db:Db|undefined,env:Env,input:{provider:string;model:string;channel?:string;scope?:Scope;systemPrompt:string;userPrompt:string;maxOutput:number;streaming:boolean},now=Date.now()):Promise<Claim|null>{
 if(!text(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID)){if(text(env.PAWSPACE_ISOLATED_FINANCE_TEST)==="true")throw Error("job_scope_missing");return null;}
 if(!db||text(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID)!==APPROVAL.jobId||text(env.PAWSPACE_ISOLATED_FINANCE_TEST)!=="true"||text(env.PAWSPACE_FINANCE_TEST_DESCRIPTOR)!==APPROVAL.fixture||text(env.PAWSPACE_DEPLOYMENT_ENV)!=="staging"||input.provider!==APPROVAL.provider||input.model!==APPROVAL.model||input.channel!=="chat"||input.streaming||input.scope?.customerId!==APPROVAL.customerId||!text(input.scope.threadId))throw Error("job_request_scope_mismatch");
 assertTextTestDispatch({id:"preflight",inputUpper:INPUT_UPPER,reservedMicros:RESERVED_MICROS},now);directPayload(input.model,input.systemPrompt,input.userPrompt,input.maxOutput);
 const id=`ATLASTEXT-${crypto.randomUUID()}`;
 const result=await db.prepare(`INSERT INTO atlas_text_test_requests(id,job_id,rate_version,thread_id,input_upper,output_upper,reserved_micros,status,created_at)
 SELECT ?,?,?,?,?,?,?,'reserved',? WHERE ? < ?
 AND (SELECT COUNT(*) FROM atlas_text_test_requests WHERE job_id=?) < ?
 AND (SELECT COALESCE(SUM(reserved_micros),0) FROM atlas_text_test_requests WHERE job_id=?) + ? <= ?
 AND NOT EXISTS(SELECT 1 FROM atlas_text_test_requests WHERE job_id=? AND status IN ('reserved','unknown'))`).bind(id,APPROVAL.jobId,REVIEWED_RATE.version,input.scope.threadId,INPUT_UPPER,input.maxOutput,RESERVED_MICROS,now,now,APPROVAL.expiresAt,APPROVAL.jobId,APPROVAL.maxTurns,APPROVAL.jobId,RESERVED_MICROS,APPROVAL.capMicros,APPROVAL.jobId).run();
 if(Number(result.meta?.changes)!==1)throw Error("job_admission_refused");
 bindReservedAtlasGeneration({claimId:id,body:JSON.stringify(directPayload(input.model,input.systemPrompt,input.userPrompt,input.maxOutput)),expiresAt:APPROVAL.expiresAt});
 return{id,inputUpper:INPUT_UPPER,reservedMicros:RESERVED_MICROS};
}
export function assertTextTestDispatch(claim:Claim|null,now=Date.now()){if(claim&&(now<APPROVAL.startsAt||now>=APPROVAL.expiresAt||now>=REVIEWED_RATE.validUntil))throw Error("approval_expired");}
export async function markTextTestUnknown(db:Db,claim:Claim){await db.prepare("UPDATE atlas_text_test_requests SET status='unknown' WHERE id=? AND job_id=? AND status='reserved'").bind(claim.id,APPROVAL.jobId).run();}
export async function settleTextTest(db:Db,claim:Claim,response:unknown){
 const record=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
 const r=record(response),u=record(r.usage),i=u.input_tokens,o=u.output_tokens,t=u.total_tokens;
 const details=record(u.input_tokens_details);const writes=[...Object.keys(details).filter(k=>/cache.*(write|creation)/i.test(k)).map(k=>details[k]),...Object.keys(u).filter(k=>/cache.*(write|creation)/i.test(k)).map(k=>u[k])];
 const valid=r.model===APPROVAL.model&&r.service_tier==="default"&&[i,o,t,...writes].every(v=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0)&&writes.every(v=>v===0)&&Number(i)<=INPUT_UPPER&&Number(o)<=OUTPUT_UPPER&&t===Number(i)+Number(o);
 // Ignore all discounts; apply long-context rates and regional allowance even on tiny calls.
 const actual=valid?Math.ceil((Number(i)*40+Number(o)*180)*11/100):null;
 const known=actual!==null&&actual<=claim.reservedMicros;
 await db.prepare("UPDATE atlas_text_test_requests SET status=?,actual_upper_micros=? WHERE id=? AND job_id=? AND status='reserved'").bind(known?"completed":"unknown",known?actual:null,claim.id,APPROVAL.jobId).run();
 if(!known)throw Error("job_usage_unknown");
}
