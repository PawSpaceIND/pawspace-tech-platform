"use client";
import{useCallback,useEffect,useState}from"react";
import{Badge,Button,StatCard}from"../../components/ui";
import OpsShell from"../../components/ops-shell/OpsShell";
import styles from"../team-console.module.css";

type Obligation={code:string;label:string;authority:string;period:string;dueDate:string;kind:string;notes:string;status:"upcoming"|"due_soon"|"overdue"|"filed";daysToDue:number;acknowledgementRef:string|null;amount:number|null};
type ChecklistItem={key:string;label:string;ok:boolean;value:number|string|null;detail:string};
type CloseView={period:string;status:"open"|"ready"|"closed";checklist:ChecklistItem[];revenue:{bookings:number;bookingCount:number;foodOrders:number;foodOrderCount:number;total:number};gst:{outputTax:number;eligibleInputTax:number;netPayable:number;invoiceCount:number};tds:{total:number;sections:Record<string,{base:number;tds:number;deductees:number}>;deposited:boolean;depositDueDate:string};payroll:{runStatus:string|null;employees:number;grossTotal:number};boardApproval:{approved:boolean;approvedBy:string|null};closedBy:string|null;closedAt:number|null};
type TdsRow={section:string;deductee_type:string;deductee_id:string;deductee_name?:string;base_amount:number;rate_pct:number;tds_amount:number;pan_status:string};
type TcsRow={supplier_id:string;service_code:string;booking_id:string;supply_type:string;order_value:number;net_taxable_value:number;cgst_tcs:number;sgst_tcs:number;igst_tcs:number;tcs_total:number;rate_pct:number};
type TcsView={period:string;collections:TcsRow[];statement:{total_net_value:number;total_tcs:number;supplier_count:number;status:string;prepared_by:string|null;acknowledgement_ref:string|null}|null;deposit:{amount:number;challan_reference:string;due_date:string}|null};
type ReconciliationFinding={severity:"ok"|"warning"|"critical";code:string;detail:string;deducteeId?:string};
type ReconciliationLeg={summary:{recordedRows:number;depositStatus:string;criticalCount:number;reconciled:boolean};findings:ReconciliationFinding[]};
type Reconciliation={period:string;tds:ReconciliationLeg;tcs:ReconciliationLeg;reconciled:boolean};
type Dashboard={period:string;calendar:Obligation[];close:CloseView;tds:{deductions:TdsRow[];deposit:{amount:number;challan_reference:string}|null;quarterlyReturns:Array<{fy_label:string;quarter:number;form:string;total_tds:number;total_deposited:number;status:string;acknowledgement_ref:string|null}>};tcs?:TcsView;reconciliation?:Reconciliation};

const money=(value:number|null)=>value==null?"—":`₹${Number(value).toLocaleString("en-IN")}`;
const statusTone=(status:string)=>status==="filed"?"success":status==="overdue"?"danger":status==="due_soon"?"warning":"neutral";

