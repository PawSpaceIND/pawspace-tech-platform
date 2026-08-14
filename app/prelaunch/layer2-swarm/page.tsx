"use client";

import {useState} from "react";
import Link from "next/link";

type ApiResponse={data?:Record<string,unknown>;error?:string;productionReady?:boolean};
type Summary={status?:string;runId?:string;totalBookings?:number;assertions?:Array<{name:string;pass:boolean;severity:string;detail:string}>;knownBoundary?:string;productionReady?:boolean;uatClosed?:boolean};

async function post(body:Record<string,unknown>){const response=await fetch("/api/prelaunch-booking-swarm",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const payload=await response.json() as ApiResponse;if(!response.ok)throw new Error(payload.error||`Layer 2 request failed (${response.status})`);return payload.data||{};}

export default function Layer2SwarmPage(){
 const[running,setRunning]=useState(false),[runId,setRunId]=useState(""),[progress,setProgress]=useState("Not started"),[summary,setSummary]=useState<Summary|null>(null),[error,setError]=useState("");
 async function run(){setRunning(true);setError("");setSummary(null);try{
  const start=await post({action:"start",confirm:"RUN_LAYER_2_UAT_SWARM"}),id=String(start.runId||"");if(!id)throw new Error("Layer 2 start did not return a run ID");setRunId(id);let next=Number(start.nextIndex||0),total=Number(start.total||60);setProgress(`${next}/${total} real D1 bookings`);
  while(next<total){const batch=await post({action:"batch",runId:id,batchSize:4});next=Number(batch.nextIndex||0);total=Number(batch.total||total);setProgress(`${next}/${total} real D1 bookings`);}
  setProgress("Finalizing cross-system reconciliation…");const result=await post({action:"finalize",runId:id});setSummary(result as Summary);setProgress(`Layer 2 ${String(result.status||"complete")}`);
 }catch(value){setError(value instanceof Error?value.message:String(value));setProgress("Layer 2 stopped on a defect");}finally{setRunning(false);}}
 const failures=summary?.assertions?.filter(item=>!item.pass)??[];
 return <main style={{maxWidth:1050,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}>
  <p><Link href="/prelaunch">← PRE-LAUNCH hub</Link></p><p style={{fontWeight:800,letterSpacing:1.1}}>PAWSPACE · LAYER 2 LIVE UAT</p><h1>Real D1 booking swarm</h1>
  <p style={{maxWidth:840,lineHeight:1.6}}>Creates 60 marked UAT bookings across Grooming, Training, Boarding and Pet Sitting inside the hosted PawSpace D1 database, replays every booking for idempotency, injects controlled delay/refund failures, and reconciles Customer, Ops, Finance and Revenue records. Payments remain <b>uat_sandbox</b>; notifications remain queued; production readiness is never granted by this test.</p>
  <div style={{border:"1px solid #dcece5",borderRadius:14,padding:18,margin:"20px 0",background:"white"}}><button disabled={running} onClick={run} style={{padding:"12px 18px",fontWeight:800,cursor:running?"wait":"pointer"}}>{running?"Layer 2 running…":"Run Layer 2 — 60 real bookings"}</button><p><b>Status:</b> {progress}</p>{runId?<p><b>Run ID:</b> <code>{runId}</code></p>:null}{error?<p style={{fontWeight:800}}>FAIL: {error}</p>:null}</div>
  {summary?<section><h2>{summary.status==="PASSED"?"PASS":"FAIL"} · {summary.totalBookings} D1 bookings</h2><p><b>Production ready:</b> NO · <b>UAT closed:</b> NO</p><div style={{display:"grid",gap:8}}>{summary.assertions?.map(item=><article key={item.name} style={{border:"1px solid #dcece5",borderRadius:10,padding:12,background:"white"}}><b>{item.pass?"✅":"❌"} {item.name}</b><div>{item.detail}</div><small>{item.severity}</small></article>)}</div>{failures.length?<p><b>{failures.length} reconciliation issue(s) need engineering action before Layer 2 can close.</b></p>:<p><b>All blocker assertions passed. Human staff UAT evidence is still required separately.</b></p>}<p>{summary.knownBoundary}</p></section>:null}
 </main>;
}
