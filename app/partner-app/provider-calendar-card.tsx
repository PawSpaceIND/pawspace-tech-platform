"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import styles from "./partner.module.css";

type CalendarDay={id:string;date:string;zoneId:string;windows:string[];state:"open"|"blocked";source:string;locked:boolean;updatedAt:number};
type CalendarSnapshot={providerId:string;cityId:string;providerModel:string;zones:string[];editable:boolean;days:CalendarDay[]};
type WindowDraft={key:number;start:string;end:string};
const fmt=(date:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
const plusDays=(days:number)=>fmt(new Date(Date.now()+days*86_400_000));
const defaultWindow=():WindowDraft=>({key:Date.now(),start:"09:00",end:"19:00"});
const windowDraft=(window:string,index:number):WindowDraft=>{const[start,end]=window.split("-");return{key:Date.now()+index,start:start||"09:00",end:end||"19:00"};};

export default function ProviderCalendarCard({providerId}:{providerId:string}){
 const from=useMemo(()=>plusDays(0),[]),to=useMemo(()=>plusDays(30),[]),firstDate=useMemo(()=>plusDays(1),[]);
 const[calendar,setCalendar]=useState<CalendarSnapshot|null>(null),[loading,setLoading]=useState(true);
 const[error,setError]=useState(""),[notice,setNotice]=useState(""),[saving,setSaving]=useState(false);
 const[date,setDate]=useState(firstDate),[zoneId,setZoneId]=useState("");
 const[state,setState]=useState<"open"|"blocked">("blocked"),[windows,setWindows]=useState<WindowDraft[]>([defaultWindow()]);

 const requestCalendar=useCallback(async()=>{
  const response=await fetch(`/api/provider-availability?providerId=${encodeURIComponent(providerId)}&from=${from}&to=${to}`,{cache:"no-store"});
  const body=await response.json() as {data?:CalendarSnapshot;error?:string};
  if(!response.ok||!body.data)throw new Error(body.error||"Unable to load your calendar");
  return body.data;
 },[providerId,from,to]);
 const selectEditor=useCallback((snapshot:CalendarSnapshot,targetDate:string,targetZone:string,clearNotice=true)=>{
  const selected=snapshot.days.find(item=>item.date===targetDate&&item.zoneId===targetZone&&(item.locked||item.source==="partner_app"))??null;
  setDate(targetDate);setZoneId(targetZone);setState(selected?.state??"blocked");
  setWindows(selected?.windows.length?selected.windows.map(windowDraft):[defaultWindow()]);
  if(clearNotice)setNotice("");
 },[]);

 useEffect(()=>{
  let active=true;
  void requestCalendar().then(snapshot=>{
   if(!active)return;
   const initialZone=snapshot.zones[0]||"";
   setCalendar(snapshot);selectEditor(snapshot,firstDate,initialZone);setError("");
  }).catch(problem=>{if(active)setError(problem instanceof Error?problem.message:"Unable to load your calendar");})
   .finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[requestCalendar,selectEditor,firstDate]);

 if(!loading&&calendar&&!calendar.editable)return null;
 const selected=calendar?.days.find(item=>item.date===date&&item.zoneId===zoneId&&(item.locked||item.source==="partner_app"))??null;
 const locked=Boolean(selected?.locked);
 const save=async()=>{
  if(!calendar||!zoneId||locked)return;
  setSaving(true);setError("");setNotice("");
  try{
   const payload={providerId,date,zoneId,state,windows:state==="open"?windows.map(item=>`${item.start}-${item.end}`):[]};
   const response=await fetch("/api/provider-availability",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
   const body=await response.json() as {data?:CalendarDay;error?:string};
   if(!response.ok||!body.data)throw new Error(body.error||"Unable to save your calendar");
   const message=body.data.state==="open"?"This date is Open for assignment in the saved windows.":"This date is Blocked for assignment.";
   const snapshot=await requestCalendar();setCalendar(snapshot);selectEditor(snapshot,date,zoneId,false);setNotice(message);
  }catch(problem){setError(problem instanceof Error?problem.message:"Unable to save your calendar");}
  finally{setSaving(false);}
 };
 const updateWindow=(key:number,field:"start"|"end",value:string)=>setWindows(current=>current.map(item=>item.key===key?{...item,[field]:value}:item));
 const published=(calendar?.days??[]).filter(item=>item.date>=from&&item.date<=to).slice(0,14);

 return <section className={styles.calendarCard} aria-label="Availability calendar">
  <header><div><small>COMMISSION AVAILABILITY</small><h2>Open / Blocked calendar</h2></div><b>{loading?"Loading…":"30 days"}</b></header>
  <p>Only dates and time windows you explicitly mark <strong>Open</strong> are eligible for new assignments. Operations-managed dates cannot be widened here.</p>
  {error&&<p role="alert" className={styles.calendarError}>{error}</p>}
  {notice&&<p role="status" className={styles.calendarNotice}>{notice}</p>}

  {calendar&&<>
   <div className={styles.calendarForm}>
    <label>Date<input type="date" min={from} max={to} value={date} onChange={event=>selectEditor(calendar,event.target.value,zoneId)}/></label>
    <label>Service zone<select value={zoneId} onChange={event=>selectEditor(calendar,date,event.target.value)}>{calendar.zones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</select></label>
   </div>
   <div className={styles.calendarToggle} role="group" aria-label="Calendar state">
    <button type="button" aria-pressed={state==="open"} className={state==="open"?styles.calendarToggleActive:""} onClick={()=>setState("open")} disabled={locked||saving}>Open</button>
    <button type="button" aria-pressed={state==="blocked"} className={state==="blocked"?styles.calendarToggleActive:""} onClick={()=>setState("blocked")} disabled={locked||saving}>Blocked</button>
   </div>
   {locked&&<p className={styles.calendarLock}>Managed by {selected?.source==="roster"?"the approved roster":"Operations"}. Ask Ops to change this date.</p>}
   {!locked&&state==="open"&&<div className={styles.calendarWindows}>
    {windows.map((item,index)=><div className={styles.calendarWindow} key={item.key}>
      <label>From<input type="time" value={item.start} onChange={event=>updateWindow(item.key,"start",event.target.value)}/></label>
      <label>To<input type="time" value={item.end} onChange={event=>updateWindow(item.key,"end",event.target.value)}/></label>
      <button type="button" aria-label={`Remove window ${index+1}`} onClick={()=>setWindows(current=>current.filter(window=>window.key!==item.key))} disabled={windows.length===1||saving}>×</button>
    </div>)}
    <button type="button" className={styles.calendarSecondary} onClick={()=>setWindows(current=>current.length>=5?current:[...current,{...defaultWindow(),key:Date.now()+current.length}])} disabled={windows.length>=5||saving}>+ Add another window</button>
   </div>}
   <button type="button" className={styles.calendarSave} onClick={()=>void save()} disabled={saving||locked||!zoneId}>{saving?"Saving…":state==="open"?"Save Open windows":"Block this date"}</button>
  </>}

  <div className={styles.calendarList} aria-label="Published availability">
   <b>Published dates</b>
   {!published.length&&<span>No dates published yet.</span>}
   {published.map(item=><article key={item.id}>
    <div><strong>{item.date}</strong><small>{item.zoneId} · {item.locked?item.source:"self-service"}</small></div>
    <em data-state={item.state}>{item.state==="open"?(item.windows.join(", ")||"Open"):"Blocked"}</em>
   </article>)}
  </div>
 </section>;
}
