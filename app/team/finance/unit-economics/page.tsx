"use client";
import Link from"next/link";
import{useEffect,useRef,useState}from"react";
import { MetricBars, VisualGrid } from "../../../components/ui/ReportVisuals";
import TrendChart from "../../../components/ui/TrendChart";
import{StatCard}from"../../../components/ui";
import StaffModule from "../../../components/staff-workspace/StaffModule";

type Ladder={gmv:number;orders:number;cancelled:number;discounts:number;providerPayout:number;refunds:number;contributionKnown:number;contributionPctOfGmv:number|null;avgOrderValue:number|null;reviews:number;csatAvgStars:number|null;csatPct:number|null;complaintsPer100:number|null;repeatRatePct:number|null;revenuePerProviderDay:number|null};
type Report={from:string;to:string;services:Record<string,Ladder>;company:{gmv:number;orders:number;cancelled:number;discounts:number;providerPayout:number;refunds:number;contributionKnown:number;cancellationRatePct:number|null;activeCustomers:number;ltvPerActiveCustomer:number|null;utilisationPct:number|null;cac:{status:string;spend:number|null;newCustomers:number|null;cacPerNewCustomer:number|null}};dataCoverage:Record<string,string>};

const label=(value:unknown)=>String(value||"—").replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());
const money=(value:unknown)=>value==null?"—":new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(value));
const show=(value:unknown,suffix="")=>value==null?"—":`${value}${suffix}`;
const monthStart=()=>`${new Date().toISOString().slice(0,7)}-01`;
const today=()=>new Date().toISOString().slice(0,10);

