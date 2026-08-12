"use client";
import{useEffect,useState}from"react";
import Link from"next/link";

type Emp={rank:number;name:string;team:string;netCollectedRevenue:number;bookingConversions:number;qualifiedLeads:number;firstResponseRate:number|null};
type Groom={rank:number;headGroomerId:string;bracket:string;monthTotal:number;targetAmount:number;achievementPercent:number;winnerHeadBonus:number};
type Train={rank:number;trainerId:string;orderValue:number;meetGreetConversions:number;total:number};
type Board={asOf:number;monthStart:string;metric:string;employees:Emp[];groomers:Groom[];trainers:Train[];counts:{employees:number;groomers:number;trainers:number}};

const INR=(v?:number)=>`₹${Number(v||0).toLocaleString("en-IN")}`;
const C={ink:"#FDF3E1",dim:"#b8c6c0",ground:"#01261F",panel:"#0b2b24",panel2:"#01261F",line:"#123c33",orange:"#F6920A",purple:"#8b6bd8",gold:"#E6B34E"};
const METRICS=[["net_collected_revenue","Net collected"],["booking_conversions","Conversions"],["qualified_leads","Qualified leads"],["first_response_rate","First response %"]];
const medal=(r:number)=>r===1?"🥇":r===2?"🥈":r===3?"🥉":`#${r}`;

async function loadBoard(metric:string){const r=await fetch(`/api/leaderboard?metric=${encodeURIComponent(metric)}`,{cache:"no-store"});const p=await r.json();if(!r.ok)throw new Error(p.error||"Load failed");return p.data as Board;}

