import Link from "next/link";
import { StatCard } from "../components/ui";
import { testCustomers, testDataSummary } from "../../lib/pawspace-test-data";

type Surface={label:string;href:string;audience:string;note:string;check:string};
const surfaces:Surface[]=[
 {label:"Customer App",href:"/mobile-app",audience:"Customer",note:"All eight current service families from one mobile/web app.",check:"Packages, address autocomplete, booking clarity, activity, pets and account."},
 {label:"Partner App",href:"/partner-app",audience:"Provider",note:"Full field workspace for every provider role: owned jobs, availability, payouts, verification and profile. Partner Mobile is the lighter mobile entry point into the same app.",check:"Owned jobs, GPS/ETA, navigation, earnings and profile."},
 {label:"Business Hub",href:"/business",audience:"Leadership",note:"Leadership front door for operating PawSpace.",check:"Navigation to company workspaces without memorising deep URLs."},
 {label:"Team",href:"/team",audience:"Staff",note:"One staff front door for Sales, Operations, CX, Finance, People and Marketing.",check:"Role navigation, Booking Command Center, recovery and day-to-day workflows."},
 {label:"CRM / Sales",href:"/team/sales",audience:"Sales / CRM",note:"Canonical Customer 360 and governed Revenue Intelligence worklist. The old standalone /crm screen now redirects here - it was the legacy predecessor, not a separate tool.",check:"Customer record, consent, data quality, opportunities, claim/complete actions."},
 {label:"Control Center",href:"/control",audience:"Founder / Admin",note:"Governance, launch gates, pricing, finance, access, audit and system controls. Its compact Finance and Booking summaries link out to the full Team Finance and Booking Command Center tools for deep work - two tiers of the same data, not duplicates.",check:"Readable fonts/sidebar, configuration, approvals, security and evidence views."},
 {label:"AI Governance",href:"/team/ai",audience:"AI / CX staff",note:"Human review queue and AI safety status.",check:"Human approval/rejection and autonomous sensitive-action blocking."},
 {label:"Test Lab",href:"/test-lab",audience:"Human UAT",note:"100 synthetic Bengaluru customers across all eight service families.",check:"Create controlled synthetic bookings and inspect cross-system projections."},
];
// Only routes that genuinely redirect belong here. /crm and /trainer were listed as retired but were
// afterwards built out into real, integrated modules (/crm reads /api/crm + /api/revenue-crm;
// /trainer runs the canonical training session lifecycle, evidence and provider earnings), so
// claiming they are retired sent testers away from working surfaces.
const retiredRoutes:{from:string;to:string;why:string}[]=[
 {from:"/groomer",to:"/partner-app",why:"Hardcoded prototype - jobs, customers and earnings were literals, completion only moved browser state and proof photos were never uploaded. The Partner App workspace does this for real."},
];

const addressChecks=["Greenage","Indiranagar","Koramangala","HSR Layout","Whitefield"];
const sampleIds=["TST-001","TST-002","TST-003","TST-004","TST-005","TST-006","TST-007","TST-008"];
const samples=sampleIds.map(id=>testCustomers.find(customer=>customer.id===id)).filter((customer):customer is NonNullable<typeof customer>=>Boolean(customer));
const productionGaps=[
 "Publish and independently verify the exact certified SHA on PawSpace Sites with D1 DB attached.",
 "Complete human cross-role UAT, negative permissions, replay/idempotency and recovery evidence.",
 "Complete the hosted real-D1 60-booking swarm and preserve evidence.",
 "Verify required real provider integrations; production payment/payout/comms/KYC/e-sign/telephony/external AI remain disabled until approved.",
 "Complete security/privacy, production identity/MFA, monitoring, backup/restore and disaster-recovery evidence.",
 "Complete Finance/CA-approved tax/accounting configuration and professional sign-off.",
 "Complete browser/device matrix, real-device customer/provider rehearsal and controlled Bengaluru pilot.",
 "Make a separate explicit production approval/launch decision; green CI or UAT does not authorize public launch.",
];

