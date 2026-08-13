"use client";
import{useCallback,useEffect,useState}from"react";
import{Badge,Button,EmptyState,StatCard}from"../../components/ui";
import OpsShell from"../../components/ops-shell/OpsShell";
import styles from"../team-console.module.css";

type Reservation={id:string;groupId:string;serviceCode:string;zoneId:string;customerId:string;scheduledStart:string;scheduledEnd:string;status:string;occurrenceNumber:number;capacityUnits:number;decisionStatus:string};
type ProviderColumn={providerId:string;providerName:string;providerModel:string;reservations:Reservation[]};
type Board={date:string;providers:ProviderColumn[];total:number};

const istToday=()=>new Date(Date.now()+330*60_000).toISOString().slice(0,10);
const istTime=(iso:string)=>new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso));

const statusTone=(status:string)=>status==="assigned"?"success":status==="cancelled"?"neutral":"warning";

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

  const providers=board?.providers||[];
  const assigned=providers.reduce((sum,column)=>sum+column.reservations.filter(row=>row.decisionStatus==="assigned").length,0);

  return <OpsShell
      eyebrow="SCHEDULING · DAY BOARD"
      title="Provider day view"
      description="Live scheduling reservations for one IST day, one column per provider. Reassign re-runs the full rule pack and keeps the current assignment if no replacement qualifies."
      actions={<Badge tone={board?.total?"info":"warning"} dot>{board?.total||0} reservations</Badge>}
      >

    {error?<div className={`${styles.panel} ${styles.panelError}`} role="alert"><b>{error}</b></div>:null}
    {message?<div className={styles.panel}>{message}</div>:null}

    <section className={styles.tiles}>
      <StatCard label="Reservations" value={board?.total??0} />
      <StatCard label="Providers on shift" value={providers.length} />
      <StatCard label="Assigned" value={assigned} />
      <StatCard label="Day (IST)" value={board?.date||date} />
    </section>

    <section className={styles.controls}>
      <label className={styles.field}>Day (IST)<input type="date" value={date} onChange={event=>setDate(event.target.value)} /></label>
      <Button size="sm" variant="secondary" onClick={refresh}>{loading?"Refreshing…":"Refresh"}</Button>
    </section>

    {loading&&!board?<EmptyState title="Loading the day board" body="Reading live scheduling reservations for this IST day…" />
      :providers.length===0?<EmptyState title={`Nothing scheduled for ${board?.date||date}`} body="No provider holds a reservation on this day. Pick another date, or check that the schedule has been generated." />
      :<div className={styles.boardScroll}>{providers.map(column=><section key={column.providerId} className={styles.boardColumn}>
        <header className={styles.boardHead}>
          <b>{column.providerName}</b>
          <small>{column.providerId} · {column.providerModel} · {column.reservations.length} {column.reservations.length===1?"slot":"slots"}</small>
        </header>
        {column.reservations.map(row=><article key={row.id} className={styles.slot}>
          <div className={styles.recordHead}>
            <b>{istTime(row.scheduledStart)}–{istTime(row.scheduledEnd)}</b>
            <Badge tone={statusTone(row.decisionStatus)}>{row.decisionStatus}</Badge>
          </div>
          <div className={styles.stack}>
            <small>{row.serviceCode.replaceAll("_"," ")} · occ {row.occurrenceNumber} · {row.zoneId}</small>
            <small>customer {row.customerId}</small>
            <small className={styles.muted}>{row.groupId}</small>
          </div>
          <Button size="sm" variant="secondary" disabled={busyGroup===row.groupId} onClick={()=>{void reassign(row.groupId,column.providerName);}}>{busyGroup===row.groupId?"Reassigning…":"Reassign"}</Button>
        </article>)}
      </section>)}</div>}

    <footer className={styles.footnote}>Staff surface (<b>scheduling.manage</b>). Every reassignment records the acting staff identity on the decision and writes a security audit event. Sandbox/UAT — no live money.</footer>
  </OpsShell>;
}