export default function LeaderboardPage(){
  const[data,setData]=useState<Board|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[metric,setMetric]=useState("net_collected_revenue");
  useEffect(()=>{let active=true;void loadBoard(metric).then(x=>{if(active){setData(x);setError("");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[metric]);

  const card:React.CSSProperties={background:C.panel,border:`1px solid ${C.line}`,borderRadius:16,padding:18,marginTop:14};
  const h2:React.CSSProperties={fontSize:15,letterSpacing:1.5,textTransform:"uppercase",color:C.gold,margin:"0 0 12px"};
  const th:React.CSSProperties={padding:"7px 10px",color:C.dim,textAlign:"left",fontWeight:600};
  const rankCell=(r:number):React.CSSProperties=>({padding:"7px 10px",fontWeight:800,fontSize:r<=3?18:14,color:r===1?C.gold:r===2?"#cbd5cf":r===3?C.orange:C.ink,width:56});

  return <main style={{minHeight:"100vh",background:C.ground,color:C.ink,fontFamily:"system-ui,-apple-system,Segoe UI,sans-serif"}}>
    <div style={{maxWidth:1080,margin:"0 auto",padding:"28px 20px 60px"}}>
      <p style={{margin:0}}><Link href="/me" style={{color:C.dim,textDecoration:"none"}}>← My workspace</Link></p>
      <p style={{fontWeight:800,letterSpacing:2,color:C.dim,fontSize:12,marginTop:10}}>PAWSPACE · LIVE LEADERBOARD</p>
      <h1 style={{margin:"6px 0",fontSize:30}}>Who&apos;s leading this month</h1>
      <p style={{color:C.dim,marginTop:0}}>Live peer ranking across the whole company — refreshes on load. Recognition only; it is not payroll or approval authority.</p>
      {error?<p style={{color:"#ff9a9a"}}>{error}</p>:null}
      {loading&&!data?<p style={{color:C.dim}}>Loading the leaderboard…</p>:null}

      <div style={{display:"flex",gap:8,flexWrap:"wrap",margin:"14px 0"}}>{METRICS.map(([k,label])=><button key={k} onClick={()=>setMetric(k)} style={{padding:"8px 14px",borderRadius:999,border:`1px solid ${metric===k?C.orange:C.line}`,background:metric===k?C.orange:"transparent",color:metric===k?"#01261F":C.ink,fontWeight:700,cursor:"pointer"}}>{label}</button>)}</div>

      <section style={card}>
        <h2 style={h2}>Employees · {data?.counts.employees||0}</h2>
        {data?.employees.length?<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}>
          <thead><tr><th style={th}>Rank</th><th style={th}>Name</th><th style={th}>Team</th><th style={{...th,textAlign:"right"}}>Net collected</th><th style={{...th,textAlign:"right"}}>Conversions</th><th style={{...th,textAlign:"right"}}>First response</th></tr></thead>
          <tbody>{data.employees.map(r=><tr key={r.rank+r.name} style={{borderTop:`1px solid ${C.line}`,background:r.rank<=3?"rgba(242,201,104,0.06)":"transparent"}}><td style={rankCell(r.rank)}>{medal(r.rank)}</td><td style={{padding:"7px 10px",fontWeight:600}}>{r.name}</td><td style={{padding:"7px 10px",color:C.dim}}>{r.team}</td><td style={{padding:"7px 10px",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{INR(r.netCollectedRevenue)}</td><td style={{padding:"7px 10px",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{r.bookingConversions}</td><td style={{padding:"7px 10px",textAlign:"right"}}>{r.firstResponseRate==null?"—":`${r.firstResponseRate}%`}</td></tr>)}</tbody></table></div>
        :<p style={{color:C.dim,margin:0}}>No productivity facts generated yet. Rankings appear once the daily productivity run has data.</p>}
      </section>

      <section style={card}>
        <h2 style={h2}>Groomers · {data?.counts.groomers||0}</h2>
        {data?.groomers.length?<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}>
          <thead><tr><th style={th}>Rank</th><th style={th}>Groomer</th><th style={th}>Bracket</th><th style={{...th,textAlign:"right"}}>Month total</th><th style={{...th,textAlign:"right"}}>Target</th><th style={{...th,textAlign:"right"}}>Achievement</th><th style={{...th,textAlign:"right"}}>Winner bonus</th></tr></thead>
          <tbody>{data.groomers.map(r=><tr key={r.rank+r.headGroomerId} style={{borderTop:`1px solid ${C.line}`,background:r.rank<=3?"rgba(242,201,104,0.06)":"transparent"}}><td style={rankCell(r.rank)}>{medal(r.rank)}</td><td style={{padding:"7px 10px",fontWeight:600}}>{r.headGroomerId}</td><td style={{padding:"7px 10px",color:C.dim}}>{r.bracket}</td><td style={{padding:"7px 10px",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{INR(r.monthTotal)}</td><td style={{padding:"7px 10px",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{INR(r.targetAmount)}</td><td style={{padding:"7px 10px",textAlign:"right",color:C.gold}}>{r.achievementPercent}%</td><td style={{padding:"7px 10px",textAlign:"right"}}>{r.winnerHeadBonus?INR(r.winnerHeadBonus):"—"}</td></tr>)}</tbody></table></div>
        :<p style={{color:C.dim,margin:0}}>No ranked groomers this month yet (needs an active bracket and a monthly target).</p>}
      </section>

      <section style={card}>
        <h2 style={h2}>Trainers · {data?.counts.trainers||0}</h2>
        {data?.trainers.length?<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}>
          <thead><tr><th style={th}>Rank</th><th style={th}>Trainer</th><th style={{...th,textAlign:"right"}}>Order value</th><th style={{...th,textAlign:"right"}}>M&G conversions</th><th style={{...th,textAlign:"right"}}>Incentive</th></tr></thead>
          <tbody>{data.trainers.map(r=><tr key={r.rank+r.trainerId} style={{borderTop:`1px solid ${C.line}`,background:r.rank<=3?"rgba(242,201,104,0.06)":"transparent"}}><td style={rankCell(r.rank)}>{medal(r.rank)}</td><td style={{padding:"7px 10px",fontWeight:600}}>{r.trainerId}</td><td style={{padding:"7px 10px",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{INR(r.orderValue)}</td><td style={{padding:"7px 10px",textAlign:"right"}}>{r.meetGreetConversions}</td><td style={{padding:"7px 10px",textAlign:"right",color:C.gold,fontVariantNumeric:"tabular-nums"}}>{INR(r.total)}</td></tr>)}</tbody></table></div>
        :<p style={{color:C.dim,margin:0}}>No ranked trainers this month yet (needs completed training bookings or Meet & Greet conversions).</p>}
      </section>

      <footer style={{marginTop:26,color:C.dim,fontSize:12}}>Ranking is an operational recognition sort — not payroll, incentive-approval, or disciplinary authority. Month: {data?.monthStart||"—"}. Sandbox / UAT.</footer>
    </div>
  </main>;
}
