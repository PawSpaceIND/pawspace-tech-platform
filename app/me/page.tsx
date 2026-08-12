"use client";
import{useEffect,useState}from"react";
import Link from"next/link";

type Line={code:string;label:string;kind:string;amount:number};
type Payslip={resultId:string;runId:string;periodStart:number;periodEnd:number;status:string;gross:number;deductions:number;reimbursements:number;net:number};
type Advance={id:string;amount:number;recoveryMonths:number;monthlyAmount:number;status:string;recovered:number;outstanding:number};
type LeaveReq={id:string;leaveCode:string;startDate:string;endDate:string;units:number;reason:string;status:string;createdAt:number};
type Perf={appears:boolean;teamCode:string;ofEmployees:number;rank?:number;netCollectedRevenue?:number;bookingConversions?:number;qualifiedLeads?:number;firstResponseRate?:number|null;meaningfulActions?:number};
type View={
  linked:boolean;email?:string;
  employee?:{id:string;code:string;name:string;workEmail:string;joinedAt:number};
  compensation?:{structureCode:string;version:number;currency:string;components:Line[];grossMonthly:number;fixedDeductions:number;netMonthly:number}|null;
  payslips?:{list:Payslip[];latest:Payslip|null;latestLines:Line[]};
  incentives?:{list:{scheme:string;periodStart:number;periodEnd:number;status:string;calculated:number;approved:number}[];approvedTotal:number};
  dailyIncentive?:{list:{date:string;baseVertical:string;achievedValue:number;incentive:number;blitz:boolean;status:string}[];total:number};
  advances?:{list:Advance[];outstanding:number};
  leave?:{balances:{leaveCode:string;balance:number}[];requests:LeaveReq[]};
  attendance?:{workDate:string;status:string;workedMinutes:number;exception:string|null}[];
  performance?:Perf|null;
};

const INR=(v?:number)=>`₹${Number(v||0).toLocaleString("en-IN")}`;
const day=(v?:number)=>v?new Date(v).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",year:"numeric"}):"—";
const C={ink:"#FDF3E1",dim:"#b8c6c0",ground:"#041517",panel:"#0b2b24",panel2:"#01261F",line:"#123c33",orange:"#F6920A",purple:"#8b6bd8",gold:"#F2C968",emerald:"#01261F"};

async function loadView(){const r=await fetch("/api/me",{cache:"no-store"});const p=await r.json();if(!r.ok)throw new Error(p.error||"Load failed");return p.data as View;}

