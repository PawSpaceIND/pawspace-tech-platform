"use client";
import{useEffect,useState}from"react";
import Link from"next/link";
type Scheme={id:string;scheme_code:string;version:number;status:string;role_code:string;team_code:string;effective_from:number;effective_until?:number|null};
type Result={id:string;employee_id:string;employee_email:string;metric_value:number;calculated_amount:number;approved_amount:number;status:string;scheme_code:string;version:number;period_start:number;period_end:number;reversed_amount?:number;reversal_count?:number;remaining_reversible?:number};
type Dispute={id:string;result_id:string;status:string;reason:string;opened_by:string;opened_at:number};
type Reversal={id:string;result_id:string;amount:number;reason:string;status:string;effective_at:number;actor_id:string;created_at:number};
type Adjustment={id:string;result_id:string;amount:number;reason:string;status:string;requested_by:string;requested_at:number;approved_by?:string|null;approved_at?:number|null};
type Payload={schemes:Scheme[];results:Result[];disputes:Dispute[];reversals?:Reversal[];adjustments?:Adjustment[];truth:{formulaValuesConfiguredNotHardcoded:boolean;pipelineRevenueEligible:boolean;humanApprovalRequired:boolean;payrollInclusionOneTime:boolean;productionReady:boolean}};
type DisputeDraft={resultId:string;reason:string};
type ResolveDraft={disputeId:string;resolutionNote:string;release:boolean};
type ReverseDraft={resultId:string;amount:string;reason:string};
type AdjustDraft={resultId:string;amount:string;reason:string};
async function loadPayload(){const r=await fetch("/api/incentives",{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"Incentive load failed");return p.data as Payload;}
const day=(v:number)=>new Date(v).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"});
const rupees=(v:unknown)=>Number(v||0).toLocaleString("en-IN");

/**
 * Is a resolution draft genuinely open for THIS result's dispute?
 *
 * This gates a money control: the form it draws carries "Release for payment", which decides whether an
 * incentive result flows into payroll or is held. It used to be written `resolveDraft?.disputeId===dispute?.id`,
 * and on a result with NO dispute, with NO draft open, both sides optional-chained to `undefined` -
 * `undefined===undefined` is true, so every result drew a resolution form and a Submit button that
 * `submitResolve()` discarded at its own `if(!resolveDraft)return;`. Three results with zero disputes drew
 * three release-for-payment checkboxes that did nothing, silently. Both operands must EXIST before their
 * ids are compared; absence is never a match.
 */
export function resolveFormOpen(resolveDraft:{disputeId:string}|null|undefined,dispute:{id:string}|null|undefined){
  return Boolean(resolveDraft&&dispute&&resolveDraft.disputeId===dispute.id);
}

/**
 * Which result statuses may be offered a Reverse control.
 *
 * lib/incentive-engine.ts reverseIncentiveResult() reads `WHERE id=? AND status='approved'` and otherwise
 * throws "Approved incentive result is required for reversal". That rule is the right one: a reversal claws
 * money back out of an APPROVED amount (it is capped at `approved_amount` minus prior reversals, and it
 * posts a payroll deduction), so there is nothing to reverse on a `calculated` result - the correct action
 * there is dispute or adjust, both of which this screen already offers. The UI offered Reverse on
 * `calculated` too, so that button could only ever return the engine's refusal. The UI is the side that was
 * wrong, and it is the side narrowed here.
 */
export const REVERSIBLE_RESULT_STATUSES=["approved"];
export function canReverseResult(status:string){return REVERSIBLE_RESULT_STATUSES.includes(status);}

/**
 * Which result statuses may be offered an Adjust control.
 *
 * The documented remedy for a WRONG `calculated` amount is an adjustment: lib/incentive-engine.ts
 * addIncentiveAdjustment() records a signed correction, approveIncentiveAdjustment() requires a SECOND
 * person to approve it ("Adjustment requester cannot approve their own change"), and
 * approveIncentiveResult() then folds the approved adjustments into the approved amount. That remedy
 * was reachable from NO screen: this page only ever posted approve_result, dispute, resolve_dispute and
 * reverse, so the only ways to change a wrong calculated figure were dispute-then-hold (which parks the
 * money instead of correcting it) or approve-then-reverse (which books an earning the employee was
 * never owed and then claws it back through their payslip). Both are worse than the control the engine
 * already had, and the API route already accepted both actions.
 *
 * The engine's own rule is the boundary: addIncentiveAdjustment refuses a result whose status is
 * `approved` or `reversed` ("Finalized incentive cannot be silently adjusted"), so Adjust is offered for
 * exactly the statuses it accepts - executed status by status against the real engine in
 * tests/people-money-governed-refusals-and-controls.test.mjs, the way REVERSIBLE_RESULT_STATUSES is.
 */
export const ADJUSTABLE_RESULT_STATUSES=["calculated","held","disputed"];
export function canAdjustResult(status:string){return ADJUSTABLE_RESULT_STATUSES.includes(status);}

/** Reversals already recorded against a result, from the directory's own history. */
export function reversalsForResult(reversals:Reversal[]|undefined,resultId:string){
  return (reversals??[]).filter(row=>row&&row.result_id===resultId);
}
/** Adjustments recorded against a result; a pending one still needs a second approver. */
export function adjustmentsForResult(adjustments:Adjustment[]|undefined,resultId:string){
  return (adjustments??[]).filter(row=>row&&row.result_id===resultId);
}
/**
 * How much of an approved incentive has gone back, and how much is still reversible.
 *
 * The engine caps a reversal at `approved_amount` minus prior approved reversals and refuses anything
 * outside that with "Reversal amount must be positive and cannot exceed the remaining approved
 * incentive". The screen showed NEITHER number: after a Rs200 partial reversal of a Rs550 approved
 * result the card still read "Calculated: Rs550 - Approved: Rs550" with a live Reverse button, no
 * history, no actor and no date, so the next Rs400 attempt was simply refused against a balance the
 * operator had never been shown. The directory now carries `reversed_amount`/`remaining_reversible`;
 * this falls back to summing the visible approved reversals so an older payload still cannot display a
 * figure that contradicts the rule the engine enforces.
 */
export function clawbackSummary(result:Result,reversals:Reversal[]|undefined){
  const rows=reversalsForResult(reversals,result.id);
  const approved=Number(result.approved_amount||0);
  const reversed=result.reversed_amount!=null
    ?Number(result.reversed_amount)
    :Math.round(rows.filter(row=>row.status==="approved").reduce((sum,row)=>sum+Number(row.amount||0),0)*100)/100;
  const remaining=result.remaining_reversible!=null?Number(result.remaining_reversible):Math.round(Math.max(0,approved-reversed)*100)/100;
  const count=result.reversal_count!=null?Number(result.reversal_count):rows.length;
  return{rows,approved,reversed,remaining,count,known:reversed>0||rows.length>0};
}

export function IncentiveResultCard({result:r,dispute,busy,disputeDraft,setDisputeDraft,resolveDraft,setResolveDraft,reverseDraft,setReverseDraft,adjustDraft=null,setAdjustDraft,reversals,adjustments,onApprove,onSubmitDispute,onSubmitResolve,onSubmitReverse,onSubmitAdjust,onApproveAdjustment}:{
  result:Result;dispute:Dispute|undefined;busy:boolean;
  disputeDraft:DisputeDraft|null;setDisputeDraft:(value:DisputeDraft|null)=>void;
  resolveDraft:ResolveDraft|null;setResolveDraft:(value:ResolveDraft|null|((current:ResolveDraft|null)=>ResolveDraft|null))=>void;
  reverseDraft:ReverseDraft|null;setReverseDraft:(value:ReverseDraft|null)=>void;
  adjustDraft?:AdjustDraft|null;setAdjustDraft?:(value:AdjustDraft|null)=>void;
  reversals?:Reversal[];adjustments?:Adjustment[];
  onApprove:(resultId:string)=>void;onSubmitDispute:()=>void;onSubmitResolve:()=>void;onSubmitReverse:()=>void;
  onSubmitAdjust?:()=>void;onApproveAdjustment?:(adjustmentId:string)=>void;
}){
  const clawback=clawbackSummary(r,reversals);
  const adjustmentRows=adjustmentsForResult(adjustments,r.id);
  return <article style={{border:"1px solid #ddd",borderRadius:10,padding:12}}>
    <b>{r.employee_email} · {r.status}</b>
    <div>{r.scheme_code} v{r.version} · {day(r.period_start)} → {day(r.period_end)}</div>
    <div>Metric: {r.metric_value} · Calculated: ₹{rupees(r.calculated_amount)} · Approved: ₹{rupees(r.approved_amount)}</div>
    {clawback.known
      ?<div style={{color:"#a35"}}>Clawed back: ₹{rupees(clawback.reversed)} across {clawback.count} reversal{clawback.count===1?"":"s"} · Still reversible: ₹{rupees(clawback.remaining)}</div>
      :r.status==="reversed"?<div style={{color:"#a35"}}>Marked reversed, but no reversal record is on file for this result.</div>:null}
    <code>{r.id}</code>
    <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
      {r.status==="calculated"&&<button disabled={busy} onClick={()=>onApprove(r.id)}>{busy?"Working…":"Approve"}</button>}
      {["calculated","held"].includes(r.status)&&<button disabled={busy} onClick={()=>setDisputeDraft({resultId:r.id,reason:""})}>Open dispute</button>}
      {dispute&&<button disabled={busy} onClick={()=>setResolveDraft({disputeId:dispute.id,resolutionNote:"",release:false})}>Resolve dispute</button>}
      {canAdjustResult(r.status)&&<button disabled={busy} onClick={()=>setAdjustDraft?.({resultId:r.id,amount:"",reason:""})}>Adjust</button>}
      {canReverseResult(r.status)&&<button disabled={busy} onClick={()=>setReverseDraft({resultId:r.id,amount:"",reason:""})}>Reverse</button>}
    </div>
    {dispute&&<p style={{fontSize:12,color:"#a35"}}>Open dispute: {dispute.reason}</p>}
    {disputeDraft?.resultId===r.id&&<div style={{marginTop:8,display:"grid",gap:6}}>
      <label>Dispute reason<input style={{display:"block",width:"100%",padding:8}} value={disputeDraft.reason} onChange={e=>setDisputeDraft({...disputeDraft,reason:e.target.value})}/></label>
      <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>onSubmitDispute()}>Submit dispute</button><button disabled={busy} onClick={()=>setDisputeDraft(null)}>Cancel</button></div>
    </div>}
    {resolveFormOpen(resolveDraft,dispute)&&<div style={{marginTop:8,display:"grid",gap:6}}>
      <label>Resolution note<input style={{display:"block",width:"100%",padding:8}} value={resolveDraft?.resolutionNote??""} onChange={e=>setResolveDraft(current=>current?{...current,resolutionNote:e.target.value}:current)}/></label>
      <label><input type="checkbox" checked={resolveDraft?.release??false} onChange={e=>setResolveDraft(current=>current?{...current,release:e.target.checked}:current)}/> Release for payment (unchecked holds the result)</label>
      <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>onSubmitResolve()}>Submit resolution</button><button disabled={busy} onClick={()=>setResolveDraft(null)}>Cancel</button></div>
    </div>}
    {adjustDraft?.resultId===r.id&&<div style={{marginTop:8,display:"grid",gap:6}}>
      <p style={{fontSize:12,color:"#666",margin:0}}>An adjustment corrects a wrong calculated amount before approval. It is recorded as a signed correction and only counts once a second person approves it - the engine refuses a requester who approves their own change.</p>
      <label>Adjustment amount (may be negative, never zero)<input style={{display:"block",width:"100%",padding:8}} type="number" value={adjustDraft.amount} onChange={e=>setAdjustDraft?.({...adjustDraft,amount:e.target.value})}/></label>
      <label>Adjustment reason (at least 8 characters)<input style={{display:"block",width:"100%",padding:8}} value={adjustDraft.reason} onChange={e=>setAdjustDraft?.({...adjustDraft,reason:e.target.value})}/></label>
      <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>onSubmitAdjust?.()}>Submit adjustment</button><button disabled={busy} onClick={()=>setAdjustDraft?.(null)}>Cancel</button></div>
    </div>}
    {reverseDraft?.resultId===r.id&&<div style={{marginTop:8,display:"grid",gap:6}}>
      <p style={{fontSize:12,color:"#666",margin:0}}>Still reversible on this result: ₹{rupees(clawback.remaining)} of an approved ₹{rupees(clawback.approved)}. A larger amount is refused.</p>
      <label>Reversal amount (blank = the remaining ₹{rupees(clawback.remaining)})<input style={{display:"block",width:"100%",padding:8}} type="number" value={reverseDraft.amount} onChange={e=>setReverseDraft({...reverseDraft,amount:e.target.value})}/></label>
      <label>Reversal reason<input style={{display:"block",width:"100%",padding:8}} value={reverseDraft.reason} onChange={e=>setReverseDraft({...reverseDraft,reason:e.target.value})}/></label>
      <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>onSubmitReverse()}>Submit reversal</button><button disabled={busy} onClick={()=>setReverseDraft(null)}>Cancel</button></div>
    </div>}
    {clawback.rows.length>0&&<div style={{marginTop:8}}>
      <b style={{fontSize:13}}>Clawback history</b>
      <ul style={{margin:"4px 0 0",paddingLeft:18,fontSize:12}}>
        {clawback.rows.map(row=><li key={row.id}>₹{rupees(row.amount)} · {row.status} · effective {day(row.effective_at)} · by {row.actor_id} · recorded {day(row.created_at)} · {row.reason} <code>{row.id}</code></li>)}
      </ul>
    </div>}
    {adjustmentRows.length>0&&<div style={{marginTop:8}}>
      <b style={{fontSize:13}}>Adjustments</b>
      <ul style={{margin:"4px 0 0",paddingLeft:18,fontSize:12}}>
        {adjustmentRows.map(row=><li key={row.id}>₹{rupees(row.amount)} · {row.status} · requested by {row.requested_by} on {day(row.requested_at)}{row.approved_by?` · approved by ${row.approved_by} on ${row.approved_at?day(row.approved_at):"—"}`:""} · {row.reason} <code>{row.id}</code>
          {row.status==="pending"&&<> <button disabled={busy} onClick={()=>onApproveAdjustment?.(row.id)}>Approve adjustment</button></>}
        </li>)}
      </ul>
    </div>}
  </article>;
}

