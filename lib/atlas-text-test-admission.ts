/** Isolated one-job safeguard. Unknown tariff/tokenizer attestations fail closed.
 * No secret values, rollout changes, network calls or runtime schema initialization. */
type Db={prepare(sql:string):{bind(...values:unknown[]):any}};
type Env=Record<string,unknown>;
export const APPROVAL=Object.freeze({jobId:"Sentinel_f67e3c5a85f88191b07279e0edbe250c",provider:"openai",model:"gpt-5.6-terra",customerId:"CUS0000",fixture:"FINANCE-TEST-OPS-GROOMING-01",capMicros:1_000_000,maxTurns:10,startsAt:Date.parse("2026-10-03T13:15:48Z"),expiresAt:Date.parse("2026-10-03T14:15:48Z"),maxInputTokens:20_000,maxOutputTokens:1200});
// Replace ONLY after independent review of exact billable alias, gross tariff and
// whole Responses request tokenizer/framing upper bound. UNKNOWN never admits.
export const REVIEWED_RATE:Readonly<Rate>|null=null;
export type Rate={version:string;provider:string;model:string;billableModel:string;validUntil:number;grossMicrosPerInputToken:number;grossMicrosPerOutputToken:number;framingTokens:number;tokenBound:"utf8_bytes_plus_framing";reviewed:true};
export type Scope={customerId:string;threadId:string};
export type Claim={id:string;reservedMicros:number;inputUpper:number};
const text=(v:unknown)=>String(v??"").trim();
export function costBound(rate:Rate,systemPrompt:string,userPrompt:string,maxOutput:number,now:number){
 if(!rate.reviewed||rate.provider!==APPROVAL.provider||rate.model!==APPROVAL.model||!rate.billableModel||!rate.version||!Number.isFinite(rate.validUntil)||rate.validUntil<=now||rate.tokenBound!=="utf8_bytes_plus_framing")throw Error("unknown_tariff_or_token_bound");
 if(!Number.isSafeInteger(rate.framingTokens)||rate.framingTokens<1||![rate.grossMicrosPerInputToken,rate.grossMicrosPerOutputToken].every(v=>Number.isFinite(v)&&v>0))throw Error("unknown_tariff_or_token_bound");
 const inputUpper=new TextEncoder().encode(systemPrompt).length+new TextEncoder().encode(userPrompt).length+rate.framingTokens;
 if(inputUpper>APPROVAL.maxInputTokens||!Number.isInteger(maxOutput)||maxOutput<1||maxOutput>APPROVAL.maxOutputTokens)throw Error("token_bound_exceeded");
 const reservedMicros=Math.ceil((inputUpper+maxOutput)*Math.max(rate.grossMicrosPerInputToken,rate.grossMicrosPerOutputToken));
 if(!Number.isSafeInteger(reservedMicros)||reservedMicros<1||reservedMicros>APPROVAL.capMicros)throw Error("cost_bound_exceeded");
 return{inputUpper,reservedMicros};
}
export async function reserveTextTest(db:Db|undefined,env:Env,input:{provider:string;model:string;channel?:string;scope?:Scope;systemPrompt:string;userPrompt:string;maxOutput:number;streaming:boolean},now=Date.now(),rate:Readonly<Rate>|null=REVIEWED_RATE):Promise<Claim|null>{
 if(!text(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID)){if(text(env.PAWSPACE_ISOLATED_FINANCE_TEST)==="true")throw Error("isolated_job_scope_required");return null;}
 if(text(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID)!==APPROVAL.jobId||text(env.PAWSPACE_ISOLATED_FINANCE_TEST)!=="true"||text(env.PAWSPACE_FINANCE_TEST_DESCRIPTOR)!==APPROVAL.fixture||text(env.PAWSPACE_DEPLOYMENT_ENV)!=="staging"||!db)throw Error("isolated_job_scope_required");
 if(now<APPROVAL.startsAt||now>=APPROVAL.expiresAt)throw Error("approval_expired");
 if(input.provider!==APPROVAL.provider||input.model!==APPROVAL.model||input.channel!=="chat"||input.streaming||input.scope?.customerId!==APPROVAL.customerId||!text(input.scope.threadId))throw Error("job_request_scope_mismatch");
 if(!rate)throw Error("unknown_tariff_or_token_bound");
 const bound=costBound(rate,input.systemPrompt,input.userPrompt,input.maxOutput,now),id=`ATLASTEXT-${crypto.randomUUID()}`;
 // One conditional INSERT serializes count/cost/unknown checks across D1 isolates.
 // All reservations remain charged for admission forever, including failures/timeouts.
 const result=await db.prepare(`INSERT INTO atlas_text_test_requests (id,job_id,rate_version,thread_id,input_upper,output_upper,reserved_micros,status,created_at)
 SELECT ?,?,?,?,?,?,?,'reserved',?
 WHERE ? < ?
 AND (SELECT COUNT(*) FROM atlas_text_test_requests WHERE job_id=?) < ?
 AND (SELECT COALESCE(SUM(reserved_micros),0) FROM atlas_text_test_requests WHERE job_id=?) + ? <= ?
 AND NOT EXISTS (SELECT 1 FROM atlas_text_test_requests WHERE job_id=? AND status IN ('reserved','unknown'))`).bind(id,APPROVAL.jobId,rate.version,input.scope.threadId,bound.inputUpper,input.maxOutput,bound.reservedMicros,now,now,APPROVAL.expiresAt,APPROVAL.jobId,APPROVAL.maxTurns,APPROVAL.jobId,bound.reservedMicros,APPROVAL.capMicros,APPROVAL.jobId).run();
 if(Number(result.meta?.changes)!==1)throw Error("job_admission_refused");
 return{id,...bound};
}
export async function settleTextTest(db:Db,claim:Claim,totalTokens:unknown,rate:Readonly<Rate>|null=REVIEWED_RATE){
 // Total usage times the greater gross tariff conservatively bounds actual dollars.
 // No refunds to available budget. Missing/invalid/over-bound usage latches unknown.
 const usage=totalTokens&&typeof totalTokens==="object"?totalTokens as Record<string,unknown>:{};
 const tokens=usage.total_tokens, input=usage.input_tokens, output=usage.output_tokens;
 const valid=[tokens,input,output].every(v=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0)
  &&Number(input)<=claim.inputUpper&&Number(output)<=APPROVAL.maxOutputTokens&&Number(tokens)===Number(input)+Number(output);
 const actual=rate&&valid?Math.ceil(Number(tokens)*Math.max(rate.grossMicrosPerInputToken,rate.grossMicrosPerOutputToken)):null;
 const known=actual!==null&&actual<=claim.reservedMicros;
 await db.prepare("UPDATE atlas_text_test_requests SET status=?,actual_upper_micros=? WHERE id=? AND job_id=? AND status='reserved'").bind(known?"completed":"unknown",known?actual:null,claim.id,APPROVAL.jobId).run();
 if(!known)throw Error("job_usage_unknown");
}
export async function markTextTestUnknown(db:Db,claim:Claim){await db.prepare("UPDATE atlas_text_test_requests SET status='unknown' WHERE id=? AND job_id=? AND status='reserved'").bind(claim.id,APPROVAL.jobId).run();}

export function assertTextTestDispatch(claim:Claim|null,now=Date.now(),rate:Readonly<Rate>|null=REVIEWED_RATE){
 if(!claim)return;
 if(now<APPROVAL.startsAt||now>=APPROVAL.expiresAt)throw Error("approval_expired");
 if(!rate||!Number.isFinite(rate.validUntil)||now>=rate.validUntil)throw Error("unknown_tariff_or_token_bound");
}