export default function MyPortalPage(){
  const[data,setData]=useState<View|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[msg,setMsg]=useState("");
  const[leave,setLeave]=useState({leaveCode:"",startDate:"",endDate:"",units:"1",reason:""});

  const refresh=async()=>{try{setData(await loadView());setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}};
  useEffect(()=>{let active=true;void loadView().then(x=>{if(active){setData(x);setError("");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);

  async function post(payload:Record<string,unknown>){const r=await fetch("/api/me",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});const b=await r.json() as{error?:string};if(!r.ok)throw new Error(b.error||"Request failed");}
  async function clock(action:"check_in"|"check_out"){setBusy(true);setMsg("");try{await post({action});setMsg(action==="check_in"?"Checked in.":"Checked out.");await refresh();}catch(e){setMsg(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function submitLeave(){if(!leave.leaveCode.trim()||!leave.startDate||!leave.endDate||leave.reason.trim().length<4){setMsg("Fill leave type, dates and a reason (4+ chars).");return;}setBusy(true);setMsg("");try{await post({action:"apply_leave",leaveCode:leave.leaveCode.trim(),startDate:leave.startDate,endDate:leave.endDate,units:Number(leave.units)||1,reason:leave.reason.trim()});setMsg("Leave request submitted for manager approval.");setLeave({leaveCode:"",startDate:"",endDate:"",units:"1",reason:""});await refresh();}catch(e){setMsg(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}

  const card:React.CSSProperties={background:C.panel,border:`1px solid ${C.line}`,borderRadius:16,padding:18};
  const stat:React.CSSProperties={background:C.panel2,border:`1px solid ${C.line}`,borderRadius:14,padding:16};
  const h2:React.CSSProperties={fontSize:15,letterSpacing:1.5,textTransform:"uppercase",color:C.gold,margin:"28px 0 12px"};
  const inp:React.CSSProperties={display:"block",width:"100%",padding:10,marginTop:4,borderRadius:8,border:`1px solid ${C.line}`,background:C.ground,color:C.ink,boxSizing:"border-box"};
  const btn:React.CSSProperties={padding:"10px 18px",borderRadius:10,border:"none",background:C.orange,color:"#041517",fontWeight:700,cursor:"pointer"};

  const e=data?.employee;
  return <main style={{minHeight:"100vh",background:C.ground,color:C.ink,fontFamily:"system-ui,-apple-system,Segoe UI,sans-serif"}}>
    <div style={{maxWidth:1080,margin:"0 auto",padding:"28px 20px 60px"}}>
      <p style={{margin:0}}><Link href="/" style={{color:C.dim,textDecoration:"none"}}>← PawSpace</Link></p>
      <p style={{fontWeight:800,letterSpacing:2,color:C.dim,fontSize:12,marginTop:10}}>PAWSPACE · MY WORKSPACE</p>
      {error?<p style={{color:"#ff9a9a"}}>{error}</p>:null}
      {loading&&!data?<p style={{color:C.dim}}>Loading your workspace…</p>:null}

      {data&&!data.linked?<section style={{...card,marginTop:16}}>
        <h1 style={{marginTop:0}}>No employee record linked yet</h1>
        <p style={{color:C.dim}}>Your identity <b>{data.email}</b> is signed in, but it is not yet linked to an active employee record. Ask People Ops to link your work email to your employee profile — then your salary, payslips, incentives, leave and ranking appear here automatically.</p>
      </section>:null}

      {e?<>
        <header style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",flexWrap:"wrap",gap:14,marginTop:8}}>
          <div><h1 style={{margin:"6px 0",fontSize:30}}>Hello, {e.name.split(" ")[0]}</h1>
            <p style={{margin:0,color:C.dim}}>{e.code} · {e.workEmail} · joined {day(e.joinedAt)}</p></div>
          <div style={{display:"flex",gap:10}}>
            <button disabled={busy} style={btn} onClick={()=>void clock("check_in")}>Check in</button>
            <button disabled={busy} style={{...btn,background:C.purple,color:C.ink}} onClick={()=>void clock("check_out")}>Check out</button>
          </div>
        </header>
        {msg?<p style={{color:C.gold}}>{msg}</p>:null}

        <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12,marginTop:18}}>
          <div style={stat}><small style={{color:C.dim}}>Net take-home (latest)</small><strong style={{display:"block",fontSize:26,marginTop:6}}>{INR(data.payslips?.latest?.net??data.compensation?.netMonthly)}</strong></div>
          <div style={stat}><small style={{color:C.dim}}>Approved incentives</small><strong style={{display:"block",fontSize:26,marginTop:6,color:C.gold}}>{INR(data.incentives?.approvedTotal)}</strong></div>
          <div style={stat}><small style={{color:C.dim}}>Daily incentive (accrued)</small><strong style={{display:"block",fontSize:26,marginTop:6,color:C.gold}}>{INR(data.dailyIncentive?.total)}</strong></div>
          <div style={stat}><small style={{color:C.dim}}>Advance outstanding</small><strong style={{display:"block",fontSize:26,marginTop:6}}>{INR(data.advances?.outstanding)}</strong></div>
          <div style={stat}><small style={{color:C.dim}}>Peer rank</small><strong style={{display:"block",fontSize:26,marginTop:6,color:C.orange}}>{data.performance?.appears?`#${data.performance.rank} / ${data.performance.ofEmployees}`:"—"}</strong></div>
        </section>

        <h2 style={h2}>My salary</h2>
        <div style={card}>
          {data.compensation?<>
            <p style={{marginTop:0,color:C.dim}}>{data.compensation.structureCode} v{data.compensation.version} · gross {INR(data.compensation.grossMonthly)}/mo · fixed deductions {INR(data.compensation.fixedDeductions)} · net {INR(data.compensation.netMonthly)}</p>
            <div style={{display:"grid",gap:6}}>{data.compensation.components.map(c=><div key={c.code} style={{display:"flex",justifyContent:"space-between",borderBottom:`1px solid ${C.line}`,padding:"6px 0"}}><span>{c.label} <small style={{color:C.dim}}>({c.kind})</small></span><span style={{fontVariantNumeric:"tabular-nums"}}>{INR(c.amount)}</span></div>)}</div>
          </>:<p style={{margin:0,color:C.dim}}>No active compensation assignment yet.</p>}
        </div>

        <h2 style={h2}>My payslips</h2>
        <div style={card}>
          {data.payslips?.latest?<>
            <p style={{marginTop:0}}><b>Latest:</b> {day(data.payslips.latest.periodStart)} → {day(data.payslips.latest.periodEnd)} · <span style={{color:C.gold}}>{data.payslips.latest.status}</span> · net {INR(data.payslips.latest.net)}</p>
            <div style={{display:"grid",gap:5,margin:"8px 0 14px"}}>{data.payslips.latestLines.map((l,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:14}}><span style={{color:l.kind==="deduction"?"#ff9a9a":C.ink}}>{l.label}</span><span style={{fontVariantNumeric:"tabular-nums"}}>{l.kind==="deduction"?"− ":""}{INR(l.amount)}</span></div>)}</div>
            <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr style={{color:C.dim,textAlign:"left"}}><th style={{padding:"6px 8px"}}>Period</th><th>Status</th><th style={{textAlign:"right"}}>Gross</th><th style={{textAlign:"right"}}>Deductions</th><th style={{textAlign:"right",padding:"6px 8px"}}>Net</th></tr></thead>
              <tbody>{data.payslips.list.map(p=><tr key={p.resultId} style={{borderTop:`1px solid ${C.line}`}}><td style={{padding:"6px 8px"}}>{day(p.periodStart)} → {day(p.periodEnd)}</td><td>{p.status}</td><td style={{textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{INR(p.gross)}</td><td style={{textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{INR(p.deductions)}</td><td style={{textAlign:"right",padding:"6px 8px",fontVariantNumeric:"tabular-nums"}}>{INR(p.net)}</td></tr>)}</tbody></table></div>
          </>:<p style={{margin:0,color:C.dim}}>No payslips generated yet.</p>}
        </div>

        <h2 style={h2}>My incentives & advances</h2>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:12}}>
          <div style={card}><b>Incentives</b>{data.incentives?.list.length?<div style={{display:"grid",gap:6,marginTop:8}}>{data.incentives.list.map((r,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:14,borderBottom:`1px solid ${C.line}`,padding:"5px 0"}}><span>{r.scheme} <small style={{color:C.dim}}>{day(r.periodStart)}</small></span><span style={{color:r.status==="approved"?C.gold:C.dim}}>{r.status} · {INR(r.approved||r.calculated)}</span></div>)}</div>:<p style={{color:C.dim,marginBottom:0}}>No incentive results yet.</p>}</div>
          <div style={card}><b>Daily incentive (auto-accrued)</b>{data.dailyIncentive?.list.length?<div style={{display:"grid",gap:6,marginTop:8}}>{data.dailyIncentive.list.slice(0,10).map((d,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:14,borderBottom:`1px solid ${C.line}`,padding:"5px 0"}}><span>{d.date} <small style={{color:C.dim}}>{d.baseVertical}{d.blitz?" · BLITZ":""}</small></span><span style={{color:C.gold}}>{INR(d.incentive)}</span></div>)}</div>:<p style={{color:C.dim,marginBottom:0}}>No daily incentive accrued yet (needs a sales base vertical + attributed bookings).</p>}</div>
          <div style={card}><b>Salary advances</b>{data.advances?.list.length?<div style={{display:"grid",gap:6,marginTop:8}}>{data.advances.list.map(a=><div key={a.id} style={{fontSize:14,borderBottom:`1px solid ${C.line}`,padding:"5px 0"}}>{INR(a.amount)} over {a.recoveryMonths} mo · <span style={{color:C.dim}}>{a.status}</span><div style={{color:C.dim}}>recovered {INR(a.recovered)} · outstanding {INR(a.outstanding)}</div></div>)}</div>:<p style={{color:C.dim,marginBottom:0}}>No advances.</p>}</div>
        </div>

        <h2 style={h2}>My performance</h2>
        <div style={card}>
          {data.performance?.appears?<p style={{margin:0}}>Team <b>{data.performance.teamCode}</b> · rank <b style={{color:C.orange}}>#{data.performance.rank}</b> of {data.performance.ofEmployees} · net collected {INR(data.performance.netCollectedRevenue)} · {data.performance.bookingConversions} conversions · {data.performance.qualifiedLeads} qualified leads · first-response {data.performance.firstResponseRate==null?"—":`${data.performance.firstResponseRate}%`}</p>
          :<p style={{margin:0,color:C.dim}}>You are not in this period&apos;s operational leaderboard facts yet (rank appears once your team&apos;s productivity facts are generated).</p>}
          <p style={{margin:"10px 0 0"}}><Link href="/leaderboard" style={{color:C.gold}}>See the live company leaderboard →</Link></p>
        </div>

        <h2 style={h2}>My leave</h2>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:12}}>
          <div style={card}>
            <b>Apply for leave</b>
            <label style={{fontSize:13,color:C.dim}}>Leave type (code)<input style={inp} value={leave.leaveCode} placeholder="e.g. CL / SL / EL" onChange={ev=>setLeave({...leave,leaveCode:ev.target.value})}/></label>
            <div style={{display:"flex",gap:8}}>
              <label style={{fontSize:13,color:C.dim,flex:1}}>From<input type="date" style={inp} value={leave.startDate} onChange={ev=>setLeave({...leave,startDate:ev.target.value})}/></label>
              <label style={{fontSize:13,color:C.dim,flex:1}}>To<input type="date" style={inp} value={leave.endDate} onChange={ev=>setLeave({...leave,endDate:ev.target.value})}/></label>
              <label style={{fontSize:13,color:C.dim,width:80}}>Days<input type="number" min="0.5" step="0.5" style={inp} value={leave.units} onChange={ev=>setLeave({...leave,units:ev.target.value})}/></label>
            </div>
            <label style={{fontSize:13,color:C.dim}}>Reason<input style={inp} value={leave.reason} onChange={ev=>setLeave({...leave,reason:ev.target.value})}/></label>
            <button disabled={busy} style={{...btn,marginTop:12}} onClick={()=>void submitLeave()}>{busy?"Working…":"Submit for approval"}</button>
          </div>
          <div style={card}>
            <b>Balances</b>{data.leave?.balances.length?<div style={{display:"flex",gap:14,flexWrap:"wrap",margin:"8px 0 14px"}}>{data.leave.balances.map(b=><span key={b.leaveCode} style={{background:C.panel2,border:`1px solid ${C.line}`,borderRadius:10,padding:"6px 12px"}}>{b.leaveCode}: <b>{b.balance}</b></span>)}</div>:<p style={{color:C.dim}}>No leave balances configured yet.</p>}
            <b>My requests</b>{data.leave?.requests.length?<div style={{display:"grid",gap:6,marginTop:8}}>{data.leave.requests.map(r=><div key={r.id} style={{fontSize:14,borderBottom:`1px solid ${C.line}`,padding:"5px 0"}}>{r.leaveCode} · {r.startDate}→{r.endDate} · {r.units}d · <span style={{color:r.status==="approved"?C.gold:r.status==="rejected"?"#ff9a9a":C.dim}}>{r.status}</span></div>)}</div>:<p style={{color:C.dim,marginBottom:0}}>No requests yet.</p>}
          </div>
        </div>

        <h2 style={h2}>My attendance (last 14 days)</h2>
        <div style={{...card,overflowX:"auto"}}>
          {data.attendance?.length?<table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}><thead><tr style={{color:C.dim,textAlign:"left"}}><th style={{padding:"6px 8px"}}>Date</th><th>Status</th><th>Worked</th><th>Exception</th></tr></thead>
            <tbody>{data.attendance.map((a,i)=><tr key={i} style={{borderTop:`1px solid ${C.line}`}}><td style={{padding:"6px 8px"}}>{a.workDate}</td><td>{a.status}</td><td>{a.workedMinutes?`${Math.floor(a.workedMinutes/60)}h ${a.workedMinutes%60}m`:"—"}</td><td style={{color:a.exception?"#ff9a9a":C.dim}}>{a.exception||"—"}</td></tr>)}</tbody></table>
          :<p style={{margin:0,color:C.dim}}>No attendance recorded yet. Use Check in / Check out above.</p>}
        </div>

        <footer style={{marginTop:30,color:C.dim,fontSize:12}}>You are viewing your own record only. Salary and incentive figures are drawn from governed payroll runs and approved incentive schemes. Leave requests follow maker/checker — your manager approves. Sandbox / UAT — not production payments.</footer>
      </>:null}
    </div>
  </main>;
}
