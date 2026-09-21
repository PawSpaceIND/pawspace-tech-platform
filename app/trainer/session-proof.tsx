"use client";
import {useState} from "react";
import type {TrainingEvidenceAsset,TrainingEvidencePurpose} from "../../lib/training-session-client";
import styles from "./session-proof.module.css";

export function TrainingEvidenceControls({assets,busy,error,onUpload,onRefresh}:{assets:TrainingEvidenceAsset[];busy:boolean;error:string;onUpload:(file:File,purpose:TrainingEvidencePurpose)=>void;onRefresh:()=>void}){
 return <section className={styles.media}><div><span>SESSION PHOTOS</span><h3>Before and after photos</h3><p>Both photos need independent approval and release under the media policy before you can complete the session.</p>{error&&<p role="alert">{error}</p>}{(["before_service","after_service"] as const).map(purpose=>{
  const matching=assets.filter(asset=>asset.purpose===purpose),ready=matching.some(asset=>asset.proofReady),pending=matching.some(asset=>asset.access_status!=="pending_upload"&&asset.review_status!=="rejected");
  const label=purpose==="before_service"?"Before photo":"After photo";
  return <div key={purpose}><strong>{label}: {ready?"Approved":pending?"Awaiting approval / release":matching.some(asset=>asset.review_status==="rejected")?"Rejected — choose a new photo":matching.length?"Upload incomplete — select the photo again":"Not uploaded"}</strong><label><span>{ready?"Add another": "Upload"} {label.toLowerCase()}</span><input aria-label={label} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.currentTarget.value="";if(file)onUpload(file,purpose);}}/></label></div>;
 })}<button disabled={busy} onClick={onRefresh}>Refresh photo approval</button></div></section>;
}

export function TrainingOwnerHandover({record,busy,onRecord}:{record?:{durationMinutes:number;completedAt:number}|null;busy:boolean;onRecord:(minutes:number)=>void}){
 const[minutes,setMinutes]=useState("");
 return <section className={styles.precheck}><span>OWNER HANDOVER</span>{record?<p role="status">Owner handover recorded: {record.durationMinutes} minutes.</p>:<><p>Complete at least 15 minutes with the owner to explain progress and homework, then record the time spent.</p><label>Minutes completed<input type="number" min="15" step="1" value={minutes} onChange={event=>setMinutes(event.target.value)}/></label><button disabled={busy||!Number.isInteger(Number(minutes))||Number(minutes)<15} onClick={()=>onRecord(Number(minutes))}>Record completed handover</button></>}</section>;
}