export default function FinanceCompliancePage(){
  const[period,setPeriod]=useState(()=>new Date(Date.now()+330*60_000).toISOString().slice(0,7));
  const[data,setData]=useState<Dashboard|null>(null);
  const[error,setError]=useState("");
  const[notice,setNotice]=useState("");
  const[busy,setBusy]=useState(false);
  const[loading,setLoading]=useState(true);
  /* The PAN an operator is typing, per deductee. Never sent anywhere but verify_tds_pan, which stores
   * only a masked reference (lib/tds-governance maskPan); the full PAN is not persisted or audited. */
  const[panEntry,setPanEntry]=useState<Record<string,string>>({});
  const[providerTaxEntry,setProviderTaxEntry]=useState<{providerId:string;gstin:string}>({providerId:"",gstin:""});

  const load=useCallback((target:string)=>{
    fetch(`/api/statutory-compliance?period=${encodeURIComponent(target)}`,{cache:"no-store"}).then(r=>r.json()).then(body=>{
      if(body.error)setError(String(body.error));else{setError("");setData(body.data as Dashboard);}
    }).catch(e=>setError(e instanceof Error?e.message:"Unable to load compliance dashboard")).finally(()=>setLoading(false));
  },[]);
  useEffect(()=>{load(period);},[period,load]);
  function changePeriod(next:string){setLoading(true);setPeriod(next);}

  /**
   * A refusal is an ALERT, never a notice. This screen closes a month and deposits statutory tax, so a
   * failure shown in the white role="status" panel reads as confirmation: the only thing on screen
   * after a rejected TDS filing used to be a polite "quarter (1-4) and form (24Q/26Q) are required".
   * Failures go to `error` (red, role="alert") and successes to `notice`, exactly as every other
   * finance console does. `period` is a default the caller may override with the obligation's own.
   */
  async function act(body:Record<string,unknown>,message:string):Promise<boolean>{
    setBusy(true);setNotice("");setError("");
    try{
      const response=await fetch("/api/statutory-compliance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({period,...body})});
      const payload=await response.json() as{error?:string};
      if(!response.ok)throw new Error(payload.error||"Action failed");
      setNotice(message);load(period);
      return true;
    }catch(problem){setError(problem instanceof Error?problem.message:"Action failed");return false;}
    finally{setBusy(false);}
  }

  /**
   * The calendar records a government acknowledgement against an obligation — that, and only that, is
   * what its "filed" badge is read back from (statutory_filings keyed by code + the obligation's OWN
   * period). It used to route tds_return_* rows to file_tds_return instead, which needs fyLabel,
   * quarter and form that this row never collects, so every such click was a 400; and it sent the month
   * on screen as the period, so quarterly/annual rows (TDS returns, GSTR-9, ROC) were written under a
   * key the calendar never reads and could not flip to filed. Recording the TRACES return itself stays
   * where it works: prepare → "Mark filed" in Quarterly returns below.
   */
  function recordFiling(code:string,obligationPeriod:string){
    const ack=window.prompt(`Government acknowledgement reference for ${code} (${obligationPeriod})?`);
    if(ack)void act({action:"record_filing",obligationCode:code,acknowledgementRef:ack,period:obligationPeriod},`${code} recorded as filed`);
  }

  /**
   * The operator control behind the `tds_pans_verified` close-checklist item. [FIN-W2-A1]
   *
   * lib/finance-monthly-close.ts makes an unverified deductee PAN a BLOCKING checklist item and
   * closeMonth() refuses while any item is red, but no screen in the product posted `verify_tds_pan`,
   * so a month that used to close could no longer be closed by anyone. The refusals this posts are
   * the operator's own input (a malformed PAN, a deductee with no deduction row) and reach `error`
   * — the red role="alert" panel — carrying the server's own wording, never "Action failed".
   *
   * Nothing is pre-validated here on purpose: lib/tds-governance is the single authority on what a
   * PAN is, and its refusal is the message the operator needs to read.
   */
  async function verifyPan(deducteeId:string){
    const pan=String(panEntry[deducteeId]??"").trim().toUpperCase();
    const done=await act({action:"verify_tds_pan",deducteeId,pan},`PAN verified for ${deducteeId} — s206AA cleared; only a masked reference is stored`);
    if(done)setPanEntry(current=>{const next={...current};delete next[deducteeId];return next;});
  }

  /** One PAN field per deductee, rendered both beside the blocked close and in the TDS table below. */
  const panInput=(deducteeId:string)=><input aria-label={`PAN for ${deducteeId}`} placeholder="ABCDE1234F" maxLength={10} value={panEntry[deducteeId]??""}
      onChange={event=>{const value=event.target.value;setPanEntry(current=>({...current,[deducteeId]:value}));}} />;

  async function saveProviderTaxProfile(){
    const{providerId,gstin}=providerTaxEntry;
    const done=await act({action:"save_provider_tax_profile",providerId:providerId.trim(),gstin:gstin.trim().toUpperCase()},`GSTIN recorded for ${providerId.trim()} — recompute TCS to include their supplies`);
    if(done)setProviderTaxEntry({providerId:"",gstin:""});
  }

  const close=data?.close;
  const deductions=data?.tds.deductions??[];
  /** Exactly the rows the close counts in `tds.panPending` — the ones that hold the month shut. */
  const panPending=deductions.filter(row=>String(row.pan_status||"")!=="verified");
  const tcs=data?.tcs;
  const tcsCollections=tcs?.collections??[];
  /** What recordTcsDeposit compares the challan against: SUM(tcs_total) over the period's collections. */
  const tcsLiability=Math.round(tcsCollections.reduce((sum,row)=>sum+Number(row.tcs_total||0),0)*100)/100;
  const reconciliation=data?.reconciliation;
  const reconciliationFindings=[...(reconciliation?.tds.findings??[]),...(reconciliation?.tcs.findings??[])].filter(finding=>finding.severity!=="ok");
  const overdue=(data?.calendar||[]).filter(item=>item.status==="overdue").length;
  const dueSoon=(data?.calendar||[]).filter(item=>item.status==="due_soon").length;
  const filed=(data?.calendar||[]).filter(item=>item.status==="filed").length;

  return <OpsShell
      eyebrow="FINANCE · STATUTORY COMPLIANCE & MONTHLY CLOSE"
      title="Filings, TDS and monthly close"
      description="The Indian statutory calendar — GST, TDS, EPF/ESI, Karnataka PT, advance tax and ROC — with monthly board approval, computed from real platform data. Filing itself stays manual: record the government acknowledgement here. Sandbox/UAT: no live money."
      actions={<Badge tone={overdue?"danger":dueSoon?"warning":"success"} dot>{overdue?`${overdue} overdue`:dueSoon?`${dueSoon} due soon`:"nothing overdue"}</Badge>}
      >

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
          <span>{item.status!=="filed"&&item.code!=="board_approval"&&<Button size="sm" variant="secondary" disabled={busy} onClick={()=>recordFiling(item.code,item.period)}>Record filing</Button>}</span>
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
      {panPending.length>0&&<section data-testid="pan-verification" style={{marginTop:12,padding:12,borderRadius:8,border:"1px solid var(--ds-border)",background:"#fff8e8"}}>
        <b>{panPending.length} deductee PAN(s) unverified — this is what is holding {close.period} open (tds_pans_verified)</b>
        <p style={{margin:"4px 0 10px",fontSize:13,color:"var(--ds-text-muted)"}}>s206AA levies 20% where no PAN is on record. Enter each deductee&apos;s PAN to clear the item and release the close. Only a masked reference (*****1234F) is stored — the PAN itself is never persisted or audited.</p>
        <div style={{display:"grid",gap:6}}>
          {panPending.map(row=><div key={`pan:${row.deductee_id}`} style={{display:"grid",gridTemplateColumns:"70px 1fr 170px auto",gap:8,alignItems:"center",fontSize:14}}>
            <span>{row.section}</span>
            <span><b>{row.deductee_name||row.deductee_id}</b> <small style={{color:"var(--ds-text-muted)"}}>{row.deductee_type} · {row.deductee_id} · TDS {money(row.tds_amount)}</small></span>
            {panInput(row.deductee_id)}
            <Button size="sm" variant="secondary" disabled={busy} onClick={()=>void verifyPan(row.deductee_id)}>Verify PAN</Button>
          </div>)}
        </div>
      </section>}
      <div style={{display:"flex",gap:10,marginTop:12,flexWrap:"wrap"}}>
        {!close.boardApproval.approved&&<Button size="sm" variant="secondary" disabled={busy} onClick={()=>{const minutes=window.prompt("Board minutes reference (optional)")||undefined;void act({action:"board_approve",minutesReference:minutes},"Board approval recorded");}}>Record board approval</Button>}
        {close.status==="ready"&&<Button size="sm" variant="secondary" disabled={busy} onClick={()=>{if(window.confirm(`Close and LOCK ${close.period}? Corrections then happen in the next period.`))void act({action:"close_month"},`${close.period} closed and locked`);}}>Close & lock month</Button>}
        {close.status==="closed"&&<small>Closed by {close.closedBy} — locked; corrections post in the next open period.</small>}
      </div>
    </section>}

    <section className={styles.panel} data-testid="tds-deductions">
      <h2 style={{marginTop:0}}>TDS — {data.period}</h2>
      <p><Button size="sm" variant="secondary" disabled={busy} onClick={()=>void act({action:"compute_tds"},"TDS recomputed from payroll + payouts")}>Recompute from source data</Button>
      {data.tds.deposit?<small style={{marginLeft:10}}>Deposited: {money(data.tds.deposit.amount)} · challan {data.tds.deposit.challan_reference}</small>
      :<Button size="sm" variant="secondary" disabled={busy||!close||close.tds.total<=0} onClick={()=>{const challan=window.prompt("ITNS-281 challan reference?");if(challan)void act({action:"record_tds_deposit",challanReference:challan,amount:close?.tds.total},"TDS deposit recorded");}}>Record deposit ({money(close?.tds.total??0)})</Button>}</p>
      <div style={{display:"grid",gap:4,fontSize:14}}>
        <div style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 80px 1fr 2fr",gap:8,fontWeight:700,color:"var(--ds-text-muted)"}}><span>Section</span><span>Deductee</span><span>Base</span><span>Rate</span><span>TDS</span><span>PAN (s206AA)</span></div>
        {data.tds.deductions.length===0&&<p>No deductions computed for this period yet.</p>}
        {data.tds.deductions.map((row,index)=><div key={index} style={{display:"grid",gridTemplateColumns:"80px 1fr 1fr 80px 1fr 2fr",gap:8,alignItems:"center",padding:"4px 0",borderBottom:"1px solid var(--ds-border)"}}>
          <span>{row.section}</span><span>{row.deductee_id}</span><span>{money(row.base_amount)}</span><span>{row.section==="192"?"slab":`${row.rate_pct}%`}</span><span>{money(row.tds_amount)}</span>
          {row.pan_status==="verified"
            ?<span>verified</span>
            :<span style={{display:"flex",gap:6,alignItems:"center",color:"#b57400"}}>{panInput(row.deductee_id)}<Button size="sm" variant="secondary" disabled={busy} onClick={()=>void verifyPan(row.deductee_id)}>Verify PAN</Button></span>}
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

    {/*
      * GST TCS (s52) and GSTR-8. [FIN-W2-A2]
      *
      * The dashboard has always computed this leg — GET returns `tcs` and the route carries
      * compute_tcs / prepare_gstr8 / record_tcs_deposit / save_provider_tax_profile — but no screen
      * rendered or posted any of it, so a monthly return with a statutory due date (the 10th) had no
      * operator surface at all. None of the four is machine-driven: lib/background-scheduler.ts runs
      * exactly one statutory task, runStatutoryReminderSweep, which is the "Run reminder sweep now"
      * button above.
      */}
    <section className={styles.panel} data-testid="tcs-gstr8">
      <h2 style={{marginTop:0}}>GST TCS (s52) & GSTR-8 — {data.period}</h2>
      <p style={{marginTop:0,fontSize:13,color:"var(--ds-text-muted)"}}>PawSpace collects TCS on the net value of marketplace (commission-model) supplies made through it and files GSTR-8. Deposit and statement are due the 10th of the following month. Every supplier must have a GSTIN on file before the month can be computed.</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:10,marginBottom:12}}>
        <article><small>TCS collected</small><br/><b>{money(tcsLiability)}</b><br/><small>{tcsCollections.length} supply line(s)</small></article>
        <article><small>GSTR-8 statement</small><br/><b>{tcs?.statement?`${tcs.statement.status} · ${money(tcs.statement.total_tcs)}`:"not prepared"}</b><br/><small>{tcs?.statement?`${tcs.statement.supplier_count} supplier(s)`:"prepare before filing"}</small></article>
        <article><small>TCS deposit</small><br/><b>{tcs?.deposit?money(tcs.deposit.amount):"not deposited"}</b><br/><small>{tcs?.deposit?`challan ${tcs.deposit.challan_reference} · due ${tcs.deposit.due_date}`:"challan pending"}</small></article>
      </div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:12}}>
        <Button size="sm" variant="secondary" disabled={busy} onClick={()=>void act({action:"compute_tcs"},"TCS recomputed from marketplace payouts")}>Recompute TCS from payouts</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={()=>void act({action:"prepare_gstr8"},"GSTR-8 prepared — supplier-wise statement recorded")}>Prepare GSTR-8</Button>
        {tcs?.deposit
          ?<small>Deposited {money(tcs.deposit.amount)} · challan {tcs.deposit.challan_reference}</small>
          :<Button size="sm" variant="secondary" disabled={busy||tcsLiability<=0} onClick={()=>{const challan=window.prompt("GST TCS challan reference?");if(challan)void act({action:"record_tcs_deposit",challanReference:challan,amount:tcsLiability},"TCS deposit recorded");}}>Record TCS deposit ({money(tcsLiability)})</Button>}
      </div>
      <div style={{display:"grid",gap:4,fontSize:14,marginBottom:12}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 90px 1fr 1fr 80px",gap:8,fontWeight:700,color:"var(--ds-text-muted)"}}><span>Supplier</span><span>Booking</span><span>Supply</span><span>Net value</span><span>TCS</span><span>Rate</span></div>
        {tcsCollections.length===0&&<p style={{margin:0}}>No TCS collections computed for this period yet.</p>}
        {tcsCollections.map((row,index)=><div key={`tcs:${index}`} style={{display:"grid",gridTemplateColumns:"1fr 1fr 90px 1fr 1fr 80px",gap:8,padding:"4px 0",borderBottom:"1px solid var(--ds-border)"}}>
          <span>{row.supplier_id}</span><span>{row.booking_id}</span><span>{row.supply_type}</span><span>{money(row.net_taxable_value)}</span><span>{money(row.tcs_total)}</span><span>{row.rate_pct}%</span>
        </div>)}
      </div>
      <h3 style={{marginBottom:6}}>Supplier GSTIN register</h3>
      <p style={{marginTop:0,fontSize:13,color:"var(--ds-text-muted)"}}>A marketplace supplier with no GSTIN on file stops the whole month: the recompute refuses with <code>configuration_required:provider_gstin:&lt;provider&gt;</code> rather than filing them at zero. Record the GSTIN here, then recompute.</p>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <input aria-label="Provider id" placeholder="Provider id" value={providerTaxEntry.providerId} onChange={event=>{const value=event.target.value;setProviderTaxEntry(current=>({...current,providerId:value}));}} />
        <input aria-label="Provider GSTIN" placeholder="29AABCP1234A1Z5" maxLength={15} value={providerTaxEntry.gstin} onChange={event=>{const value=event.target.value;setProviderTaxEntry(current=>({...current,gstin:value}));}} />
        <Button size="sm" variant="secondary" disabled={busy} onClick={()=>void saveProviderTaxProfile()}>Save supplier GSTIN</Button>
      </div>
    </section>

    {reconciliation&&<section className={styles.panel} data-testid="tax-reconciliation">
      <h2 style={{marginTop:0}}>TDS/TCS reconciliation — {reconciliation.period} <Badge tone={reconciliation.reconciled?"success":"danger"}>{reconciliation.reconciled?"reconciled":`${reconciliation.tds.summary.criticalCount+reconciliation.tcs.summary.criticalCount} critical`}</Badge></h2>
      <p style={{marginTop:0,fontSize:13,color:"var(--ds-text-muted)"}}>Every recorded deduction and collection recomputed against the statutory rule, and both challans matched to their liability. Re-run to record the review against the period&apos;s audit trail before filing.</p>
      <div style={{display:"grid",gap:4,fontSize:14,marginBottom:12}}>
        <div><b>TDS</b> — {reconciliation.tds.summary.recordedRows} row(s) · deposit {reconciliation.tds.summary.depositStatus}</div>
        <div><b>TCS</b> — {reconciliation.tcs.summary.recordedRows} row(s) · deposit {reconciliation.tcs.summary.depositStatus}</div>
        {reconciliationFindings.length===0&&<p style={{margin:0}}>No mismatches found.</p>}
        {reconciliationFindings.map((finding,index)=><div key={`finding:${index}`} style={{padding:"4px 0",borderBottom:"1px solid var(--ds-border)",color:finding.severity==="critical"?"var(--ds-danger-500)":"#b57400"}}>
          <b>{finding.severity}</b> · {finding.code} — {finding.detail}
        </div>)}
      </div>
      <Button size="sm" variant="secondary" disabled={busy} onClick={()=>void act({action:"reconcile_partner_tax"},"Partner tax reconciliation re-run and recorded")}>Re-run and record reconciliation</Button>
    </section>}
    </>}
  </OpsShell>;
}
