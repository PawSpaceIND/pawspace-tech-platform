"use client";
import {useState} from "react";
import type {TrainingEvidenceAsset,TrainingEvidencePurpose} from "../../lib/training-session-client";
import styles from "./session-proof.module.css";

type PhotoPurpose = "before_service" | "after_service";
export function TrainingEvidenceControls({assets,purpose,canUpload,busy,error,onUpload,onRefresh}:{assets:TrainingEvidenceAsset[];purpose:PhotoPurpose;canUpload:boolean;busy:boolean;error:string;onUpload:(file:File,purpose:TrainingEvidencePurpose)=>void;onRefresh:()=>void}){
 const matching=assets.filter(asset=>asset.purpose===purpose),ready=matching.some(asset=>asset.proofReady),pending=matching.some(asset=>asset.access_status!=="pending_upload"&&asset.review_status!=="rejected"),unstored=matching.some(asset=>asset.objectStored===false);
 const label=purpose==="before_service"?"Before photo":"After photo";
 return <section className={styles.media} aria-label={label}><div><span>SESSION PHOTO</span><h3>{label}</h3><p>{purpose==="before_service"?"Save attendance and safety before capturing the before photo.":"Record the pet-parent handover before capturing the after photo."} Both photos need independent approval before completion.</p>{error&&<p role="alert">{error}</p>}
  <div><strong>{label}: {unstored?(ready?"Approved — hash only":"Hash recorded — file storage is not connected in this environment; the image was not kept"):ready?"Approved":pending?"Awaiting approval / release":matching.some(asset=>asset.review_status==="rejected")?"Rejected — choose a new photo":matching.length?"Upload incomplete — select the photo again":"Not uploaded"}</strong><label><span>{ready?"Add another":"Upload"} {label.toLowerCase()}</span><input aria-label={label} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy||!canUpload} onChange={event=>{const file=event.target.files?.[0];event.currentTarget.value="";if(file&&canUpload&&!busy)onUpload(file,purpose);}}/></label></div>
  <p>Check photo status reloads updates from the independent scan and approval review.</p><button disabled={busy} onClick={onRefresh}>Check photo status</button>
 </div></section>;
}

export function TrainingOwnerHandover({record,busy,reminderDue=false,onRecord}:{record?:{durationMinutes?:number;completedAt:number}|null;busy:boolean;reminderDue?:boolean;onRecord:(minutes?:number)=>void}){
 const[confirmed,setConfirmed]=useState(false),[minutes,setMinutes]=useState(record?.durationMinutes===undefined?"":String(record.durationMinutes));
 const duration=minutes.trim()===""?undefined:Number(minutes),valid=duration===undefined||Number.isSafeInteger(duration)&&duration>=0;
 return <section className={styles.precheck}><span>OWNER HANDOVER</span>{record&&<p role="status">Pet-parent handover recorded{record.durationMinutes===undefined?"":` · ${record.durationMinutes} minutes`}. You can correct it until the session is complete.</p>}<p role={reminderDue?"status":undefined}>{reminderDue?"It is time to hand over progress and homework before this session ends.":"Allow time within the session to explain progress, demonstrate practice and hand over homework to the pet parent."}</p>
  <label>Handover minutes (optional)<input aria-label="Handover minutes" type="number" min="0" step="1" value={minutes} disabled={busy} onChange={event=>{setMinutes(event.target.value);setConfirmed(false);}}/></label>
  {!valid&&<p role="alert">Enter whole minutes of zero or greater.</p>}<label><input aria-label="Confirm handover completed" type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/> I completed the pet-parent handover</label><button disabled={busy||!confirmed||!valid} onClick={()=>{setConfirmed(false);onRecord(duration);}}>{record?"Update handover":"Confirm completed handover"}</button>
 </section>;
}

export function TrainingVideoControls({assets,busy,onUpload}:{assets:TrainingEvidenceAsset[];busy:boolean;onUpload:(file:File,purpose:TrainingEvidencePurpose)=>void}){
 const videos=assets.filter(asset=>asset.purpose==="training_video");
 return <section className={styles.media}><div><span>TRAINING VIDEO</span><h3>Record the training practice</h3><p>Upload a short training video. Private storage and independent approval are required before secure playback is available.</p><label>Training video<input aria-label="Training video" type="file" accept="video/mp4,video/webm" disabled={busy} onChange={event=>{const file=event.target.files?.[0];event.currentTarget.value="";if(file)onUpload(file,"training_video");}}/></label>{videos.map(asset=><div key={asset.id}><p>{asset.objectStored===false?"Video was not stored; retry when private storage is available.":asset.proofReady?"Video approved for secure access.":"Video awaiting upload, scan or independent approval."}</p>{asset.objectStored===true&&asset.proofReady&&<video controls preload="none" playsInline src={`/api/training-session-media/content?id=${encodeURIComponent(asset.id)}`}/>}</div>)}</div></section>;
}
