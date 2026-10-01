"use client";
import Link from"next/link";
import{useEffect,useRef,useState}from"react";
import{StatCard}from"../../../components/ui";
import{loadSittingFinance,updateSittingFinance}from"../../../../lib/sitting-finance-client";
import {sittingReconciliationLabel} from "../../../../lib/sitting-reconciliation-display";
import StaffModule from "../../../components/staff-workspace/StaffModule";
import styles from "./sitting-content.module.css";

type Row=Record<string,unknown>;
type FinanceData={booking:Row;cancellations:Row[];dateChanges:Row[];refunds:Row[];settlement:Row|null;reconciliation:Row|null;sandboxOnly:true};
const money=(value:unknown)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value||0));
const label=(value:unknown)=>String(value||"not configured").replaceAll("_"," ");

export default function SittingFinanceWorkspace({initialBookingId}:{initialBookingId:string}){
 const[bookingId,setBookingId]=useState(initialBookingId),[data,setData]=useState<FinanceData|null>(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const readVersion=useRef(0),actionInFlight=useRef(false);
 const[actionBusy,setActionBusy]=useState(false);
 async function readBooking(id:string){
  const version=++readVersion.current;setData(null);setError("");setMessage("");
  if(!id){setBusy(false);return;}
  setBusy(true);
  try{
   const value=await loadSittingFinance(id) as FinanceData;
   if(version!==readVersion.current)return;
   if(String(value.booking.id)!==id)throw new Error("The returned Sitting booking does not match the requested ID.");
   setData(value);
  }catch(problem){if(version===readVersion.current)setError(problem instanceof Error?problem.message:"Unable to load Sitting finance")}
  finally{if(version===readVersion.current)setBusy(false)}
 }
 // Synchronize the canonical booking prop and immediately revoke stale action controls.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useEffect(()=>{const reads=readVersion;setBookingId(initialBookingId);void readBooking(initialBookingId.trim());return()=>{reads.current++}},[initialBookingId]);
 function editBookingId(value:string){if(actionInFlight.current)return;readVersion.current++;setBookingId(value);setData(null);setError("");setMessage("");setBusy(false)}
 async function load(){if(actionInFlight.current)return;await readBooking(bookingId.trim())}
 async function act(payload:Record<string,unknown>,success:string){
  const targetId=String(data?.booking.id||"");
  if(busy||actionInFlight.current||!targetId||targetId!==bookingId.trim())return;
  actionInFlight.current=true;setActionBusy(true);const version=++readVersion.current;setBusy(true);setError("");setMessage("");
  try{
   await updateSittingFinance({bookingId:targetId,action:String(payload.action) as never,idempotencyKey:String(payload.idempotencyKey),cancellationRequestId:payload.cancellationRequestId as string|undefined,refundId:payload.refundId as string|undefined,dateChangeRequestId:payload.dateChangeRequestId as string|undefined,reason:payload.reason as string|undefined,requestedStart:payload.requestedStart as string|undefined,requestedEnd:payload.requestedEnd as string|undefined,quoteId:payload.quoteId as string|undefined,replacementGroupId:payload.replacementGroupId as string|undefined,approvedRefundAmount:payload.approvedRefundAmount as number|undefined,refundReference:payload.refundReference as string|undefined,paymentAdjustmentReference:payload.paymentAdjustmentReference as string|undefined});
   if(version!==readVersion.current)return;
   const value=await loadSittingFinance(targetId) as FinanceData;
   if(version!==readVersion.current)return;
   if(String(value.booking.id)!==targetId)throw new Error("The refreshed Sitting booking does not match the action target.");
   setData(value);setMessage(success);
  }catch(problem){if(version===readVersion.current){setData(null);setError(problem instanceof Error?problem.message:"Sitting finance action failed")}}
  finally{actionInFlight.current=false;setActionBusy(false);if(version===readVersion.current)setBusy(false)}
 }
 function approveCancel(row:Row){const amount=Number(window.prompt(`Approved refund amount for ${bookingId} (0 to ${String(data?.booking.total_amount||0)})`,"0"));const reason=window.prompt("Finance approval reason / policy reference")||"";if(Number.isFinite(amount)&&amount>=0&&reason.trim().length>=3)void act({action:"approve_cancel",cancellationRequestId:String(row.id),idempotencyKey:`sitting-finance:approve-cancel:${String(row.id)}`,approvedRefundAmount:amount,reason},"Cancellation approved under explicit Finance authority.")}
 function recordRefund(row:Row){const reference=window.prompt(`Sandbox refund reference for ${money(row.amount)}`)||"";if(reference)void act({action:"record_refund",refundId:String(row.id),idempotencyKey:`sitting-finance:refund:${String(row.id)}:${reference}`,refundReference:reference},"Sandbox refund reference recorded.")}
 function applyDateChange(row:Row){const quoteId=window.prompt("Fresh canonical Sitting quote ID")||"",replacementGroupId=window.prompt("Fresh replacement scheduling group ID")||"";if(!quoteId||!replacementGroupId)return;const oldTotal=Number(row.old_total||0),newTotal=Number(row.new_total||0),paymentAdjustmentReference=newTotal>oldTotal?window.prompt("Additional sandbox payment reference")||"":undefined;void act({action:"apply_date_change",dateChangeRequestId:String(row.id),idempotencyKey:`sitting-finance:date-change:${String(row.id)}:${quoteId}`,quoteId,replacementGroupId,paymentAdjustmentReference},"Canonical Sitting date change applied.")}
 function prepareSettlement(){void act({action:"prepare_settlement",idempotencyKey:`sitting-finance:settlement:${String(data?.booking.id||"")}`},"Sitter settlement projected from canonical completion finance.")}
 function approveSettlement(){const reason=window.prompt("Finance approval reason / reference")||"";if(reason.trim().length>=3)void act({action:"approve_settlement",idempotencyKey:`sitting-finance:settlement-approve:${String(data?.booking.id||"")}`,reason},"Canonical sitter settlement approved. No live payout was instructed.")}
 // This callback runs only on a reconciliation click; its request timestamp is never rendered.
 // eslint-disable-next-line react-hooks/purity
 function reconcile(){void act({action:"reconcile",idempotencyKey:`sitting-finance:reconcile:${String(data?.booking.id||"")}:${Date.now()}`},"Sitting finance reconciliation refreshed.")}
 const booking=data?.booking;
 return <StaffModule><main className={styles.sitting} style={{minHeight:"100vh",background:"var(--staff-bg)",padding:32,fontFamily:"inherit",color:"var(--staff-text)"}}><div style={{maxWidth:1200,margin:"0 auto"}}><header style={{display:"flex",justifyContent:"space-between",gap:20,alignItems:"center",marginBottom:24}}><div><small style={{fontWeight:800,letterSpacing:1.3,color:"var(--paw-link)"}}>PAWSPACE TEAM · FINANCE · SITTING</small><h1 style={{margin:"8px 0"}}>Sitting finance & reconciliation</h1><p style={{margin:0}}>Cancellation, sandbox refund, date-change, settlement and reconciliation truth for one canonical Sitting booking.</p></div><Link href="/team/finance">Finance home</Link></header><section style={{display:"flex",gap:10,marginBottom:18}}><input disabled={actionBusy} value={bookingId} onChange={e=>editBookingId(e.target.value)} placeholder="Canonical Sitting booking ID" style={{flex:1,padding:11}}/><button disabled={busy||!bookingId.trim()} onClick={()=>void load()}>Load booking</button></section>{error&&<section style={{padding:14,background:"var(--staff-danger-bg)",borderRadius:"calc(12px * var(--paw-radius-scale))",marginBottom:14}}>{error}</section>}{message&&<section style={{padding:14,background:"var(--staff-success-bg)",borderRadius:"calc(12px * var(--paw-radius-scale))",marginBottom:14}}>{message}</section>}{booking&&<><section style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:12,marginBottom:18}} data-staff-grid="stats">{[["Status",label(booking.status)],["Booking total",money(booking.total_amount)],["Captured",money(booking.captured_amount)],["Payment",label(booking.payment_status)]].map(([name,value])=><StatCard key={String(name)} label={String(name)} value={value} />)}</section><section style={{background:"var(--staff-surface)",padding:18,borderRadius:"calc(14px * var(--paw-radius-scale))",marginBottom:16}}><h2>Cancellation review</h2>{data?.cancellations.length?data.cancellations.map(row=><div key={String(row.id)} style={{padding:"10px 0",borderTop:"1px solid var(--staff-line)"}}><strong>{label(row.status)}</strong> · {String(row.reason||"")} {String(row.status)==="policy_review_required"&&<button disabled={busy} onClick={()=>approveCancel(row)}>Approve explicitly</button>}</div>):<p>No cancellation request.</p>}{data?.refunds.map(row=><div key={String(row.id)} style={{padding:"10px 0",borderTop:"1px solid var(--staff-line)"}}><strong>{money(row.amount)}</strong> · {label(row.status)} {String(row.status)==="sandbox_pending"&&<button disabled={busy} onClick={()=>recordRefund(row)}>Record sandbox refund</button>}</div>)}</section><section style={{background:"var(--staff-surface)",padding:18,borderRadius:"calc(14px * var(--paw-radius-scale))",marginBottom:16}}><h2>Date-change review</h2>{data?.dateChanges.length?data.dateChanges.map(row=><div key={String(row.id)} style={{padding:"10px 0",borderTop:"1px solid var(--staff-line)"}}><strong>{label(row.status)}</strong><div>{String(row.requested_start)} → {String(row.requested_end)}</div><small>The old paid window remains canonical until a fresh quote and replacement reservation are supplied.</small>{String(row.status)==="commercial_quote_required"&&<div><button disabled={busy} onClick={()=>applyDateChange(row)}>Apply with quote + replacement schedule</button></div>}</div>):<p>No date-change request.</p>}</section><section style={{background:"var(--staff-surface)",padding:18,borderRadius:"calc(14px * var(--paw-radius-scale))",marginBottom:16}}><h2>Sitter settlement</h2><p>{data?.settlement?`${label(data.settlement.approval_status)} · payout ${label(data.settlement.payout_status)} · tax ${label(data.settlement.tax_status)}`:"Not prepared"}</p><button disabled={busy||String(booking.status)!=="completed"} onClick={prepareSettlement}>Prepare canonical settlement</button> {data?.settlement&&String(data.settlement.approval_status)==="awaiting_finance_approval"&&<button disabled={busy} onClick={approveSettlement}>Approve when eligible</button>}<p style={{fontSize:14}}>Amount and tax status come only from canonical completion finance. The payout hold set by Finance (days after checkout) is enforced before approval; approval still does not move live money, and the payout itself is released once from Finance, Provider payouts.</p></section><section style={{background:"var(--staff-surface)",padding:18,borderRadius:"calc(14px * var(--paw-radius-scale))"}}><h2>Reconciliation</h2><p>{sittingReconciliationLabel(booking.status,data?.reconciliation)}</p><button disabled={busy} onClick={reconcile}>Run canonical reconciliation</button><p style={{fontSize:14}}>Sandbox-only. Live refunds, payout execution and tax filing remain disconnected.</p></section></>}</div></main></StaffModule>;
}
