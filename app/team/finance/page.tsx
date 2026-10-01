"use client";
import styles from "./finance-content.module.css";
import {MetricBars, TargetProgress, VisualGrid} from "../../components/ui/ReportVisuals";
import VisualAnalytics from "../../components/ui/VisualAnalytics";

import Link from"next/link";
import{readReportJson}from"../../../lib/read-report-json";
import{useEffect,useState}from"react";
import StaffModule from "../../components/staff-workspace/StaffModule";
import GroomingGstPanel from "./grooming-gst-panel";
import{FinanceLedger,type FinanceLedgerData}from"./finance-ledger";

type LedgerResponse={data?:FinanceLedgerData;error?:string};
const linkStyle={padding:"11px 16px",borderRadius:"calc(10px * var(--paw-radius-scale))",border:"1px solid var(--staff-line)",background:"var(--staff-surface)",fontWeight:700,textDecoration:"none",color:"var(--paw-link)"} as const;
/** Every service's bookings with their payment state (Boarding, Pet Sitting, Pet Taxi, Grooming, Training), read-only. */
const ledgerUrl=(service:string)=>`/api/payment-reconciliation?view=bookings${service?`&service=${encodeURIComponent(service)}`:""}`;
async function readLedger(service:string){const body=await readReportJson<LedgerResponse>(ledgerUrl(service));if(!body.data||!Array.isArray(body.data.items)||!Array.isArray(body.data.services))throw new Error("Finance ledger response is incomplete");return body.data;}

export default function TeamFinance(){
  const[service,setService]=useState("");
  const[data,setData]=useState<FinanceLedgerData|null>(null);
  const[error,setError]=useState("");
  const[loading,setLoading]=useState(true);
  const load=async(next=service)=>{setLoading(true);setError("");setData(null);try{setData(await readLedger(next));}catch(err){setError(err instanceof Error?err.message:"Unable to load finance ledger");}finally{setLoading(false);}};
  useEffect(()=>{let active=true;readLedger("").then(body=>{if(active)setData(body);}).catch(err=>{if(active)setError(err instanceof Error?err.message:"Unable to load finance ledger");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  const chooseService=(code:string)=>{setService(code);void load(code);};

  return <StaffModule><main className={styles.page} style={{minHeight:"100vh",background:"var(--staff-bg)",padding:"32px",fontFamily:"inherit",color:"var(--staff-text)"}}>
    <div style={{maxWidth:1420,margin:"0 auto"}}>
      <header className={styles.header} style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:20,alignItems:"center",marginBottom:24}}>
        <div><small style={{fontWeight:800,letterSpacing:1.4,color:"var(--paw-link)"}}>PAWSPACE TEAM · FINANCE</small><h1 style={{fontSize:32,margin:"8px 0"}}>Service finance & reconciliation</h1><p style={{margin:0,color:"var(--staff-muted)"}}>Boarding, Pet Sitting, Pet Taxi, Grooming and Training bookings with their payment state, from the canonical payment, reconciliation and refund records.</p></div>
        <div className={styles.tools} style={{display:"flex",flexWrap:"wrap",gap:10}}><button disabled={loading} onClick={()=>void load()} style={{padding:"11px 16px",borderRadius:"calc(10px * var(--paw-radius-scale))",border:"1px solid var(--staff-line)",background:"var(--staff-surface)",fontWeight:700}}>Refresh</button><Link href="/team/finance/reconciliation" style={linkStyle}>Reconciliation &amp; exceptions</Link><Link href="/team/finance/cash-flow" style={linkStyle}>Cash flow & earned revenue</Link><Link href="/team/finance/statutory" style={linkStyle}>GST, input tax & returns</Link><Link href="/team/finance/training" style={linkStyle}>Training finance</Link><Link href="/team/finance/boarding" style={linkStyle}>Boarding finance</Link><Link href="/team/finance/sitting" style={linkStyle}>Pet Sitting finance</Link><Link href="/team/finance/taxi" style={linkStyle}>Pet Taxi finance</Link><Link href="/team" style={{padding:"11px 16px",borderRadius:"calc(10px * var(--paw-radius-scale))",background:"var(--staff-primary)",color:"var(--staff-on-primary)",textDecoration:"none",fontWeight:700}}>Team home</Link></div>
      </header>

      <GroomingGstPanel />
      {error&&<section role="alert" style={{padding:18,borderRadius:"calc(12px * var(--paw-radius-scale))",background:"var(--staff-danger-bg)",border:"1px solid var(--staff-line)",marginBottom:20}}><b>Finance ledger unavailable</b><div>{error}</div></section>}
      <VisualAnalytics title="Revenue trends" />
      {data&&!loading&&!error&&<p role="note">Totals below cover every booking of the selected services; the table lists the newest {data.limit} by last update. The revenue chart above has its own date range; its filters do not change this ledger.</p>}
      {!error&&<FinanceLedger data={data} loading={loading} service={service} onService={chooseService} />}
      <p style={{fontSize:14,color:"var(--staff-muted)",marginTop:12}}>UAT/sandbox only. Razorpay production credentials, live refunds, RazorpayX payouts, GST filing and accounting export are not activated by this screen.</p>
    </div>
  <p><a href="/team/finance/walking">Open Dog Walking Finance workspace →</a></p></main></StaffModule>;
}