export default function UnitEconomicsPage(){
 const requestId=useRef(0);
 const[previous,setPrevious]=useState<Report|null>(null),[busy,setBusy]=useState(false);
 const[from,setFrom]=useState(monthStart()),[to,setTo]=useState(today()),[report,setReport]=useState<Report|null>(null),[error,setError]=useState("");
 async function load(fromDate:string,toDate:string){
  const start=Date.parse(`${fromDate}T00:00:00Z`),end=Date.parse(`${toDate}T00:00:00Z`);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start){setError("Choose a valid start and end date.");return;}
  const id=++requestId.current;setBusy(true);setError("");
  const previousEnd=start-86_400_000,previousStart=previousEnd-(end-start);
  const iso=(value:number)=>new Date(value).toISOString().slice(0,10);
  const read=async(a:string,b:string)=>{const response=await fetch(`/api/unit-economics?from=${a}&to=${b}`,{cache:"no-store"});const body=await response.json() as{data?:Report;error?:string};if(!response.ok||!body.data)throw new Error(body.error||"Unable to load unit economics");return body.data;};
  try{const[current,prior]=await Promise.all([read(fromDate,toDate),read(iso(previousStart),iso(previousEnd))]);if(id===requestId.current){setReport(current);setPrevious(prior);}}
  catch(problem){if(id===requestId.current)setError(problem instanceof Error?problem.message:"Unable to load unit economics");}
  finally{if(id===requestId.current)setBusy(false);}
 }
 useEffect(()=>{const timer=window.setTimeout(()=>{void load(monthStart(),today());},0);return()=>{window.clearTimeout(timer);};},[]);
 const company=report?.company;
 return <StaffModule><main style={{maxWidth:1400,margin:"0 auto",padding:24,fontFamily:"inherit",display:"grid",gap:16}}>
  <header><Link href="/team/finance">← Finance home</Link><p>TEAM OS · FINANCE · UNIT ECONOMICS</p><h1>Unit economics</h1><p>GMV → discounts → payout → refunds → known contribution per service, with health monitors. Unconfigured cost lines (tax, gateway fees, COGS) are shown as pending — never silently zero.</p></header>
  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
   <label>From <input type="date" value={from} onChange={event=>setFrom(event.target.value)}/></label>
   <label>To <input type="date" value={to} onChange={event=>setTo(event.target.value)}/></label>
   <button disabled={busy} onClick={()=>void load(from,to)}>{busy?"Loading…":"Apply & compare"}</button>
  </div>
  {error&&<p role="alert">{error}</p>}
  {company&&<section style={{display:"grid",gridTemplateColumns:"repeat(6,minmax(120px,1fr))",gap:12}} data-staff-grid="stats">
   {[["GMV",money(company.gmv)],["Orders",company.orders],["Known contribution",money(company.contributionKnown)],["Cancellation %",show(company.cancellationRatePct,"%")],["LTV / active customer",money(company.ltvPerActiveCustomer)],["Roster utilisation",show(company.utilisationPct,"%")]].map(([name,value])=><StatCard key={String(name)} label={String(name)} value={value as string|number}/>)}
  </section>}
  {report&&previous&&<>
    <p>Loaded period: <b>{report.from} – {report.to}</b> · compared with <b>{previous.from} – {previous.to}</b> (equal number of days).</p>
    <VisualGrid>
      <section style={{minWidth:0,border:"1px solid var(--staff-line)",borderRadius:18,padding:20,background:"var(--staff-surface)"}}>
        <h2 style={{fontSize:16}}>Current vs previous period</h2>
        <TrendChart type="bar" xKey="metric" valueFormatter={money} data={[
          {metric:"GMV",current:report.company.gmv,previous:previous.company.gmv},
          {metric:"Payout",current:report.company.providerPayout,previous:previous.company.providerPayout},
          {metric:"Refunds",current:report.company.refunds,previous:previous.company.refunds},
          {metric:"Contribution",current:report.company.contributionKnown,previous:previous.company.contributionKnown},
        ]} series={[{key:"current",label:"Selected period"},{key:"previous",label:"Previous period"}]} />
      </section>
      <MetricBars title="Known contribution by service" note="Recorded costs only. Missing tax, fees or variable costs are not treated as zero profit deductions." format={money} items={Object.entries(report.services).map(([service,row])=>({label:label(service),value:row.contributionKnown}))} />
      <MetricBars title="Service demand" note="Order counts in the loaded period." items={Object.entries(report.services).map(([service,row])=>({label:label(service),value:row.orders}))} />
      <MetricBars title="Repeat customers by service" note="Percentage from each service’s reported customer base. Unavailable rates remain unknown." format={value=>`${value}%`} items={Object.entries(report.services).map(([service,row])=>({label:label(service),value:row.repeatRatePct}))} />
    </VisualGrid>
  </>}
  {company&&<p><b>CAC:</b> {company.cac.status==="derived_from_recorded_spend"?`${money(company.cac.spend)} spend ÷ ${company.cac.newCustomers} new customers = ${money(company.cac.cacPerNewCustomer)}`:"configuration required — no recorded marketing spend facts yet"}</p>}
  {report&&<section style={{overflowX:"auto"}}>
   <table style={{borderCollapse:"collapse",width:"100%"}}>
    <thead><tr>{["Service","GMV","Orders","AOV","Discounts","Provider payout","Refunds","Known contribution","Contribution %","Repeat %","Cancelled","Complaints/100","CSAT ★","CSAT ≥4★ %","Rev / provider-day"].map(header=><th key={header} style={{textAlign:"left",borderBottom:"2px solid var(--staff-line)",padding:"8px 10px"}}>{header}</th>)}</tr></thead>
    <tbody>{Object.entries(report.services).sort(([,a],[,b])=>b.gmv-a.gmv).map(([service,ladder])=><tr key={service}>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}><b>{label(service)}</b></td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{money(ladder.gmv)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{ladder.orders}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{money(ladder.avgOrderValue)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{money(ladder.discounts)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{money(ladder.providerPayout)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{money(ladder.refunds)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}><b>{money(ladder.contributionKnown)}</b></td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{show(ladder.contributionPctOfGmv,"%")}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{show(ladder.repeatRatePct,"%")}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{ladder.cancelled}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{show(ladder.complaintsPer100)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{show(ladder.csatAvgStars)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{show(ladder.csatPct,"%")}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid var(--staff-line)"}}>{money(ladder.revenuePerProviderDay)}</td>
    </tr>)}</tbody>
   </table>
  </section>}
  {report&&<footer style={{border:"1px solid var(--staff-line)",borderRadius:14,padding:16}}>
   <h2>What each number is made of</h2>
   <ul>{Object.entries(report.dataCoverage).map(([key,source])=><li key={key}><b>{label(key)}:</b> {source}</li>)}</ul>
   <small>Known contribution = GMV − discounts − provider payout − refunds. Tax, payment fees and variable cost join the ladder once their policies are configured; a service is never shown profitable because a cost is unrecorded.</small>
  </footer>}
 </main></StaffModule>;
}