const card={border:"1px solid #dcece5",borderRadius:14,padding:16,background:"white"} as const;
export default function PrelaunchAccessHub(){return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px 64px",fontFamily:"system-ui,sans-serif",color:"#06231c"}}>
 <header style={{marginBottom:24}}><p style={{fontWeight:900,letterSpacing:1.2,margin:0,color:"#1f6b57"}}>PAWSPACE · FINAL HUMAN UAT HUB</p><h1 style={{margin:"8px 0",fontSize:36}}>Test the whole platform from eight front doors.</h1><p style={{maxWidth:900,lineHeight:1.6,color:"#667571"}}>Use this page for founder visual review and staff UAT navigation. Deep routes still exist, but they are modules—not separate products. Synthetic test data is clearly labelled and must never be treated as live operating truth.</p><p style={{padding:"10px 12px",background:"#fff4d9",borderRadius:10}}><b>Engineering candidate: READY FOR HUMAN UAT after exact-SHA deployment verification.</b> · <b>PRODUCTION READY = FALSE.</b></p></header>

 <section><div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"end",marginBottom:12}}><div><small style={{fontWeight:800,color:"#1f6b57"}}>FINAL REVIEW LINKS</small><h2 style={{margin:"5px 0"}}>Open only these eight.</h2></div><span style={{color:"#687874"}}>Everything else should be reachable from these hubs.</span></div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12}}>{surfaces.map(surface=><article key={surface.href} style={card}><small style={{fontWeight:800,color:"#1f6b57"}}>{surface.audience}</small><h3 style={{fontSize:19,margin:"7px 0"}}><Link href={surface.href}>{surface.label} →</Link></h3><p style={{margin:"0 0 8px",lineHeight:1.45}}>{surface.note}</p><small style={{display:"block",color:"#667571",lineHeight:1.45}}><b>Check:</b> {surface.check}</small><code style={{display:"block",marginTop:10,padding:"6px 8px",background:"#f2f7f5",borderRadius:7}}>{surface.href}</code></article>)}</div><div style={{marginTop:16,padding:14,background:"#fff8ee",borderRadius:10}}><small style={{fontWeight:800,color:"#a34f00"}}>RETIRED / REDIRECTED - old links still work but now forward on</small><div style={{display:"grid",gap:5,marginTop:8}}>{retiredRoutes.map(r=><p key={r.from} style={{margin:0,fontSize:14}}><code style={{background:"white",padding:"2px 6px",borderRadius:5}}>{r.from}</code> → <code style={{background:"white",padding:"2px 6px",borderRadius:5}}>{r.to}</code> · <span style={{color:"#667571"}}>{r.why}</span></p>)}</div></div></section>

 <section style={{marginTop:32}}><small style={{fontWeight:800,color:"#1f6b57"}}>CONTROLLED TEST DATA</small><h2 style={{margin:"5px 0"}}>Synthetic dataset already loaded for visual/UAT testing.</h2><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,margin:"14px 0"}}>{[["Customers",testDataSummary.customers],["Linked pets",testDataSummary.pets],["Service families",testDataSummary.services],["Subscribers",testDataSummary.subscribers]].map(([label,value])=><StatCard key={String(label)} label={String(label)} value={value} />)}</div><p style={{lineHeight:1.6}}>The Test Lab covers New, Repeat, Subscriber and Dormant segments; Dog, Cat and Mixed households; one to four pets; Paid online, Pay after service and Subscription-credit simulations. It sends <b>no live calls, messages or payments</b>.</p>
 <div style={{overflowX:"auto",...card}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}><thead><tr>{["Test ID","Primary service","Segment","Area","Pets","Payment"].map(h=><th key={h} style={{textAlign:"left",padding:"8px",borderBottom:"1px solid #dcece5"}}>{h}</th>)}</tr></thead><tbody>{samples.map(customer=><tr key={customer.id}><td style={{padding:8}}><code>{customer.id}</code></td><td style={{padding:8}}>{customer.service}</td><td style={{padding:8}}>{customer.segment}</td><td style={{padding:8}}>{customer.area}</td><td style={{padding:8}}>{customer.petCount} · {customer.species}</td><td style={{padding:8}}>{customer.payment}</td></tr>)}</tbody></table></div>
 <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}><article style={card}><b>Address-autocomplete checks</b><p style={{lineHeight:1.5}}>Type these into customer address/location fields and confirm suggestions appear where applicable:</p><p>{addressChecks.map(x=><code key={x} style={{display:"inline-block",margin:"3px 5px 3px 0",padding:"4px 7px",background:"#f2f7f5",borderRadius:6}}>{x}</code>)}</p></article><article style={card}><b>Identity boundary</b><p style={{lineHeight:1.5}}>Customer/provider/staff ownership and permission tests require the relevant verified UAT identity/session. Do not substitute legacy synthetic provider names or browser-only demo records as canonical UAT evidence.</p></article></div></section>

 <section style={{marginTop:32}}><small style={{fontWeight:800,color:"#1f6b57"}}>WHAT IS READY NOW</small><h2 style={{margin:"5px 0"}}>Engineering modules ready for deployed human testing.</h2><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(250px,1fr))",gap:10}}>{[
  ["Customer experience","8-service customer app; Grooming/Training/Boarding/Sitting embedded; Walking/Food/Relocation linked; Taxi controlled-review only."],
  ["Partner experience","Canonical onboarding/work orders plus Partner Mobile field UI with user-triggered GPS/ETA and earnings view."],
  ["CRM / Revenue","Customer 360, consent/data-quality context, governed revenue worklist and Revenue Mission engineering lane."],
  ["Operations / CX","Booking Command Center, provider assignment/recovery, customer experience, cases/escalation and alerts engineering surfaces."],
  ["Finance","Collections/reconciliation, partner settlement, GST/accounting/statutory UAT controls with fail-closed configuration boundaries."],
  ["People / Marketing","People/payroll UAT foundation and governed campaign/audience controls with live delivery disabled."],
  ["AI / Handoff","Shared AI governance/orchestrator engineering lane, human review and handoff boundaries; production external AI/voice/comms disabled."],
  ["Control / Analytics","Founder controls, business reporting, integration readiness, audit/release and analytics foundations."],
 ].map(([title,note])=><article key={title} style={card}><b>{title}</b><p style={{marginBottom:0,lineHeight:1.5}}>{note}</p></article>)}</div></section>

 <section style={{marginTop:32}}><small style={{fontWeight:800,color:"#a34f00"}}>STILL REQUIRED FOR FINAL PRODUCTION</small><h2 style={{margin:"5px 0"}}>Do not close these from screenshots or green CI.</h2><ol style={{lineHeight:1.7,paddingLeft:22}}>{productionGaps.map(gap=><li key={gap}>{gap}</li>)}</ol><p style={{padding:12,background:"#f2f7f5",borderRadius:10}}><b>Human-test rule:</b> screenshots are useful defect/evidence inputs, but formal PASS also needs exact deployed SHA, actor/role, canonical record IDs where applicable, negative/replay outcomes and the required hosted real-D1 evidence.</p></section>
</main>}
