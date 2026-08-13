"use client";
import Link from"next/link";
import{useCallback,useEffect,useState}from"react";
import{Badge,Button,PageHeader,StatCard}from"../../components/ui";
import styles from"../team-console.module.css";

type Obligation={code:string;label:string;authority:string;period:string;dueDate:string;kind:string;notes:string;status:"upcoming"|"due_soon"|"overdue"|"filed";daysToDue:number;acknowledgementRef:string|null;amount:number|null};
type ChecklistItem={key:string;label:string;ok:boolean;value:number|string|null;detail:string};
type CloseView={period:string;status:"open"|"ready"|"closed";checklist:ChecklistItem[];revenue:{bookings:number;bookingCount:number;foodOrders:number;foodOrderCount:number;total:number};gst:{outputTax:number;eligibleInputTax:number;netPayable:number;invoiceCount:number};tds:{total:number;sections:Record<string,{base:number;tds:number;deductees:number}>;deposited:boolean;depositDueDate:string};payroll:{runStatus:string|null;employees:number;grossTotal:number};boardApproval:{approved:boolean;approvedBy:string|null};closedBy:string|null;closedAt:number|null};
type TdsRow={section:string;deductee_type:string;deductee_id:string;base_amount:number;rate_pct:number;tds_amount:number;pan_status:string};
type Dashboard={period:string;calendar:Obligation[];close:CloseView;tds:{deductions:TdsRow[];deposit:{amount:number;challan_reference:string}|null;quarterlyReturns:Array<{fy_label:string;quarter:number;form:string;total_tds:number;total_deposited:number;status:string;acknowledgement_ref:string|null}>}};

const money=(value:number|null)=>value==null?"—":`₹${Number(value).toLocaleString("en-IN")}`;
const statusTone=(status:string)=>status==="filed"?"success":status==="overdue"?"danger":status==="due_soon"?"warning":"neutral";

