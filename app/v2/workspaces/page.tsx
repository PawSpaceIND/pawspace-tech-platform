import Link from "next/link";
import styles from "./page.module.css";
const modules=[
 {href:"/v2",eyebrow:"CUSTOMER",title:"Customer App",body:"V2 services, account, activity, AI and booking journeys."},
 {href:"/v2/partner",eyebrow:"PARTNER",title:"Partner App",body:"Canonical jobs, GPS, proof, lifecycle and settlement views."},
 {href:"/v2/crm",eyebrow:"CRM",title:"Customer & Revenue CRM",body:"Customers, pets, leads, CX engine and live chat."},
 {href:"/v2/control-center",eyebrow:"FOUNDER / OPS",title:"Booking Command Center",body:"Bookings, payments, proof, tickets, communications and exceptions."},
 {href:"/v2/chat",eyebrow:"AI",title:"PawSpace AI",body:"Public service guidance and authenticated customer assistance."}
];
export default function V2Workspaces(){return <main className={styles.page}><div className={styles.shell}><header className={styles.top}><Link href="/v2" className={styles.brand}><img src="/assets/pawspace-icon.jpeg" alt=""/><span>PawSpace V2</span></Link><Link href="/v2" className={styles.back}>← Customer home</Link></header><section className={styles.hero}><small>PAWSPACE OPERATING SYSTEM</small><h1>One build. Every workspace.</h1><p>These V2 entry points reuse the proven PawSpace customer, partner, CRM and operations modules. Permissions and canonical APIs remain unchanged.</p></section><section className={styles.grid}>{modules.map(m=><Link key={m.href} href={m.href} className={styles.card}><span>{m.eyebrow}</span><h2>{m.title}</h2><p>{m.body}</p><b>Open workspace →</b></Link>)}</section><div className={styles.note}><b>Access remains role-governed.</b> Partner and staff workspaces still depend on their existing authenticated sessions and API permissions; this hub does not grant access.</div></div></main>}
