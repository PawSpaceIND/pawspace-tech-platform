import Link from"next/link";

type Surface={label:string;href:string;audience:string;note:string;active?:boolean};

const surfaces:Surface[]=[
 {label:"Customer app",href:"/mobile-app",audience:"Customer",note:"Primary customer mobile web/app surface."},
 {label:"CRM",href:"/crm",audience:"Sales / CX",note:"Customer and revenue CRM workspace."},
 {label:"Revenue Mission Control",href:"/team/revenue-mission",audience:"Sales leadership",note:"₹2 lakh UAT mission, revenue truth, pipeline and execution queues."},
 {label:"Team home",href:"/team",audience:"Staff",note:"Role-based team workspace entry point."},
 {label:"Control Center",href:"/control",audience:"Founder / Admin",note:"Company control plane, launch readiness, pricing, finance and governance panels."},
 {label:"Integration readiness",href:"/control/integrations",audience:"Founder / Engineering",note:"Canonical integration-readiness control plane."},
 {label:"System integration status",href:"/system-integration",audience:"Engineering / Admin",note:"Runtime integration and credential-presence diagnostics."},
 {label:"Admin OS",href:"/admin",audience:"Admin",note:"Administrative operating workspace."},
 {label:"Operations",href:"/ops",audience:"Operations",note:"Operations command workspace."},
 {label:"Booking Command Center",href:"/booking-command-center",audience:"Operations / Leadership",note:"Canonical booking operations and exception view."},
 {label:"Finance",href:"/team/finance",audience:"Finance",note:"Finance team workspace."},
 {label:"Sales",href:"/team/sales",audience:"Sales",note:"Sales team route."},
 {label:"Customer Experience",href:"/team/customer-experience",audience:"CX",note:"Customer Experience team route."},
 {label:"People",href:"/team/people",audience:"People / HR",note:"People team route."},
 {label:"Marketing",href:"/team/marketing",audience:"Marketing",note:"Marketing team route."},
 {label:"Partner app",href:"/partner-app",audience:"Service partner",note:"Partner/provider application surface."},
 {label:"Groomer workspace",href:"/groomer",audience:"Groomer",note:"Grooming provider workspace."},
 {label:"Trainer workspace",href:"/trainer",audience:"Trainer",note:"Training provider workspace."},
 {label:"Boarding host",href:"/host",audience:"Host",note:"Boarding host workspace."},
 {label:"Pet sitter",href:"/sitter",audience:"Sitter",note:"Pet Sitting provider workspace."},
 {label:"Test Lab",href:"/test-lab",audience:"Staff UAT",note:"Synthetic end-to-end test environment; no live impact."},
 {label:"Regression Command Centre",href:"/regression-lab",audience:"Staff UAT",note:"Cross-flow regression workspace."},
 {label:"Platform API",href:"/platform-api",audience:"Engineering / Admin",note:"Platform API inspection surface."},
 {label:"Account",href:"/account",audience:"Signed-in user",note:"User/account surface."},
 {label:"Grooming / home",href:"/",audience:"Customer",note:"Root PawSpace customer surface."},
 {label:"Boarding",href:"/boarding",audience:"Customer",note:"Boarding customer surface."},
 {label:"Training",href:"/training",audience:"Customer",note:"Training customer surface."},
 {label:"Pet Sitting",href:"/sitting",audience:"Customer",note:"Pet Sitting customer surface."},
 {label:"Dog Walking",href:"/walking",audience:"Customer",note:"Walking surface; separate gate remains before inclusion in a pilot."},
 {label:"Food",href:"/food",audience:"Customer",note:"Food surface; separate stacked workstream."},
 {label:"Pet Taxi",href:"/taxi",audience:"Customer",note:"Taxi surface; outside current active pre-live priority."},
];

export default function PrelaunchAccessHub(){
 return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}>
  <header style={{marginBottom:24}}><p style={{fontWeight:800,letterSpacing:1.2,margin:0}}>PAWSPACE · PRE-LAUNCH ACCESS HUB</p><h1 style={{margin:"8px 0"}}>UAT access map</h1><p style={{maxWidth:820}}>Use this page to open the PawSpace surfaces that must be checked before controlled launch review. Engineering availability does not equal production approval.</p><p><b>Production ready: NO</b> · <b>Revenue Mission engineering/CI: READY</b> · Staff UAT evidence remains required.</p></header>
  <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(250px,1fr))",gap:12}}>{surfaces.map(surface=><article key={surface.href} style={{border:"1px solid #ddd",borderRadius:12,padding:16}}><small>{surface.audience}</small><h2 style={{fontSize:18,margin:"6px 0"}}><Link href={surface.href}>{surface.label}</Link></h2><p style={{margin:0,lineHeight:1.5}}>{surface.note}</p><code style={{display:"block",marginTop:10}}>{surface.href}</code></article>)}</section>
 </main>;
}
