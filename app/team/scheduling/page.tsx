"use client";
import{useCallback,useEffect,useState}from"react";
import{Badge,Button,EmptyState,StatCard}from"../../components/ui";
import OpsShell from"../../components/ops-shell/OpsShell";
import styles from"../team-console.module.css";
import {apiSend} from "../../../lib/api-fetch";

type Reservation={id:string;groupId:string;serviceCode:string;zoneId:string;customerId:string;scheduledStart:string;scheduledEnd:string;status:string;occurrenceNumber:number;capacityUnits:number;decisionStatus:string};
type ProviderColumn={providerId:string;providerName:string;providerModel:string;reservations:Reservation[]};
type Board={date:string;providers:ProviderColumn[];total:number};

const istToday=()=>new Date(Date.now()+330*60_000).toISOString().slice(0,10);
const istTime=(iso:string)=>new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso));

const statusTone=(status:string)=>status==="assigned"?"success":status==="cancelled"?"neutral":"warning";

export default function TeamSchedulingBoard(){return <SchedulingDayBoard/>;}

export function SchedulingDayBoard({embedded=false}:{embedded?:boolean}={}){
  const[date,setDate]=useState(istToday());
  const[board,setBoard]=useState<Board|null>(null);
  const[loading,setLoading]=useState(true);
  const[error,setError]=useState("");
  const[message,setMessage]=useState("");
  const[busyGroup,setBusyGroup]=useState("");

  const[reloadKey,setReloadKey]=useState(0);
  const fetchBoard=useCallback(async(day:string)=>{
    const data=await apiSend<Board>(`/api/uat-scheduling?date=${encodeURIComponent(day)}`,{cache:"no-store"});
    if(data.date!==day||!Array.isArray(data.providers)||typeof data.total!=="number"||data.providers.some(column=>!column||typeof column.providerId!=="string"||!Array.isArray(column.reservations)))throw new Error("The scheduling response was incomplete. Refresh to try again.");
    return data;
  },[]);
  useEffect(()=>{
    let active=true;
    fetchBoard(date).then(data=>{if(active){setBoard(data);setError("");}})
      .catch(problem=>{if(active){setBoard(null);setError(problem instanceof Error?problem.message:"Unable to load the scheduling day board");}})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[date,reloadKey,fetchBoard]);
  const refresh=()=>{setError("");setBoard(null);setLoading(true);setReloadKey(key=>key+1);};

  // Reassign uses the existing governed path: POST /api/uat-scheduling action="reassign"
  // (staff-gated to scheduling.manage in the API gateway). The server excludes the current provider,
  // re-runs the full rule pack, and restores the original assignment if nobody else qualifies.
  async function reassign(groupId:string,fromProvider:string){
    if(busyGroup||loading)return;
    const reason=window.prompt(`Why reassign group ${groupId} away from ${fromProvider}?`)||"";
    if(reason.trim().length<8){if(reason)setMessage("Reassignment reason must be at least 8 characters.");return;}
    setBusyGroup(groupId);setMessage("");
    try{
      const data=await apiSend<{provider?:{name?:string}}>("/api/uat-scheduling",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"reassign",groupId,reason})});
      if(!data.provider?.name)throw new Error("The reassignment result could not be confirmed. Refresh the schedule before retrying.");
      setMessage(`Group ${groupId} reassigned to ${data.provider.name}.`);
      refresh();
    }catch(problem){setBoard(null);setError(problem instanceof Error?problem.message:"Reassignment could not be confirmed. Refresh before retrying.");}
    finally{setBusyGroup("");}
  }

  const providers=board?.providers||[];
  const assigned=providers.reduce((sum,column)=>sum+column.reservations.filter(row=>row.status!=="cancelled"&&row.decisionStatus==="assigned").length,0);

  const content=<>
    {error?<div className={`${styles.panel} ${styles.panelError}`} role="alert"><b>{error}</b></div>:null}
    {message?<div className={styles.panel}>{message}</div>:null}

    <section className={styles.tiles}>
      <StatCard label="Reservations" value={board?.total??"—"} />
      <StatCard label="Providers with reservations" value={board?providers.length:"—"} />
      <StatCard label="Assigned" value={board?assigned:"—"} />
      <StatCard label="Day (IST)" value={board?.date||date} />
    </section>

    <section className={styles.controls}>
      <label className={styles.field}>Day (IST)<input type="date" value={date} disabled={Boolean(busyGroup)} onChange={event=>{if(!event.target.value)return;setError("");setBoard(null);setLoading(true);setDate(event.target.value);}} /></label>
      <Button size="sm" variant="secondary" disabled={loading||Boolean(busyGroup)} onClick={refresh}>{loading?"Refreshing…":"Refresh"}</Button>
    </section>

    {loading&&!board?<EmptyState title="Loading the day board" body="Reading live scheduling reservations for this IST day…" />
      :error?<EmptyState title="Schedule unavailable" body="The schedule could not be read. Refresh to try again." />
      :providers.length===0?<EmptyState title={`Nothing scheduled for ${board?.date||date}`} body="No provider holds a reservation on this day. Pick another date, or check that the schedule has been generated." />
      :<div className={styles.boardScroll}>{providers.map(column=><section key={column.providerId} className={styles.boardColumn}>
        <header className={styles.boardHead}>
          <b>{column.providerName}</b>
          <small>{column.providerId} · {column.providerModel} · {column.reservations.length} {column.reservations.length===1?"slot":"slots"}</small>
        </header>
        {column.reservations.map(row=><article key={row.id} className={styles.slot}>
          <div className={styles.recordHead}>
            <b>{istTime(row.scheduledStart)}–{istTime(row.scheduledEnd)}</b>
            <Badge tone={statusTone(row.status==="cancelled"?"cancelled":row.decisionStatus)}>{row.status==="cancelled"?"cancelled":row.decisionStatus}</Badge>
          </div>
          <div className={styles.stack}>
            <small>{row.serviceCode.replaceAll("_"," ")} · occ {row.occurrenceNumber} · {row.zoneId}</small>
            <small>customer {row.customerId}</small>
            <small className={styles.muted}>{row.groupId}</small>
          </div>
          <Button size="sm" variant="secondary" disabled={Boolean(busyGroup)||loading||row.status==="cancelled"||row.decisionStatus!=="assigned"} onClick={()=>{void reassign(row.groupId,column.providerName);}}>{busyGroup===row.groupId?"Reassigning…":"Reassign"}</Button>
        </article>)}
      </section>)}</div>}

    <footer className={styles.footnote}>Staff surface (<b>scheduling.manage</b>). Every reassignment records the acting staff identity on the decision and writes a security audit event. Sandbox/UAT — no live money.</footer>
  </>;
  return embedded?<section aria-label="Scheduling day board">{content}</section>:<OpsShell
      eyebrow="SCHEDULING · DAY BOARD" title="Provider day view"
      description="Saved scheduling reservations for one IST day. Reassignment rechecks provider eligibility and capacity."
      actions={<Badge tone="info">{board?`${board.total} reservations`:"Schedule not loaded"}</Badge>}
    >{content}</OpsShell>;
}