export default function FinanceCompliancePage(){
  const[period,setPeriod]=useState(()=>new Date(Date.now()+330*60_000).toISOString().slice(0,7));
  const[data,setData]=useState<Dashboard|null>(null);
  const[error,setError]=useState("");
  const[notice,setNotice]=useState("");
  const[busy,setBusy]=useState(false);
  const[loading,setLoading]=useState(true);

  const load=useCallback((target:string)=>{
    fetch(`/api/statutory-compliance?period=${encodeURIComponent(target)}`,{cache:"no-store"}).then(r=>r.json()).then(body=>{
      if(body.error)setError(String(body.error));else{setError("");setData(body.data as Dashboard);}
    }).catch(e=>setError(e instanceof Error?e.message:"Unable to load compliance dashboard")).finally(()=>setLoading(false));
  },[]);
  useEffect(()=>{load(period);},[period,load]);
  function changePeriod(next:string){setLoading(true);setPeriod(next);}

  async function act(body:Record<string,unknown>,message:string){
    setBusy(true);setNotice("");
    try{
      const response=await fetch("/api/statutory-compliance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,period})});
      const payload=await response.json() as{error?:string};
      if(!response.ok)throw new Error(payload.error||"Action failed");
      setNotice(message);load(period);
    }catch(problem){setNotice(problem instanceof Error?problem.message:"Action failed");}
    finally{setBusy(false);}
  }

  function recordFiling(code:string){
    const ack=window.prompt(`Government acknowledgement reference for ${code} (${period})?`);
    if(ack)void act({action:code.startsWith("tds_return")?"file_tds_return":"record_filing",obligationCode:code,acknowledgementRef:ack},`${code} recorded as filed`);
  }

  const close=data?.close;
  const overdue=(data?.calendar||[]).filter(item=>item.status==="overdue").length;
  const dueSoon=(data?.calendar||[]).filter(item=>item.status==="due_soon").length;
  const filed=(data?.calendar||[]).filter(item=>item.status==="filed").length;

  return <main className={styles.shell}>
    <PageHeader
      eyebrow="FINANCE · STATUTORY COMPLIANCE & MONTHLY CLOSE"
      title="Filings, TDS and monthly close"
      description="The Indian statutory calendar — GST, TDS, EPF/ESI, Karnataka PT, advance tax and ROC — with monthly board approval, computed from real platform data. Filing itself stays manual: record the government acknowledgement here. Sandbox/UAT: no live money."
      actions={<Badge tone={overdue?"danger":dueSoon?"warning":"success"} dot>{overdue?`${overdue} overdue`:dueSoon?`${dueSoon} due soon`:"nothing overdue"}</Badge>}
    />
    <nav className={styles.nav} aria-label="Team workspaces">
      <Link href="/team">← Team</Link><Link href="/team/people/finance">People finance</Link><Link href="/team/analytics">Analytics</Link>
    </nav>

    {error&&<div className={`${styles.panel} ${styles.panelError}`} role="alert"><b>{error}</b></div>}
    {notice&&<div className={styles.panel} role="status">{notice}</div>}

    <section className={styles.tiles}>
      <StatCard label="Obligations" value={data?.calendar.length??0} meta={data?.period} />
      <StatCard label="Filed" value={filed} />
      <StatCard label="Due soon" value={dueSoon} />
      <StatCard label="Overdue" value={overdue} />
    </section>

    <section className={styles.controls}>
      <label className={styles.field}>Period<input type="month" value={period} onChange={event=>changePeriod(event.target.value)} /></label>
      {loading?<small>Loading…</small>:null}
    </section>

    {data&&<>
    <section className={styles.panel}>
      <h2 style={{marginTop:0}}>Statutory calendar — {data.period}</h2>
      <div style={{display:"grid",gap:6}}>
        {data.calendar.map(item=><article key={`${item.code}:${item.period}`} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr auto",gap:8,alignItems:"center",padding:"8px 0",borderBottom:"1px solid var(--ds-border)",fontSize:14}}>
          <span><b>{item.label}</b><br/><small style={{color:"var(--ds-text-muted)"}}>{item.authority} · {item.notes}</small></span>
          <span>due {item.dueDate}</span>
          <span><Badge tone={statusTone(item.status)}>{item.status.replaceAll("_"," ")}{item.status!=="filed"&&item.daysToDue>=0?` · T-${item.daysToDue}`:""}</Badge></span>
          <span>{item.acknowledgementRef?`ACK ${item.acknowledgementRef}`:"—"}</span>
          <span>{item.status!=="filed"&&item.code!=="board_approval"&&<Button size="sm" variant="secondary" disabled={busy} onClick={()=>recordFiling(item.code)}>Record filing</Button>}</span>
        </article>)}
      </div>
      <p><Button size="sm" disabled={busy} onClick={()=>void act({action:"run_reminders"},"Reminder sweep completed — due obligations raised as finance alerts")}>Run reminder sweep now</Button> <small style={{color:"var(--ds-text-muted)"}}>Also runs automatically every scheduler cycle; T-7 and closer become finance staff alerts, overdue become critical.</small></p>
    </section>

    {close&&<section className={styles.panel}>
      <h2 style={{marginTop:0}}>Monthly close — {close.period} <em style={{fontStyle:"normal",fontSize:13,padding:"2px 10px",borderRadius:12,background:close.status==="closed"?"#dff3e7":close.status==="ready"?"#fff6df":"#f3f4f6"}}>{close.status.toUpperCase()}</em></h2>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:12}}>
        <article><small>Revenue</small><br/><b>{money(close.revenue.total)}</b><br/><small>{close.revenue.bookingCount} bookings · {close.revenue.foodOrderCount} food orders</small></article>
        <article><small>GST output</small><br/><b>{money(close.gst.outputTax)}</b><br/><small>{close.gst.invoiceCount} invoices</small></article>
        <article><small>GSTR-3B net payable</small><br/><b>{money(close.gst.netPayable)}</b><br/><small>after eligible input {money(close.gst.eligibleInputTax)}</small></article>
        <article><small>TDS liability</small><br/><b>{money(close.tds.total)}</b><br/><small>deposit due {close.tds.depositDueDate}</small></article>
        <article><small>Payroll</small><br/><b>{close.payroll.runStatus??"no run"}</b><br/><small>{close.payroll.employees} employees · {money(close.payroll.grossTotal)}</small></article>
      </div>
      <div style={{display:"grid",gap:6}}>
        {close.checklist.map(item=><label key={item.key} style={{display:"grid",gridTemplateColumns:"auto 1fr auto",gap:10,alignItems:"center",padding:"6px 0",borderBottom:"1px solid var(--ds-border)",fontSize:14}}>
          <span aria-hidden style={{color:item.ok?"var(--ds-success-500, #1a7f4b)":"var(--ds-danger-500)"}}>{item.ok?"✓":"✗"}</span>
          <span><b>{item.label}</b><br/><small style={{color:"var(--ds-text-muted)"}}>{item.detail}</small></span>
          <span>{typeof item.value==="number"?money(item.value):item.value??"—"}</span>
        </label>)}
      </div>
      <div style={{display:"flex",gap:10,marginTop:12,flexWrap:"wrap"}}>
        {!close.boardApproval.approved&&<Button size="sm" variant="secondary" disabled={busy} onClick={()=>{const minutes=window.prompt("Board minutes reference (optional)")||undefined;void act({action:"board_approve",minutesReference:minutes},"Board approval recorded");}}>Record board approval</Button>}
        {close.status==="ready"&&<Button size="sm" variant="secondary" disabled={busy} onClick={()=>{if(window.confirm(`Close and LOCK ${close.period}? Corrections then happen in the next period.`))void act({action:"close_month"},`${close.period} closed and locked`);}}>Close & lock month</Button>}
        {close.status==="closed"&&<small>Closed by {close.closedBy} — locked; corrections post in the next open period.</small>}
      </div>
    </section>}

    <section className={styles.panel}>
      <h2 style={{marginTop:0}}>TDS — {data.period}</h2>
      <p><Button size="sm" variant="secondary" disabled={busy} onClick={()=>void act({action:"compute_tds"},"TDS recomputed from payroll + payouts")}>Recompute from source data</Button>
      {data.tds.deposit?<small style={{marginLeft:10}}>Deposited: {money(data.tds.deposit.amount)} · challan {data.tds.deposit.challan_reference}</small>
      :<Button size="sm" variant="secondary" disabled={busy||!close||close.tds.total<=0} onClick={()=>{const challan=window.prompt("ITNS-281 challan reference?");if(challan)void act({action:"record_tds_deposit",challanReference:challan,amount:close?.tds.total},"TDS deposit recorded");}}>Record deposit ({money(close?.tds.total??0)})</Button>}</p>
      <div style={{display:"grid",gap:4,fontSize:14}}>
        <div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 80px 1fr 1fr",gap:8,fontWeight:700,color:"var(--ds-text-muted)"}}><span>Section</span><span>Deductee</span><span>Base</span><span>Rate</span><span>TDS</span><span>PAN</span></div>
        {data.tds.deductions.length===0&&<p>No deductions computed for this period yet.</p>}
        {data.tds.deductions.map((row,index)=><div key={index} style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 80px 1fr 1fr",gap:8,padding:"4px 0",borderBottom:"1px solid var(--ds-border)"}}>
          <span>{row.section}</span><span>{row.deductee_id}</span><span>{money(row.base_amount)}</span><span>{row.section==="192"?"slab":`${row.rate_pct}%`}</span><span>{money(row.tds_amount)}</span><span style={{color:row.pan_status==="verified"?"inherit":"#b57400"}}>{row.pan_status.replaceAll("_"," ")}</span>
        </div>)}
      </div>
      <h3>Quarterly returns</h3>
      <p><Button size="sm" variant="secondary" disabled={busy} onClick={()=>{const fy=window.prompt("FY label (e.g. FY2026-27)?");const quarter=Number(window.prompt("Quarter (1-4)?"));const form=window.prompt("Form (24Q or 26Q)?");if(fy&&quarter&&form)void act({action:"prepare_tds_return",fyLabel:fy,quarter,form:form.toUpperCase()},"Quarterly return prepared");}}>Prepare quarterly return</Button></p>
      <div style={{display:"grid",gap:4,fontSize:14}}>
        {data.tds.quarterlyReturns.map((item,index)=><div key={index} style={{display:"grid",gridTemplateColumns:"1fr 60px 60px 1fr 1fr 1fr 1fr",gap:8,padding:"4px 0",borderBottom:"1px solid var(--ds-border)"}}>
          <span>{item.fy_label}</span><span>Q{item.quarter}</span><span>{item.form}</span><span>TDS {money(item.total_tds)}</span><span>Deposited {money(item.total_deposited)}</span><span>{item.status}{item.acknowledgement_ref?` · ${item.acknowledgement_ref}`:""}</span>
          <span>{item.status==="prepared"&&<Button size="sm" variant="secondary" disabled={busy} onClick={()=>{const ack=window.prompt("TRACES acknowledgement reference?");if(ack)void act({action:"file_tds_return",fyLabel:item.fy_label,quarter:item.quarter,form:item.form,acknowledgementRef:ack},"Return marked filed");}}>Mark filed</Button>}</span>
        </div>)}
      </div>
    </section>
    </>}
  </main>;
}
