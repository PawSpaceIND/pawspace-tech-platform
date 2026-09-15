"use client";
import{useEffect,useState}from"react";
import Link from"next/link";
import{ReadGate,ReadRefusedNotice}from"../../../components/refused-surface";
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
type GuardrailDraft={metric:string;operator:string;threshold:string;action:string;multiplier:string};
type SchemeDraft={schemeCode:string;roleCode:string;teamCode:string;effectiveFrom:string;effectiveUntil:string;metric:string;payoutType:string;target:string;payoutValue:string;cap:string;guardrails:GuardrailDraft[]};
type ActivateDraft={schemeId:string;approvalReference:string};
type CalculateDraft={schemeId:string;schemeCode:string;periodStart:string;periodEnd:string};
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

/**
 * The scheme lifecycle, finally reachable from the screen that owns it.
 *
 * app/api/incentives/route.ts has always accepted `save_scheme`, `activate_scheme` and `calculate`,
 * and NO .tsx in the product posted any of them. That is not a reporting gap: without a scheme there
 * is no `incentive_scheme_versions` row, without an ACTIVE scheme `calculateIncentivePeriod` refuses
 * with "Active incentive scheme is required", and with no period there is no result to approve,
 * dispute, adjust or reverse - so every control this page already had was unreachable too. The whole
 * engine was dark, and the previous copy on this screen said so out loud: "Use the incentives API
 * directly with a reviewed scheme configuration."
 *
 * All three are HUMAN actions, not machine ones, and that is why they get controls rather than a
 * scheduler: worker/index.ts's `scheduled()` handler calls none of them; `save_scheme` needs a
 * target, a payout formula and guardrails that are a People Ops decision; `activate_scheme` needs an
 * `approvalReference` that names a real approval; and `calculate` records `calculated_by`, which is
 * the identity the engine then refuses to let approve its own result.
 *
 * NOTHING here invents a default. Every field starts empty and the draft is REFUSED until the
 * operator supplies a real value - which was the original objection to putting a form here, and is
 * answered by refusing rather than by pre-filling a number nobody approved.
 */
export const INCENTIVE_METRICS=["net_collected_revenue","collected_revenue","booking_conversions","first_response_rate","qualified_leads","meaningful_actions"] as const;
export const INCENTIVE_PAYOUT_TYPES=["flat_on_target","amount_per_unit_above_target","percent_of_revenue_above_target"] as const;
export const INCENTIVE_REVENUE_METRICS=["net_collected_revenue","collected_revenue"] as const;
export const GUARDRAIL_METRICS=["refunds","cx_escalations","opt_out_or_consent_blocks","data_quality_blocks","first_response_breached"] as const;
export const GUARDRAIL_OPERATORS=["gt","gte"] as const;
export const GUARDRAIL_ACTIONS=["hold","zero","multiplier"] as const;

export const EMPTY_GUARDRAIL_DRAFT:GuardrailDraft={metric:"",operator:"gt",threshold:"",action:"",multiplier:""};
export const EMPTY_SCHEME_DRAFT:SchemeDraft={schemeCode:"",roleCode:"",teamCode:"",effectiveFrom:"",effectiveUntil:"",metric:"",payoutType:"",target:"",payoutValue:"",cap:"",guardrails:[]};

/** A yyyy-mm-dd field as the epoch milliseconds the engine stores, or null when it is not a date. */
export function dayValue(value:string){
  const text=String(value??"").trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;
  const parsed=Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed)?parsed:null;
}
const numberValue=(value:string)=>{const text=String(value??"").trim();if(!text)return null;const parsed=Number(text);return Number.isFinite(parsed)?parsed:null;};

type Built<T>={ok:true;body:T}|{ok:false;error:string};

