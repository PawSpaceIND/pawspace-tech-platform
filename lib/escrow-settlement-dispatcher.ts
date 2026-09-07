import{acknowledgeEscrowSettlement,claimNextEscrowSettlement,markEscrowSettlementFailed}from"./escrow-custody-settlement";
import{json,text,type Db,type Row,type SettlementKind}from"./escrow-custody-schema";

export type EscrowSettlementDispatchInput={kind:SettlementKind;amount:number;currency:string;bookingId:string;disputeId:string|null;payload:Record<string,unknown>;idempotencyKey:string};
export type EscrowSettlementAdapter={dispatch(input:EscrowSettlementDispatchInput):Promise<{externalReference:string}>};

export async function dispatchNextEscrowSettlement(db:Db,input:{workerId:string;adapter:EscrowSettlementAdapter;now?:number;maxAttempts?:number}){
 const row=await claimNextEscrowSettlement(db,{workerId:input.workerId,now:input.now})as Row|null;if(!row)return{status:"IDLE"as const};
 const request:EscrowSettlementDispatchInput={kind:text(row.kind)as SettlementKind,amount:Number(row.amount),currency:text(row.currency)||"INR",bookingId:text(row.booking_id),disputeId:text(row.dispute_id)||null,payload:JSON.parse(text(row.payload_json)||"{}")as Record<string,unknown>,idempotencyKey:text(row.idempotency_key)};
 try{const result=await input.adapter.dispatch(request);const externalReference=text(result?.externalReference);if(externalReference.length<4)throw new Error("settlement_adapter_external_reference_required");const confirmed=await acknowledgeEscrowSettlement(db,{outboxId:text(row.id),workerId:input.workerId,externalReference,now:input.now});return{status:"CONFIRMED"as const,outboxId:text(row.id),idempotencyKey:request.idempotencyKey,externalReference,confirmed};}
 catch(error){const message=error instanceof Error?error.message:String(error);const failed=await markEscrowSettlementFailed(db,{outboxId:text(row.id),workerId:input.workerId,error:message,maxAttempts:input.maxAttempts,now:input.now});return{status:failed.status,idempotencyKey:request.idempotencyKey,outboxId:text(row.id),error:message,nextAttemptAt:failed.nextAttemptAt,attempts:failed.attempts};}
}

export function settlementDispatchEvidence(row:Row){return json({outboxId:text(row.id),kind:text(row.kind),bookingId:text(row.booking_id),idempotencyKey:text(row.idempotency_key),attemptCount:Number(row.attempt_count||0),status:text(row.status),externalReference:text(row.external_reference)||null});}
