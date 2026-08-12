"use client";
import Link from"next/link";
import{useCallback,useEffect,useState}from"react";

type Reservation={id:string;groupId:string;serviceCode:string;zoneId:string;customerId:string;scheduledStart:string;scheduledEnd:string;status:string;occurrenceNumber:number;capacityUnits:number;decisionStatus:string};
type ProviderColumn={providerId:string;providerName:string;providerModel:string;reservations:Reservation[]};
type Board={date:string;providers:ProviderColumn[];total:number};

const istToday=()=>new Date(Date.now()+330*60_000).toISOString().slice(0,10);
const istTime=(iso:string)=>new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso));

const box={background:"var(--ds-surface)",border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-lg)",padding:14} as const;
const chip=(color:string)=>({display:"inline-block",padding:"1px 8px",borderRadius:999,fontSize:11,fontWeight:700,border:`1px solid ${color}`,color}) as const;
const statusColor=(status:string)=>status==="assigned"?"var(--ds-primary-500)":status==="cancelled"?"var(--ds-text-muted)":"var(--ds-accent-500)";

export default function TeamSchedulingBoard(){
  const[date,setDate]=useState(istToday());
  const[board,setBoard]=useState<Board|null>(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState("");
  const[message,setMessage]=useState("");
  const[busyGroup,setBusyGroup]=useState("");

  const[reloadKey,setReloadKey]=useState(0);
  const fetchBoard=useCallback(async(day:string)=>{
    const response=await fetch(`/api/uat-scheduling?date=${encodeURIComponent(day)}`,{cache:"no-store"});
    const body=await response.json() as{data?:Board;error?:string};
    if(!response.ok||!body.data)throw new Error(body.error||"Unable to load the scheduling day board");
    return body.data;
  },[]);
  useEffect(()=>{
    let active=true;
    fetchBoard(date).then(data=>{if(active){setBoard(data);setError("");}})
      .catch(problem=>{if(active){setBoard(null);setError(problem instanceof Error?problem.message:"Unable to load the scheduling day board");}})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[date,reloadKey,fetchBoard]);
  const refresh=()=>{setLoading(true);setReloadKey(key=>key+1);};

  // Reassign uses the existing governed path: POST /api/uat-scheduling action="reassign"
  // (staff-gated to scheduling.manage in the API gateway). The server excludes the current provider,
  // re-runs the full rule pack, and restores the original assignment if nobody else qualifies.
  async function reassign(groupId:string,fromProvider:string){
    const reason=window.prompt(`Why reassign group ${groupId} away from ${fromProvider}?`)||"";
    if(reason.trim().length<8){if(reason)setMessage("Reassignment reason must be at least 8 characters.");return;}
    setBusyGroup(groupId);setMessage("");
    try{
      const response=await fetch("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"reassign",groupId,reason})});
      const body=await response.json() as{data?:{provider?:{name?:string};previousProviderId?:string};error?:string};
      if(!response.ok)throw new Error(body.error||"Reassignment failed");
      setMessage(`Group ${groupId} reassigned to ${body.data?.provider?.name||"a new provider"}.`);
      refresh();
    }catch(problem){setMessage(problem instanceof Error?problem.message:"Reassignment failed");}
    finally{setBusyGroup("");}
  }

  return <main style={{maxWidth:1200,margin:"0 auto",padding:28,fontFamily:"system-ui",display:"grid",gap:16}}>
    <header>
      <Link href="/team">← Team</Link>
      <p style={{color:"var(--ds-primary-500)",letterSpacing:1,fontSize:12,margin:"8px 0 0"}}>SCHEDULING · DAY BOARD</p>
      <h1 style={{margin:"4px 0"}}>Provider day view</h1>
      <p style={{margin:0,color:"var(--ds-text-muted)"}}>Live scheduling_reservations for one IST day, one column per provider. Reassign re-runs the full rule pack and keeps the current assignment if no replacement qualifies.</p>
    </header>
    <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
      <label style={{display:"flex",gap:8,alignItems:"center",fontSize:14}}>Day (IST)
        <input type="date" value={date} onChange={event=>setDate(event.target.value)} style={{padding:"8px 10px",borderRadius:"var(--ds-radius-sm)",border:"1px solid var(--ds-border)"}}/>
      </label>
      <button onClick={refresh} style={{padding:"8px 14px",borderRadius:"var(--ds-radius-sm)",border:"1px solid var(--ds-border)",background:"var(--ds-surface)",cursor:"pointer"}}>Refresh</button>
      {board?<span style={{fontSize:13,color:"var(--ds-text-muted)"}}>{board.total} reservation{board.total===1?"":"s"} · {board.providers.length} provider{board.providers.length===1?"":"s"}</span>:null}
    </div>
    {message&&<p style={{color:"var(--ds-primary-500)",margin:0}}>{message}</p>}
    {error&&<p role="alert" style={{color:"var(--ds-danger-500)",margin:0}}>{error}</p>}
    {loading&&<p style={{color:"var(--ds-text-muted)"}}>Loading day board…</p>}
    {!loading&&board&&board.providers.length===0&&<section style={box}><p style={{margin:0,color:"var(--ds-text-muted)"}}>No reservations on {board.date}.</p></section>}

    <section style={{display:"flex",gap:12,overflowX:"auto",alignItems:"flex-start",paddingBottom:8}}>
      {board?.providers.map(column=><div key={column.providerId} style={{...box,minWidth:260,flex:"0 0 260px",display:"grid",gap:10}}>
        <header style={{borderBottom:"1px solid var(--ds-border)",paddingBottom:8}}>
          <b>{column.providerName}</b>
          <div style={{fontSize:12,color:"var(--ds-text-muted)"}}>{column.providerId} · {column.providerModel.replace("_","-")} · {column.reservations.length} slot{column.reservations.length===1?"":"s"}</div>
        </header>
        {column.reservations.map(reservation=><article key={reservation.id} style={{border:"1px solid var(--ds-border)",borderRadius:"var(--ds-radius-sm)",padding:10,display:"grid",gap:6}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
            <b style={{fontSize:14}}>{istTime(reservation.scheduledStart)}–{istTime(reservation.scheduledEnd)}</b>
            <span style={chip(statusColor(reservation.status))}>{reservation.status}</span>
          </div>
          <div style={{fontSize:12,color:"var(--ds-text-muted)"}}>
            {reservation.serviceCode.replace("_"," ")} · occ {reservation.occurrenceNumber} · {reservation.zoneId}<br/>
            <span>customer {reservation.customerId}</span><br/>
            <code style={{fontSize:11}}>{reservation.groupId}</code>
          </div>
          {reservation.status!=="cancelled"&&<button disabled={busyGroup===reservation.groupId} onClick={()=>void reassign(reservation.groupId,column.providerName)}
            style={{padding:"7px 10px",borderRadius:"var(--ds-radius-sm)",border:"none",background:"var(--ds-accent-500)",color:"var(--ds-primary-600)",fontWeight:700,cursor:"pointer",fontSize:13}}>
            {busyGroup===reservation.groupId?"Reassigning…":"Reassign"}
          </button>}
        </article>)}
      </div>)}
    </section>
    <footer style={{fontSize:12,color:"var(--ds-text-muted)"}}>Staff surface (scheduling.manage). Every reassignment records the acting staff identity on the decision and writes a security audit event. Sandbox/UAT — no live money.</footer>
  </main>;
}
