"use client";
import {useEffect,useState} from "react";
import {loadTrainingProgramme,materializeTrainingProgramme,type CustomerTrainingProgramme} from "../../../lib/training-programme-client";
import TrainingManage from "./training-manage";

type Props={bookingId:string;inactive:boolean;onReady:(ready:boolean)=>void};
/** Recovery uses the existing booking and reservations. It never reserves a second calendar. */
export default function TrainingBookingSessions({bookingId,inactive,onReady}:Props){
 const[record,setRecord]=useState<CustomerTrainingProgramme|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[preparing,setPreparing]=useState(false);
 useEffect(()=>{
  const abort=new AbortController();
  void loadTrainingProgramme(bookingId,abort.signal).then(value=>{
   if(abort.signal.aborted)return;
   if(value.programme.booking_id!==bookingId||!value.sessions.length)throw new Error("Reserved sessions are not ready yet.");
   setRecord(value);onReady(true);
  }).catch(problem=>{if(!abort.signal.aborted){setError(problem instanceof Error?problem.message:"Unable to load reserved sessions.");onReady(false);}}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});
  return()=>abort.abort();
 },[bookingId,onReady]);
 async function prepare(){
  if(preparing||inactive)return;
  setPreparing(true);setError("");
  try{const value=await materializeTrainingProgramme({bookingId});if(value.programme.booking_id!==bookingId||!value.sessions.length)throw new Error("Reserved sessions are not ready yet.");setRecord(value);onReady(true);}
  catch(problem){setError(problem instanceof Error?problem.message:"Unable to prepare reserved sessions. Retry this booking.");onReady(false);}
  finally{setPreparing(false);}
 }
 /** After a reschedule request, re-read the sessions so the requested one shows its new state. */
 async function reload(){try{const value=await loadTrainingProgramme(bookingId);if(value.programme.booking_id===bookingId&&value.sessions.length)setRecord(value);}catch{/* the request was accepted; the list catches up on the next page load */}}
 return <section id="training-sessions" aria-label="Training sessions"><h2>{record?.programme.plan_code==="trainer-meet-greet"?"Your assessment":"Your reserved sessions"}</h2>
 {loading?<p role="status">Loading session details…</p>:record?<ol>{record.sessions.map(session=><li key={session.id}>{new Date(session.scheduled_start).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})} IST — {session.status.replaceAll("_"," ")}</li>)}</ol>:<><p>Your booking is saved. Prepare its reserved sessions before payment; this keeps the same booking and trainer.</p>{!inactive&&<button disabled={preparing} onClick={()=>void prepare()}>{preparing?"Preparing sessions…":"Prepare reserved sessions"}</button>}</>}
 {record&&<TrainingManage bookingId={bookingId} record={record} inactive={inactive} onRescheduled={()=>void reload()}/>}
 {error&&<p role="alert">{error}</p>}
 </section>;
}