/** The body the Create-scheme form posts, or the reason it cannot be posted yet. */
export function schemeDraftPayload(draft:SchemeDraft):Built<Record<string,unknown>>{
  const schemeCode=draft.schemeCode.trim(),roleCode=draft.roleCode.trim(),teamCode=draft.teamCode.trim();
  if(!schemeCode||!roleCode||!teamCode)return{ok:false,error:"Scheme code, role code and team code are required"};
  const effectiveFrom=dayValue(draft.effectiveFrom);
  if(effectiveFrom===null)return{ok:false,error:"An effective-from date is required"};
  const effectiveUntil=draft.effectiveUntil.trim()?dayValue(draft.effectiveUntil):null;
  if(draft.effectiveUntil.trim()&&effectiveUntil===null)return{ok:false,error:"The effective-until date is not a date"};
  if(effectiveUntil!==null&&effectiveUntil<=effectiveFrom)return{ok:false,error:"Scheme end date must follow start date"};
  if(!(INCENTIVE_METRICS as readonly string[]).includes(draft.metric))return{ok:false,error:"Choose the metric this scheme pays on"};
  if(!(INCENTIVE_PAYOUT_TYPES as readonly string[]).includes(draft.payoutType))return{ok:false,error:"Choose how the payout is calculated"};
  if(draft.payoutType==="percent_of_revenue_above_target"&&!(INCENTIVE_REVENUE_METRICS as readonly string[]).includes(draft.metric))
    return{ok:false,error:"Revenue percentage formula requires a canonical revenue metric"};
  const target=numberValue(draft.target),payoutValue=numberValue(draft.payoutValue);
  if(target===null||target<0)return{ok:false,error:"An explicit non-negative target is required"};
  if(payoutValue===null||payoutValue<0)return{ok:false,error:"An explicit non-negative payout value is required"};
  const cap=draft.cap.trim()?numberValue(draft.cap):null;
  if(draft.cap.trim()&&(cap===null||cap<0))return{ok:false,error:"A cap must be an explicit non-negative amount"};
  const qualityRules:Record<string,unknown>[]=[];
  for(const rule of draft.guardrails){
    if(!(GUARDRAIL_METRICS as readonly string[]).includes(rule.metric))return{ok:false,error:"Choose a metric for every quality guardrail"};
    if(!(GUARDRAIL_OPERATORS as readonly string[]).includes(rule.operator))return{ok:false,error:"Choose an operator for every quality guardrail"};
    const threshold=numberValue(rule.threshold);
    if(threshold===null||threshold<0)return{ok:false,error:"Every quality guardrail needs an explicit non-negative threshold"};
    if(!(GUARDRAIL_ACTIONS as readonly string[]).includes(rule.action))return{ok:false,error:"Choose what every quality guardrail does when it trips"};
    const multiplier=rule.action==="multiplier"?numberValue(rule.multiplier):null;
    if(rule.action==="multiplier"&&(multiplier===null||multiplier<0||multiplier>1))return{ok:false,error:"Quality multiplier must be explicitly configured between 0 and 1"};
    qualityRules.push({metric:rule.metric,operator:rule.operator,threshold,action:rule.action,...(rule.action==="multiplier"?{multiplier}:{})});
  }
  return{ok:true,body:{action:"save_scheme",schemeCode,roleCode,teamCode,effectiveFrom,effectiveUntil,
    formula:{metric:draft.metric,target,payoutType:draft.payoutType,payoutValue,...(cap===null?{}:{cap})},qualityRules}};
}

/** Activation carries the approval that authorised the scheme; the engine refuses anything shorter. */
export function activateSchemePayload(draft:ActivateDraft):Built<Record<string,unknown>>{
  const approvalReference=draft.approvalReference.trim();
  if(!draft.schemeId)return{ok:false,error:"A scheme is required"};
  if(approvalReference.length<4)return{ok:false,error:"Incentive scheme approval reference is required"};
  return{ok:true,body:{action:"activate_scheme",schemeId:draft.schemeId,approvalReference}};
}

/**
 * The idempotency key is DERIVED, not typed.
 *
 * `employee_incentive_periods.idempotency_key` is UNIQUE and the engine returns the existing period
 * for a repeat, so a key derived from the scheme and the period makes a double-clicked Calculate
 * return the same period instead of a second one against the same money. A free-text key would let
 * two clicks produce two periods, and both would then be approvable.
 */