export default function IncentivesPage(){
  const[data,setData]=useState<Payload|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  const[busyId,setBusyId]=useState<string|null>(null);
  const[disputeDraft,setDisputeDraft]=useState<DisputeDraft|null>(null);
  const[resolveDraft,setResolveDraft]=useState<ResolveDraft|null>(null);
  const[reverseDraft,setReverseDraft]=useState<ReverseDraft|null>(null);
  const[adjustDraft,setAdjustDraft]=useState<AdjustDraft|null>(null);
  const[actionError,setActionError]=useState("");

  const refresh=async()=>{try{setData(await loadPayload());setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}};
  useEffect(()=>{let active=true;void loadPayload().then(x=>{if(active){setData(x);setError("");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);

  async function post(payload:Record<string,unknown>){
    const response=await fetch("/api/incentives",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    const body=await response.json() as {error?:string};
    if(!response.ok)throw new Error(body.error||"Incentive action failed");
  }

  async function approveResult(resultId:string){
    setBusyId(resultId);setActionError("");
    try{await post({action:"approve_result",resultId});await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }
  async function submitDispute(){
    if(!disputeDraft)return;
    if(disputeDraft.reason.trim().length<8){setActionError("Dispute reason must be at least 8 characters");return;}
    setBusyId(disputeDraft.resultId);setActionError("");
    try{await post({action:"dispute",resultId:disputeDraft.resultId,reason:disputeDraft.reason.trim()});setDisputeDraft(null);await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }
  async function submitResolve(){
    if(!resolveDraft)return;
    if(resolveDraft.resolutionNote.trim().length<8){setActionError("Resolution note must be at least 8 characters");return;}
    setBusyId(resolveDraft.disputeId);setActionError("");
    try{await post({action:"resolve_dispute",disputeId:resolveDraft.disputeId,resolutionNote:resolveDraft.resolutionNote.trim(),release:resolveDraft.release});setResolveDraft(null);await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }
  async function submitReverse(){
    if(!reverseDraft)return;
    if(reverseDraft.reason.trim().length<8){setActionError("Reversal reason must be at least 8 characters");return;}
    setBusyId(reverseDraft.resultId);setActionError("");
    try{await post({action:"reverse",resultId:reverseDraft.resultId,amount:reverseDraft.amount.trim()?Number(reverseDraft.amount):null,reason:reverseDraft.reason.trim(),effectiveAt:Date.now()});setReverseDraft(null);await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }
  // The documented remedy for a wrong `calculated` amount, finally reachable from the screen. The
  // engine owns the rules (non-zero amount, an 8-character reason, never on a finalized result, and a
  // second approver); these two checks only save a round trip on the two obvious cases.
  async function submitAdjust(){
    if(!adjustDraft)return;
    const amount=Number(adjustDraft.amount);
    if(!adjustDraft.amount.trim()||!Number.isFinite(amount)||amount===0){setActionError("Adjustment amount must be a non-zero number");return;}
    if(adjustDraft.reason.trim().length<8){setActionError("Adjustment reason must be at least 8 characters");return;}
    setBusyId(adjustDraft.resultId);setActionError("");
    try{await post({action:"adjust",resultId:adjustDraft.resultId,amount,reason:adjustDraft.reason.trim()});setAdjustDraft(null);await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }
  async function approveAdjustment(adjustmentId:string){
    setBusyId(adjustmentId);setActionError("");
    try{await post({action:"approve_adjustment",adjustmentId});await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }

  const disputeFor=(resultId:string)=>data?.disputes.find(d=>d.result_id===resultId);

  return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}>
    <p><Link href="/team/people">← People</Link></p>
    <p style={{fontWeight:800,letterSpacing:1}}>PAWSPACE · PEOPLE · INCENTIVES</p>
    <h1>Governed incentive and bonus management</h1>
    <p>Targets, formulas, caps, quality guardrails and clawbacks are versioned configuration. Pipeline revenue never qualifies as earned incentive. Human approval is required before any result can flow into payroll.</p>
    {error?<p>{error}</p>:null}
    {actionError?<p style={{color:"crimson"}}>{actionError}</p>:null}
    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10,margin:"18px 0"}}>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Scheme versions</small><strong style={{display:"block",fontSize:28}}>{data?.schemes.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Incentive results</small><strong style={{display:"block",fontSize:28}}>{data?.results.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Open disputes</small><strong style={{display:"block",fontSize:28}}>{data?.disputes.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Clawbacks recorded</small><strong style={{display:"block",fontSize:28}}>{data?.reversals?.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Payroll bridge</small><strong style={{display:"block",fontSize:20}}>{data?.truth.payrollInclusionOneTime?"ONE-TIME LINKED":"NOT READY"}</strong></article>
    </section>
    <h2>Schemes</h2>
    <p style={{color:"#666",fontSize:13}}>Creating or activating a scheme requires real formula, target and guardrail values from People Ops - not shown here to avoid fabricating defaults for a business decision. Use the incentives API directly with a reviewed scheme configuration.</p>
    <section style={{display:"grid",gap:8}}>{data?.schemes.map(s=><article key={s.id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{s.scheme_code} v{s.version} · {s.status}</b><div>{s.role_code} · {s.team_code} · {day(s.effective_from)}{s.effective_until?` → ${day(s.effective_until)}`:""}</div></article>)}</section>
    <h2>Results</h2>
    <section style={{display:"grid",gap:8}}>{data?.results.map(r=>{
      const dispute=disputeFor(r.id);
      const adjustmentIds=adjustmentsForResult(data?.adjustments,r.id).map(a=>a.id);
      const busy=busyId===r.id||busyId===dispute?.id||(busyId!=null&&adjustmentIds.includes(busyId));
      return <IncentiveResultCard key={r.id} result={r} dispute={dispute} busy={busy}
        disputeDraft={disputeDraft} setDisputeDraft={setDisputeDraft}
        resolveDraft={resolveDraft} setResolveDraft={setResolveDraft}
        reverseDraft={reverseDraft} setReverseDraft={setReverseDraft}
        adjustDraft={adjustDraft} setAdjustDraft={setAdjustDraft}
        reversals={data?.reversals} adjustments={data?.adjustments}
        onApprove={resultId=>void approveResult(resultId)} onSubmitDispute={()=>void submitDispute()}
        onSubmitResolve={()=>void submitResolve()} onSubmitReverse={()=>void submitReverse()}
        onSubmitAdjust={()=>void submitAdjust()} onApproveAdjustment={adjustmentId=>void approveAdjustment(adjustmentId)}/>;
    })}</section>
    {loading?<p>Loading incentive governance…</p>:null}
    <footer style={{marginTop:24}}><b>Pipeline revenue eligible:</b> NO · <b>Automatic payroll inclusion before approval:</b> NO · <b>Production ready:</b> NO</footer>
  </main>;
}
