"use client";
import Link from"next/link";
import{useEffect,useState}from"react";
import{StatCard}from"../../../components/ui";

type Ladder={gmv:number;orders:number;cancelled:number;discounts:number;providerPayout:number;refunds:number;contributionKnown:number;contributionPctOfGmv:number|null;avgOrderValue:number|null;reviews:number;csatAvgStars:number|null;csatPct:number|null;complaintsPer100:number|null;repeatRatePct:number|null;revenuePerProviderDay:number|null};
type Report={from:string;to:string;services:Record<string,Ladder>;company:{gmv:number;orders:number;cancelled:number;discounts:number;providerPayout:number;refunds:number;contributionKnown:number;cancellationRatePct:number|null;activeCustomers:number;ltvPerActiveCustomer:number|null;utilisationPct:number|null;cac:{status:string;spend:number|null;newCustomers:number|null;cacPerNewCustomer:number|null}};dataCoverage:Record<string,string>};

const label=(value:unknown)=>String(value||"—").replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());
const money=(value:unknown)=>value==null?"—":new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(Number(value));
const show=(value:unknown,suffix="")=>value==null?"—":`${value}${suffix}`;
const monthStart=()=>`${new Date().toISOString().slice(0,7)}-01`;
const today=()=>new Date().toISOString().slice(0,10);

export default function UnitEconomicsPage(){
 const[from,setFrom]=useState(monthStart()),[to,setTo]=useState(today()),[report,setReport]=useState<Report|null>(null),[error,setError]=useState("");
 function load(fromDate:string,toDate:string){fetch(`/api/unit-economics?from=${fromDate}&to=${toDate}`,{cache:"no-store"}).then(async response=>{const body=await response.json() as{data?:Report;error?:string};if(!response.ok||!body.data)throw new Error(body.error||"Unable to load unit economics");setReport(body.data);setError("");}).catch(problem=>setError(problem instanceof Error?problem.message:"Unable to load unit economics"));}
 useEffect(()=>{load(monthStart(),today());},[]);
 const company=report?.company;
 return <main style={{maxWidth:1400,margin:"0 auto",padding:24,fontFamily:"system-ui",display:"grid",gap:16}}>
  <header><Link href="/team/finance">← Finance home</Link><p>TEAM OS · FINANCE · UNIT ECONOMICS</p><h1>Unit economics</h1><p>GMV → discounts → payout → refunds → known contribution per service, with health monitors. Unconfigured cost lines (tax, gateway fees, COGS) are shown as pending — never silently zero.</p></header>
  <div style={{display:"flex",gap:8,alignItems:"center"}}>
   <label>From <input type="date" value={from} onChange={event=>setFrom(event.target.value)}/></label>
   <label>To <input type="date" value={to} onChange={event=>setTo(event.target.value)}/></label>
   <button onClick={()=>load(from,to)}>Apply</button>
  </div>
  {error&&<p role="alert">{error}</p>}
  {company&&<section style={{display:"grid",gridTemplateColumns:"repeat(6,minmax(120px,1fr))",gap:12}}>
   {[["GMV",money(company.gmv)],["Orders",company.orders],["Known contribution",money(company.contributionKnown)],["Cancellation %",show(company.cancellationRatePct,"%")],["LTV / active customer",money(company.ltvPerActiveCustomer)],["Roster utilisation",show(company.utilisationPct,"%")]].map(([name,value])=><StatCard key={String(name)} label={String(name)} value={value as string|number}/>)}
  </section>}
  {company&&<p><b>CAC:</b> {company.cac.status==="derived_from_recorded_spend"?`${money(company.cac.spend)} spend ÷ ${company.cac.newCustomers} new customers = ${money(company.cac.cacPerNewCustomer)}`:"configuration required — no recorded marketing spend facts yet"}</p>}
  {report&&<section style={{overflowX:"auto"}}>
   <table style={{borderCollapse:"collapse",width:"100%"}}>
    <thead><tr>{["Service","GMV","Orders","AOV","Discounts","Provider payout","Refunds","Known contribution","Contribution %","Repeat %","Cancelled","Complaints/100","CSAT ★","CSAT ≥4★ %","Rev / provider-day"].map(header=><th key={header} style={{textAlign:"left",borderBottom:"2px solid #dcece5",padding:"8px 10px"}}>{header}</th>)}</tr></thead>
    <tbody>{Object.entries(report.services).sort(([,a],[,b])=>b.gmv-a.gmv).map(([service,ladder])=><tr key={service}>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}><b>{label(service)}</b></td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{money(ladder.gmv)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{ladder.orders}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{money(ladder.avgOrderValue)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{money(ladder.discounts)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{money(ladder.providerPayout)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{money(ladder.refunds)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}><b>{money(ladder.contributionKnown)}</b></td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{show(ladder.contributionPctOfGmv,"%")}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{show(ladder.repeatRatePct,"%")}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{ladder.cancelled}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{show(ladder.complaintsPer100)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{show(ladder.csatAvgStars)}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{show(ladder.csatPct,"%")}</td>
     <td style={{padding:"8px 10px",borderBottom:"1px solid #e9f1ee"}}>{money(ladder.revenuePerProviderDay)}</td>
    </tr>)}</tbody>
   </table>
  </section>}
  {report&&<footer style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
   <h2>What each number is made of</h2>
   <ul>{Object.entries(report.dataCoverage).map(([key,source])=><li key={key}><b>{label(key)}:</b> {source}</li>)}</ul>
   <small>Known contribution = GMV − discounts − provider payout − refunds. Tax, payment fees and variable cost join the ladder once their policies are configured; a service is never shown profitable because a cost is unrecorded.</small>
  </footer>}
 </main>;
}
