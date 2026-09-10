"use client";
import { useState } from "react";
import { SchedulingDayBoard } from "../team/scheduling/page";
import SchedulingRulesPanel from "./scheduling-rules-panel";
import AssignmentPolicyPanel from "./assignment-policy-panel";
import ProviderCapacityPanel from "./provider-capacity-panel";
import styles from "./scheduling-control-panel.module.css";

export default function SchedulingControlPanel({notify}:{notify:(message:string)=>void}) {
  const [tab,setTab]=useState<"desk"|"rules"|"policy"|"capacity">("desk");
  return <div className={styles.wrap}>
    <section className={styles.hero}><div><span>OPERATIONS · SCHEDULING</span><h2>Scheduling control</h2><p>Read saved provider reservations and manage the scheduling constraints used for future matching.</p></div></section>
    <div className={styles.tabs} aria-label="Scheduling views">
      <button aria-pressed={tab==="desk"} className={tab==="desk"?styles.active:""} onClick={()=>setTab("desk")}>Reservation day board</button>
      <button aria-pressed={tab==="rules"} className={tab==="rules"?styles.active:""} onClick={()=>setTab("rules")}>Scheduling rules</button>
      <button aria-pressed={tab==="policy"} className={tab==="policy"?styles.active:""} onClick={()=>setTab("policy")}>Assignment policy</button>
      <button aria-pressed={tab==="capacity"} className={tab==="capacity"?styles.active:""} onClick={()=>setTab("capacity")}>Provider capacity</button>
    </div>
    {tab==="desk"?<SchedulingDayBoard embedded/>:tab==="rules"?<SchedulingRulesPanel notify={notify}/>:tab==="policy"?<AssignmentPolicyPanel notify={notify}/>:<ProviderCapacityPanel notify={notify}/>}
  </div>;
}
