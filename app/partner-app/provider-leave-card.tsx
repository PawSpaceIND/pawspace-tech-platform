"use client";
import{useCallback,useEffect,useState}from"react";
import styles from"./partner.module.css";
type LeaveRow={id:string;leave_code:string;start_date:string;end_date:string;units:number;reason:string;status:string;created_at:number};
type Snapshot={providerId:string;editable:boolean;requests:LeaveRow[]};

export default function ProviderLeaveCard({providerId}:{providerId:string}){
 const[data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[saving,setSaving]=useState(false);
 const[startDate,setStartDate]=useState(""),[endDate,setEndDate]=useState(""),[units,setUnits]=useState("1"),[reason,setReason]=useState("");
 const load=useCallback(async()=>{
  const r=await fetch("/api/provider-leave?providerId="+encodeURIComponent(providerId),{cache:"no-store"}),b=await r.json() as{data?:Snapshot;error?:string};
  if(!r.ok||!b.data)throw new Error(b.error||"Unable to load leave");return b.data;
 },[providerId]);
 useEffect(()=>{let active=true;void load().then(snapshot=>{if(active)setData(snapshot);}).catch(e=>{if(active)setError(e instanceof Error?e.message:"Unable to load leave");});return()=>{active=false;};},[load]);
 if(data&&!data.editable)return null;
 const submit=async()=>{
  setSaving(true);setError("");setNotice("");
  try{
   const r=await fetch("/api/provider-leave",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({providerId,leaveCode:"CL",startDate,endDate,units:Number(units),reason})}),b=await r.json() as{data?:{providerLeave?:{affectedBookings?:number}};error?:string};
   if(!r.ok||!b.data)throw new Error(b.error||"Unable to request leave");
   const count=b.data.providerLeave?.affectedBookings||0;
   setNotice("Leave request submitted. New assignments are blocked for these dates while approval is pending."+(count?" "+count+" existing booking(s) were sent to Operations review.":""));
   setReason("");setData(await load());
  }catch(e){setError(e instanceof Error?e.message:"Unable to request leave");}finally{setSaving(false);}
 };
 return <section className={styles.calendarCard} aria-label="Provider leave">
  <header><div><small>FULL-TIME / CONTRACT AVAILABILITY</small><h2>Request leave</h2></div><b>People + Scheduling</b></header>
  <p>Submitting leave immediately blocks new assignments for those dates. Existing bookings stay protected while Operations reviews cover.</p>
  {error&&<p role="alert" className={styles.calendarError}>{error}</p>}{notice&&<p role="status" className={styles.calendarNotice}>{notice}</p>}
  <div className={styles.calendarForm}>
   <label>From<input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}/></label>
   <label>To<input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)}/></label>
   <label>Units<input type="number" min="0.5" step="0.5" value={units} onChange={e=>setUnits(e.target.value)}/></label>
  </div>
  <label className={styles.field}>Reason<textarea minLength={4} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Reason for leave"/></label>
  <button type="button" className={styles.calendarSave} disabled={saving||!startDate||!endDate||reason.trim().length<4} onClick={()=>void submit()}>{saving?"Submitting…":"Submit leave request"}</button>
  <div className={styles.calendarList} aria-label="Leave requests"><b>Recent requests</b>{!data?.requests.length&&<span>No leave requests yet.</span>}
   {data?.requests.map(item=><article key={item.id}><div><strong>{item.start_date} → {item.end_date}</strong><small>{item.leave_code} · {item.units} unit(s)</small></div><em data-state={item.status}>{item.status}</em></article>)}
  </div>
 </section>;
}