export function incentivePeriodKey(schemeCode:string,periodStart:number,periodEnd:number){
  return `${schemeCode}:${periodStart}:${periodEnd}`;
}

export function calculatePeriodPayload(draft:CalculateDraft):Built<Record<string,unknown>>{
  if(!draft.schemeId)return{ok:false,error:"A scheme is required"};
  const periodStart=dayValue(draft.periodStart),periodEnd=dayValue(draft.periodEnd);
  if(periodStart===null||periodEnd===null)return{ok:false,error:"A period start and end date are required"};
  if(periodEnd<=periodStart)return{ok:false,error:"The period end must follow the period start"};
  return{ok:true,body:{action:"calculate",schemeId:draft.schemeId,periodStart,periodEnd,idempotencyKey:incentivePeriodKey(draft.schemeCode,periodStart,periodEnd)}};
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
  const[schemeDraft,setSchemeDraft]=useState<SchemeDraft|null>(null);
  const[activateDraft,setActivateDraft]=useState<ActivateDraft|null>(null);
  const[calculateDraft,setCalculateDraft]=useState<CalculateDraft|null>(null);
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

  /* The three scheme-lifecycle controls. Each one builds its body with the exported helper above, so
   * the payload a test proves against the real route is the payload the button actually posts, and
   * each one surfaces the route's own refusal text rather than a screen-invented message. */
  async function submitScheme(){
    if(!schemeDraft)return;
    const built=schemeDraftPayload(schemeDraft);
    if(!built.ok){setActionError(built.error);return;}
    setBusyId("scheme:new");setActionError("");
    try{await post(built.body);setSchemeDraft(null);await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }
  async function submitActivate(){
    if(!activateDraft)return;
    const built=activateSchemePayload(activateDraft);
    if(!built.ok){setActionError(built.error);return;}
    setBusyId(activateDraft.schemeId);setActionError("");
    try{await post(built.body);setActivateDraft(null);await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }
  async function submitCalculate(){
    if(!calculateDraft)return;
    const built=calculatePeriodPayload(calculateDraft);
    if(!built.ok){setActionError(built.error);return;}
    setBusyId(calculateDraft.schemeId);setActionError("");
    try{await post(built.body);setCalculateDraft(null);await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusyId(null);}
  }
  const setGuardrail=(index:number,patch:Partial<GuardrailDraft>)=>setSchemeDraft(current=>current?{...current,guardrails:current.guardrails.map((rule,i)=>i===index?{...rule,...patch}:rule)}:current);

  const disputeFor=(resultId:string)=>data?.disputes.find(d=>d.result_id===resultId);

  return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}>
    <p><Link href="/team/people">← People</Link></p>
    <p style={{fontWeight:800,letterSpacing:1}}>PAWSPACE · PEOPLE · INCENTIVES</p>
    <h1>Governed incentive and bonus management</h1>
    <p>Targets, formulas, caps, quality guardrails and clawbacks are versioned configuration. Pipeline revenue never qualifies as earned incentive. Human approval is required before any result can flow into payroll.</p>
    {/* R3-G / F6: "Scheme versions 0 · Incentive results 0 · Open disputes 0 · Clawbacks recorded 0"
        rendered from a null payload beside the refusal, and every form below it rendered too - a set
        of governed write surfaces offered on top of a read that was refused (F7). */}
    <ReadRefusedNotice error={error} what="incentive governance" />
    {actionError?<p style={{color:"crimson"}}>{actionError}</p>:null}
    <ReadGate error={error}>
    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10,margin:"18px 0"}}>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Scheme versions</small><strong style={{display:"block",fontSize:28}}>{data?.schemes.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Incentive results</small><strong style={{display:"block",fontSize:28}}>{data?.results.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Open disputes</small><strong style={{display:"block",fontSize:28}}>{data?.disputes.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Clawbacks recorded</small><strong style={{display:"block",fontSize:28}}>{data?.reversals?.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Payroll bridge</small><strong style={{display:"block",fontSize:20}}>{data?.truth.payrollInclusionOneTime?"ONE-TIME LINKED":"NOT READY"}</strong></article>
    </section>
    <h2>Schemes</h2>
    <p style={{color:"#666",fontSize:13}}>A scheme version is the configuration the engine pays from: the metric, the target, the payout formula, an optional cap and the quality guardrails. Nothing is pre-filled - every value is a People Ops decision and the form refuses until you supply it. A new version is saved as a <b>draft</b>; activating it needs the approval reference that authorised it, and only an active version can be calculated.</p>
    <div style={{margin:"8px 0"}}>
      <button disabled={busyId!=null} onClick={()=>setSchemeDraft(schemeDraft?null:{...EMPTY_SCHEME_DRAFT})}>{schemeDraft?"Cancel new scheme":"New scheme version"}</button>
    </div>
    {schemeDraft&&<section style={{border:"1px solid #ccc",borderRadius:10,padding:14,display:"grid",gap:8,marginBottom:12}}>
      <b>New incentive scheme version</b>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:8}}>
        <label>Scheme code<input style={{display:"block",width:"100%",padding:8}} value={schemeDraft.schemeCode} onChange={e=>setSchemeDraft({...schemeDraft,schemeCode:e.target.value})}/></label>
        <label>Role code<input style={{display:"block",width:"100%",padding:8}} value={schemeDraft.roleCode} onChange={e=>setSchemeDraft({...schemeDraft,roleCode:e.target.value})}/></label>
        <label>Team code<input style={{display:"block",width:"100%",padding:8}} value={schemeDraft.teamCode} onChange={e=>setSchemeDraft({...schemeDraft,teamCode:e.target.value})}/></label>
        <label>Effective from<input type="date" style={{display:"block",width:"100%",padding:8}} value={schemeDraft.effectiveFrom} onChange={e=>setSchemeDraft({...schemeDraft,effectiveFrom:e.target.value})}/></label>
        <label>Effective until (optional)<input type="date" style={{display:"block",width:"100%",padding:8}} value={schemeDraft.effectiveUntil} onChange={e=>setSchemeDraft({...schemeDraft,effectiveUntil:e.target.value})}/></label>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:8}}>
        <label>Metric<select style={{display:"block",width:"100%",padding:8}} value={schemeDraft.metric} onChange={e=>setSchemeDraft({...schemeDraft,metric:e.target.value})}>
          <option value="">Choose a metric…</option>{INCENTIVE_METRICS.map(m=><option key={m} value={m}>{m}</option>)}</select></label>
        <label>Payout formula<select style={{display:"block",width:"100%",padding:8}} value={schemeDraft.payoutType} onChange={e=>setSchemeDraft({...schemeDraft,payoutType:e.target.value})}>
          <option value="">Choose a formula…</option>{INCENTIVE_PAYOUT_TYPES.map(p=><option key={p} value={p}>{p}</option>)}</select></label>
        <label>Target<input type="number" style={{display:"block",width:"100%",padding:8}} value={schemeDraft.target} onChange={e=>setSchemeDraft({...schemeDraft,target:e.target.value})}/></label>
        <label>Payout value<input type="number" style={{display:"block",width:"100%",padding:8}} value={schemeDraft.payoutValue} onChange={e=>setSchemeDraft({...schemeDraft,payoutValue:e.target.value})}/></label>
        <label>Cap (optional)<input type="number" style={{display:"block",width:"100%",padding:8}} value={schemeDraft.cap} onChange={e=>setSchemeDraft({...schemeDraft,cap:e.target.value})}/></label>
      </div>
      <div>
        <b style={{fontSize:13}}>Quality guardrails</b>
        <p style={{fontSize:12,color:"#666",margin:"2px 0"}}>Optional. A guardrail can hold the result for a human, zero it, or apply an explicitly configured multiplier between 0 and 1.</p>
        {schemeDraft.guardrails.map((rule,index)=><div key={index} style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:6,marginBottom:6}}>
          <select value={rule.metric} onChange={e=>setGuardrail(index,{metric:e.target.value})}><option value="">Guardrail metric…</option>{GUARDRAIL_METRICS.map(m=><option key={m} value={m}>{m}</option>)}</select>
          <select value={rule.operator} onChange={e=>setGuardrail(index,{operator:e.target.value})}>{GUARDRAIL_OPERATORS.map(o=><option key={o} value={o}>{o}</option>)}</select>
          <input type="number" placeholder="threshold" value={rule.threshold} onChange={e=>setGuardrail(index,{threshold:e.target.value})}/>
          <select value={rule.action} onChange={e=>setGuardrail(index,{action:e.target.value})}><option value="">Action…</option>{GUARDRAIL_ACTIONS.map(a=><option key={a} value={a}>{a}</option>)}</select>
          {rule.action==="multiplier"&&<input type="number" placeholder="multiplier 0-1" value={rule.multiplier} onChange={e=>setGuardrail(index,{multiplier:e.target.value})}/>}
          <button onClick={()=>setSchemeDraft({...schemeDraft,guardrails:schemeDraft.guardrails.filter((_,i)=>i!==index)})}>Remove</button>
        </div>)}
        <button onClick={()=>setSchemeDraft({...schemeDraft,guardrails:[...schemeDraft.guardrails,{...EMPTY_GUARDRAIL_DRAFT}]})}>Add guardrail</button>
      </div>
      <div style={{display:"flex",gap:8}}>
        <button disabled={busyId!=null} onClick={()=>void submitScheme()}>{busyId==="scheme:new"?"Saving…":"Save draft scheme"}</button>
        <button disabled={busyId!=null} onClick={()=>setSchemeDraft(null)}>Cancel</button>
      </div>
    </section>}
    <section style={{display:"grid",gap:8}}>{data?.schemes.map(s=>{
      const busy=busyId===s.id;
      return <article key={s.id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}>
        <b>{s.scheme_code} v{s.version} · {s.status}</b>
        <div>{s.role_code} · {s.team_code} · {day(s.effective_from)}{s.effective_until?` → ${day(s.effective_until)}`:""}</div>
        <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
          {s.status==="draft"&&<button disabled={busyId!=null} onClick={()=>setActivateDraft({schemeId:s.id,approvalReference:""})}>Activate</button>}
          {s.status==="active_uat"&&<button disabled={busyId!=null} onClick={()=>setCalculateDraft({schemeId:s.id,schemeCode:s.scheme_code,periodStart:"",periodEnd:""})}>Run calculation</button>}
        </div>
        {activateDraft?.schemeId===s.id&&<div style={{marginTop:8,display:"grid",gap:6}}>
          <label>Approval reference (at least 4 characters)<input style={{display:"block",width:"100%",padding:8}} value={activateDraft.approvalReference} onChange={e=>setActivateDraft({...activateDraft,approvalReference:e.target.value})}/></label>
          <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>void submitActivate()}>{busy?"Working…":"Activate scheme"}</button><button disabled={busy} onClick={()=>setActivateDraft(null)}>Cancel</button></div>
        </div>}
        {calculateDraft?.schemeId===s.id&&<div style={{marginTop:8,display:"grid",gap:6}}>
          <p style={{fontSize:12,color:"#666",margin:0}}>The period must sit inside this scheme version&apos;s validity. Calculating the same period twice returns the same period - it never creates a second one against the same money.</p>
          <label>Period start<input type="date" style={{display:"block",width:"100%",padding:8}} value={calculateDraft.periodStart} onChange={e=>setCalculateDraft({...calculateDraft,periodStart:e.target.value})}/></label>
          <label>Period end<input type="date" style={{display:"block",width:"100%",padding:8}} value={calculateDraft.periodEnd} onChange={e=>setCalculateDraft({...calculateDraft,periodEnd:e.target.value})}/></label>
          <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>void submitCalculate()}>{busy?"Working…":"Calculate period"}</button><button disabled={busy} onClick={()=>setCalculateDraft(null)}>Cancel</button></div>
        </div>}
      </article>;
    })}</section>
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
    </ReadGate>
    {loading&&!error?<p>Loading incentive governance…</p>:null}
    <footer style={{marginTop:24}}><b>Pipeline revenue eligible:</b> NO · <b>Automatic payroll inclusion before approval:</b> NO · <b>Production ready:</b> NO</footer>
  </main>;
}
