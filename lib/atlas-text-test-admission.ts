/** Isolated one-job safeguard. Unknown tariff/tokenizer attestations fail closed.
 * No secret values, rollout changes, network calls or runtime schema initialization. */
type Db={prepare(sql:string):{bind(...values:unknown[]):{run():Promise<{meta?:{changes?:number}}>;first():Promise<Record<string,unknown>|null>}}};
type Env=Record<string,unknown>;
export const APPROVAL=Object.freeze({jobId:"Sentinel_f67e3c5a85f88191b07279e0edbe250c",provider:"openai",model:"gpt-5.6-terra",customerId:"CUS0000",fixture:"FINANCE-TEST-OPS-GROOMING-01",capMicros:1_000_000,maxTurns:10,startsAt:Date.parse("2026-10-03T13:15:48Z"),expiresAt:Date.parse("2026-10-03T14:15:48Z"),maxInputTokens:20_000,maxOutputTokens:1200});
// Replace ONLY after independent review of exact billable alias, gross tariff and
// whole Responses request tokenizer/framing upper bound. UNKNOWN never admits.
export const REVIEWED_RATE:Readonly<Rate>|null=null;
type InputBoundEvidence="utf8_bytes_plus_framing"|"responses_input_tokens";
export type Rate={version:string;provider:string;model:string;billableModel:string;validUntil:number;grossMicrosPerInputToken:number;grossMicrosPerOutputToken:number;framingTokens:number;tokenBound:InputBoundEvidence;reviewed:true;countEndpointFree?:true};
export type Scope={customerId:string;threadId:string};
export type Claim={id:string;reservedMicros:number;inputUpper:number};
const text=(v:unknown)=>String(v??"").trim();
export function costBound(rate:Rate,systemPrompt:string,userPrompt:string,maxOutput:number,now:number,exactInput?:number){
 if(!rate.reviewed||rate.provider!==APPROVAL.provider||rate.model!==APPROVAL.model||!rate.billableModel||!rate.version||!Number.isFinite(rate.validUntil)||rate.validUntil<=now||!["utf8_bytes_plus_framing","responses_input_tokens"].includes(rate.tokenBound))throw Error("unknown_tariff_or_token_bound");
 if(!Number.isSafeInteger(rate.framingTokens)||rate.framingTokens<(rate.tokenBound==="responses_input_tokens"?0:1)||![rate.grossMicrosPerInputToken,rate.grossMicrosPerOutputToken].every(v=>Number.isFinite(v)&&v>0))throw Error("unknown_tariff_or_token_bound");
 const inputUpper=rate.tokenBound==="responses_input_tokens"?exactInput:new TextEncoder().encode(systemPrompt).length+new TextEncoder().encode(userPrompt).length+rate.framingTokens;
 if(typeof inputUpper!=="number"||!Number.isSafeInteger(inputUpper)||inputUpper<0)throw Error("input_count_required");
 if(inputUpper>APPROVAL.maxInputTokens||!Number.isInteger(maxOutput)||maxOutput<1||maxOutput>APPROVAL.maxOutputTokens)throw Error("token_bound_exceeded");
 const reservedMicros=Math.ceil((inputUpper+maxOutput)*Math.max(rate.grossMicrosPerInputToken,rate.grossMicrosPerOutputToken));
 if(!Number.isSafeInteger(reservedMicros)||reservedMicros<1||reservedMicros>APPROVAL.capMicros)throw Error("cost_bound_exceeded");
 return{inputUpper,reservedMicros};
}
export async function reserveTextTest(db:Db|undefined,env:Env,input:{provider:string;model:string;channel?:string;scope?:Scope;systemPrompt:string;userPrompt:string;maxOutput:number;streaming:boolean;exactInput?:number},now=Date.now(),rate:Readonly<Rate>|null=REVIEWED_RATE):Promise<Claim|null>{
 if(!text(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID)){if(text(env.PAWSPACE_ISOLATED_FINANCE_TEST)==="true")throw Error("isolated_job_scope_required");return null;}
 if(text(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID)!==APPROVAL.jobId||text(env.PAWSPACE_ISOLATED_FINANCE_TEST)!=="true"||text(env.PAWSPACE_FINANCE_TEST_DESCRIPTOR)!==APPROVAL.fixture||text(env.PAWSPACE_DEPLOYMENT_ENV)!=="staging"||!db)throw Error("isolated_job_scope_required");
 if(now<APPROVAL.startsAt||now>=APPROVAL.expiresAt)throw Error("approval_expired");
 if(input.provider!==APPROVAL.provider||input.model!==APPROVAL.model||input.channel!=="chat"||input.streaming||input.scope?.customerId!==APPROVAL.customerId||!text(input.scope.threadId))throw Error("job_request_scope_mismatch");
 if(!rate)throw Error("unknown_tariff_or_token_bound");
 const bound=costBound(rate,input.systemPrompt,input.userPrompt,input.maxOutput,now,input.exactInput),id=`ATLASTEXT-${crypto.randomUUID()}`;
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

/** Authoritative non-generation count. Kept private to server adapter; never trust a
 * client token count. Same immutable model/instructions/input strings feed generation. */
export async function countTextTestInput(env:Env,input:{provider:string;model:string;channel?:string;scope?:Scope;streaming:boolean;systemPrompt:string;userPrompt:string},credential:string,fetcher:typeof fetch=fetch,now=Date.now(),rate:Readonly<Rate>|null=REVIEWED_RATE,db?:Db):Promise<number|undefined>{
 if(!text(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID))return undefined;
 if(text(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID)!==APPROVAL.jobId||text(env.PAWSPACE_ISOLATED_FINANCE_TEST)!=="true"||text(env.PAWSPACE_FINANCE_TEST_DESCRIPTOR)!==APPROVAL.fixture||text(env.PAWSPACE_DEPLOYMENT_ENV)!=="staging"||input.provider!==APPROVAL.provider||input.model!==APPROVAL.model||input.channel!=="chat"||input.streaming||input.scope?.customerId!==APPROVAL.customerId||!text(input.scope.threadId)||!credential)throw Error("job_request_scope_mismatch");
 assertTextTestDispatch({id:"count-preflight",inputUpper:0,reservedMicros:0},now,rate);
 if(rate?.tokenBound!=="responses_input_tokens"||rate.countEndpointFree!==true)throw Error("authoritative_token_count_required");
 costBound(rate,input.systemPrompt,input.userPrompt,1,now,0); // full immutable tariff validation before network
 if(!db)throw Error("isolated_job_scope_required");
 const state=await db.prepare("SELECT COUNT(*) turns,COALESCE(SUM(reserved_micros),0) reserved,COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN 1 ELSE 0 END),0) stopped FROM atlas_text_test_requests WHERE job_id=?").bind(APPROVAL.jobId).first();
 if(!state||Number(state.turns)>=APPROVAL.maxTurns||Number(state.reserved)>=APPROVAL.capMicros||Number(state.stopped)>0)throw Error("job_admission_refused");
 assertTextTestDispatch({id:"count-preflight",inputUpper:0,reservedMicros:0},Date.now(),rate);
 // No tools/images/files/previous_response_id or opaque persisted conversation:
 // complete canonical context/history/tool descriptions live inside these strings.
 const response=await fetcher("https://api.openai.com/v1/responses/input_tokens",{method:"POST",signal:AbortSignal.timeout(5000),headers:{"content-type":"application/json",authorization:`Bearer ${credential}`},body:JSON.stringify({model:input.model,instructions:input.systemPrompt,input:input.userPrompt})});
 if(!response.ok)throw Error("input_count_unavailable");
 const raw=await response.text();if(raw.length>4096)throw Error("input_count_unavailable");
 const data=JSON.parse(raw) as {object?:unknown;input_tokens?:unknown};
 if(data.object!=="response.input_tokens"||typeof data.input_tokens!=="number"||!Number.isSafeInteger(data.input_tokens)||data.input_tokens<0||data.input_tokens>APPROVAL.maxInputTokens)throw Error("input_count_invalid");
 return data.input_tokens;
}
