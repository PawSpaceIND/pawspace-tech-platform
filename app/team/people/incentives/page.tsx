"use client";
import{useEffect,useState}from"react";
import Link from"next/link";
type Scheme={id:string;scheme_code:string;version:number;status:string;role_code:string;team_code:string;effective_from:number;effective_until?:number|null};
type Result={id:string;employee_id:string;employee_email:string;metric_value:number;calculated_amount:number;approved_amount:number;status:string;scheme_code:string;version:number;period_start:number;period_end:number};
type Dispute={id:string;result_id:string;status:string;reason:string;opened_by:string;opened_at:number};
type Payload={schemes:Scheme[];results:Result[];disputes:Dispute[];truth:{formulaValuesConfiguredNotHardcoded:boolean;pipelineRevenueEligible:boolean;humanApprovalRequired:boolean;payrollInclusionOneTime:boolean;productionReady:boolean}};
async function loadPayload(){const r=await fetch("/api/incentives",{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"Incentive load failed");return p.data as Payload;}
const day=(v:number)=>new Date(v).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"});

export default function IncentivesPage(){
  const[data,setData]=useState<Payload|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  const[busyId,setBusyId]=useState<string|null>(null);
  const[disputeDraft,setDisputeDraft]=useState<{resultId:string;reason:string}|null>(null);
  const[resolveDraft,setResolveDraft]=useState<{disputeId:string;resolutionNote:string;release:boolean}|null>(null);
  const[reverseDraft,setReverseDraft]=useState<{resultId:string;amount:string;reason:string}|null>(null);
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
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Payroll bridge</small><strong style={{display:"block",fontSize:20}}>{data?.truth.payrollInclusionOneTime?"ONE-TIME LINKED":"NOT READY"}</strong></article>
    </section>
    <h2>Schemes</h2>
    <p style={{color:"#666",fontSize:13}}>Creating or activating a scheme requires real formula, target and guardrail values from People Ops - not shown here to avoid fabricating defaults for a business decision. Use the incentives API directly with a reviewed scheme configuration.</p>
    <section style={{display:"grid",gap:8}}>{data?.schemes.map(s=><article key={s.id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{s.scheme_code} v{s.version} · {s.status}</b><div>{s.role_code} · {s.team_code} · {day(s.effective_from)}{s.effective_until?` → ${day(s.effective_until)}`:""}</div></article>)}</section>
    <h2>Results</h2>
    <section style={{display:"grid",gap:8}}>{data?.results.map(r=>{
      const dispute=disputeFor(r.id),busy=busyId===r.id||busyId===dispute?.id;
      return <article key={r.id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}>
        <b>{r.employee_email} · {r.status}</b>
        <div>{r.scheme_code} v{r.version} · {day(r.period_start)} → {day(r.period_end)}</div>
        <div>Metric: {r.metric_value} · Calculated: ₹{Number(r.calculated_amount||0).toLocaleString("en-IN")} · Approved: ₹{Number(r.approved_amount||0).toLocaleString("en-IN")}</div>
        <code>{r.id}</code>
        <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
          {r.status==="calculated"&&<button disabled={busy} onClick={()=>void approveResult(r.id)}>{busy?"Working…":"Approve"}</button>}
          {["calculated","held"].includes(r.status)&&<button disabled={busy} onClick={()=>setDisputeDraft({resultId:r.id,reason:""})}>Open dispute</button>}
          {dispute&&<button disabled={busy} onClick={()=>setResolveDraft({disputeId:dispute.id,resolutionNote:"",release:false})}>Resolve dispute</button>}
          {["approved","calculated"].includes(r.status)&&<button disabled={busy} onClick={()=>setReverseDraft({resultId:r.id,amount:"",reason:""})}>Reverse</button>}
        </div>
        {dispute&&<p style={{fontSize:12,color:"#a35"}}>Open dispute: {dispute.reason}</p>}
        {disputeDraft?.resultId===r.id&&<div style={{marginTop:8,display:"grid",gap:6}}>
          <label>Dispute reason<input style={{display:"block",width:"100%",padding:8}} value={disputeDraft.reason} onChange={e=>setDisputeDraft({...disputeDraft,reason:e.target.value})}/></label>
          <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>void submitDispute()}>Submit dispute</button><button disabled={busy} onClick={()=>setDisputeDraft(null)}>Cancel</button></div>
        </div>}
        {resolveDraft?.disputeId===dispute?.id&&<div style={{marginTop:8,display:"grid",gap:6}}>
          <label>Resolution note<input style={{display:"block",width:"100%",padding:8}} value={resolveDraft?.resolutionNote??""} onChange={e=>setResolveDraft(current=>current?{...current,resolutionNote:e.target.value}:current)}/></label>
          <label><input type="checkbox" checked={resolveDraft?.release??false} onChange={e=>setResolveDraft(current=>current?{...current,release:e.target.checked}:current)}/> Release for payment (unchecked holds the result)</label>
          <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>void submitResolve()}>Submit resolution</button><button disabled={busy} onClick={()=>setResolveDraft(null)}>Cancel</button></div>
        </div>}
        {reverseDraft?.resultId===r.id&&<div style={{marginTop:8,display:"grid",gap:6}}>
          <label>Reversal amount (blank = full amount)<input style={{display:"block",width:"100%",padding:8}} type="number" value={reverseDraft.amount} onChange={e=>setReverseDraft({...reverseDraft,amount:e.target.value})}/></label>
          <label>Reversal reason<input style={{display:"block",width:"100%",padding:8}} value={reverseDraft.reason} onChange={e=>setReverseDraft({...reverseDraft,reason:e.target.value})}/></label>
          <div style={{display:"flex",gap:8}}><button disabled={busy} onClick={()=>void submitReverse()}>Submit reversal</button><button disabled={busy} onClick={()=>setReverseDraft(null)}>Cancel</button></div>
        </div>}
      </article>;
    })}</section>
    {loading?<p>Loading incentive governance…</p>:null}
    <footer style={{marginTop:24}}><b>Pipeline revenue eligible:</b> NO · <b>Automatic payroll inclusion before approval:</b> NO · <b>Production ready:</b> NO</footer>
  </main>;
}
