"use client";
import Link from "next/link";
import {useState} from "react";
import styles from "./live-tracking-panel.module.css";

type Action={label:string;href:string;kind?:"primary"|"secondary";external?:boolean};
export type LiveTrackingPanelProps={
 title:string;
 eyebrow?:string;
 state:string;
 mapUrl?:string|null;
 mapKey?:string|number;
 etaMinutes?:number|null;
 distanceKm?:number|null;
 providerLabel?:string|null;
 detail?:string;
 live?:boolean;
 actions?:Action[];
 onRecenter?:()=>void;
};

export default function LiveTrackingPanel({title,eyebrow="LIVE TRACKING",state,mapUrl,mapKey,etaMinutes,distanceKm,providerLabel,detail,live=false,actions=[],onRecenter}:LiveTrackingPanelProps){
 const eta=etaMinutes!=null&&Number.isFinite(Number(etaMinutes))?Math.max(1,Math.round(Number(etaMinutes))):null;
 // The map endpoint answers 409/502/503 while coordinates or Google are unavailable; never show a broken image.
 const [failedUrl,setFailedUrl]=useState<string|null>(null),showMap=Boolean(mapUrl)&&failedUrl!==mapUrl;
 const distance=distanceKm!=null&&Number.isFinite(Number(distanceKm))?Number(distanceKm):null;
 return <section className={styles.panel} aria-label={title}>
   <div className={styles.mapWrap}>
     {showMap?<img key={mapKey} className={styles.map} src={mapUrl!} alt={"Live route map for "+title} onError={()=>setFailedUrl(mapUrl??null)}/>:<div className={styles.placeholder}>The live route map will appear after PawSpace receives a trusted provider location and a route is available.</div>}
     {showMap&&<div className={styles.mapShade}/>}
     {live&&<span className={styles.livePill}><i/>LIVE</span>}
     {showMap&&onRecenter&&<button type="button" className={styles.recenter} onClick={onRecenter} aria-label="Recenter live map">⌖</button>}
   </div>
   <div className={styles.body}>
     <div className={styles.head}><div><span className={styles.eyebrow}>{eyebrow}</span><h3>{title}</h3></div><span className={styles.state}>{state.replaceAll("_"," ")}</span></div>
     {(eta!==null||distance!==null||providerLabel)&&<div className={styles.metrics}>
       {eta!==null&&<div><small>ETA</small><b>{eta} min</b></div>}
       {distance!==null&&<div><small>DISTANCE</small><b>{distance.toFixed(1)} km</b></div>}
       {providerLabel&&<div><small>PROVIDER</small><b>{providerLabel}</b></div>}
     </div>}
     {detail&&<p className={styles.copy}>{detail}</p>}
     {!!actions.length&&<div className={styles.actions}>{actions.map(action=>action.external?<a key={action.label} href={action.href} target="_blank" rel="noreferrer" className={action.kind==="primary"?styles.primary:styles.secondary}>{action.label}</a>:<Link key={action.label} href={action.href} className={action.kind==="primary"?styles.primary:styles.secondary}>{action.label}</Link>)}</div>}
   </div>
 </section>;
}
