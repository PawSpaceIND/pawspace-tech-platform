"use client";

import Link from "next/link";
import styles from "./admin.module.css";

export default function BoardingPanel({notify}:{notify:(message:string)=>void}){
  return <div className={styles.boardingOps}>
    <section className={styles.boardingMetrics}><article><span>Live stays</span><strong>18</strong><small>27 pets in care</small></article><article><span>Tonight&apos;s occupancy</span><strong>76%</strong><small>42 of 55 host spaces</small></article><article><span>Pending requests</span><strong>14</strong><small>6 need action in 30 min</small></article><article><span>Care Card compliance</span><strong>94%</strong><small>3 updates overdue</small></article></section>
    <section className={styles.boardingGrid}>
      <div className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>LIVE COMMAND CENTRE</span><h2>Stays needing attention</h2></div><button className={styles.textButton} onClick={()=>notify("All live stays opened")}>View all →</button></div><div className={styles.stayRows}>{[
        ["PSB-1039","Bruno · Maya & Rohan","Medication update due in 18 min","On track"],
        ["PSB-1041","Pixel · Sana F.","Drop-off completed · care plan signed","On track"],
        ["PSB-1037","Leo · Arjun & Tara","Photo update overdue by 24 min","Needs action"],
        ["PSB-1035","Coco · Neha P.","Customer requested early pickup","Support"],
      ].map(row=><button key={row[0]} onClick={()=>notify(`${row[0]} stay workspace opened`)}><b>{row[0]}</b><div><strong>{row[1]}</strong><small>{row[2]}</small></div><span className={row[3]==="On track"?styles.stayGood:styles.stayWarn}>{row[3]}</span></button>)}</div></div>
      <aside className={styles.detailPanel}><div className={styles.panelHead}><div><span className={styles.kicker}>SAFETY DESK</span><h2>Escalations</h2></div><b className={styles.attentionCount}>2 open</b></div><div className={styles.safetyItem}><span>!</span><div><strong>Customer cannot reach host</strong><small>PSB-1029 · 7 min ago</small></div><button onClick={()=>notify("Priority incident room opened")}>Resolve</button></div><div className={styles.safetyItem}><span>⚕</span><div><strong>Pet appetite concern</strong><small>PSB-1034 · vet notes attached</small></div><button onClick={()=>notify("Care escalation opened")}>Review</button></div><div className={styles.safetySla}><strong>24/7 Care SLA</strong><span>Median first response</span><b>3m 42s</b></div></aside>
    </section>
    <section className={styles.boardingGrid}>
      <div className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>HOST NETWORK</span><h2>Verification pipeline</h2></div><button className={styles.primaryButton} onClick={()=>notify("New host application opened")}>＋ Add host</button></div><div className={styles.hostPipeline}>{[["Applications","38","12 new"],["Identity check","21","4 flagged"],["Home inspection","16","8 today"],["Trial booking","9","3 passed"],["Ready to go live","6","Publish profiles"]].map(item=><article key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong><small>{item[2]}</small></article>)}</div><div className={styles.hostReview}><span>SF</span><div><strong>Sana F. · HSR Layout</strong><small>Home inspected · first aid complete · background check clear</small></div><b>96 / 100</b><button onClick={()=>notify("Host approved and profile published")}>Approve</button></div></div>
      <aside className={styles.panel}><div className={styles.panelHead}><div><span className={styles.kicker}>UPCOMING</span><h2>Meet & Greets</h2></div></div>{[["4:00 PM","Coco ↔ Maya","Indiranagar"],["5:00 PM","Bruno ↔ Sana","HSR Layout"],["6:30 PM","Milo ↔ Arjun","Video introduction"]].map(item=><div className={styles.meetRow} key={item[0]}><b>{item[0]}</b><div><strong>{item[1]}</strong><small>{item[2]}</small></div><button onClick={()=>notify("Meet & Greet details opened")}>Open</button></div>)}</aside>
    </section>
    <section className={styles.hostPerformance}><div><span>HOST QUALITY & PAYOUTS</span><h2>Grow supply without losing trust</h2><p>Rank hosts using care completion, repeat families, response time, cancellations, incidents and verified home capacity.</p></div><div><article><span>Top host payout</span><strong>₹48,920</strong><small>Maya & Rohan · July</small></article><article><span>Repeat booking rate</span><strong>42%</strong><small>Network average</small></article><article><span>Cancellation rate</span><strong>1.8%</strong><small>Target under 2%</small></article></div><Link href="/host">Open host app →</Link></section>
  </div>
}
