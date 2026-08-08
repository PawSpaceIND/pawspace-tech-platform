import Link from"next/link";

type Surface={label:string;href:string;audience:string;note:string};
const surfaces:Surface[]=[
 {label:"Business Hub",href:"/business",audience:"Leadership",note:"Nine front doors for day-to-day PawSpace management."},
 {label:"Customer app",href:"/mobile-app",audience:"Customer",note:"Primary customer mobile web/app surface."},
 {label:"Partner app",href:"/partner-app",audience:"All service partners",note:"One role-based partner interface; do not operate from separate groomer/trainer/host URLs."},
 {label:"CRM & Revenue",href:"/crm",audience:"Sales / CX",note:"Customers, leads, pipeline and revenue execution."},
 {label:"Control Center",href:"/control",audience:"Founder / Admin",note:"Governance, launch readiness, approvals, configuration and system controls."},
 {label:"Operations & Sales",href:"/team",audience:"Staff",note:"Role-based staff front door for Sales, Operations, CX and Marketing."},
 {label:"Finance",href:"/team/finance",audience:"Finance",note:"Collections, payouts, refunds, reconciliation and close."},
 {label:"People / HR",href:"/team/people",audience:"People",note:"Employees, attendance, payroll and performance."},
 {label:"Revenue Mission UAT",href:"/team/revenue-mission",audience:"Sales leadership",note:"Governed ₹2 lakh mission UAT and source-derived revenue truth."},
 {label:"Test Lab",href:"/test-lab",audience:"UAT",note:"Synthetic end-to-end test environment."},
 {label:"Regression Lab",href:"/regression-lab",audience:"UAT",note:"Cross-flow regression workspace."},
];

export default function PrelaunchAccessHub(){return <main style={{maxWidth:1100,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}><header style={{marginBottom:24}}><p style={{fontWeight:800,letterSpacing:1.2,margin:0}}>PAWSPACE · PRE-LAUNCH ACCESS HUB</p><h1 style={{margin:"8px 0"}}>Test from a small set of front doors.</h1><p style={{maxWidth:820,lineHeight:1.6}}>Deep routes still exist for internal modules, but they are not separate products. Start from Business Hub for normal operations and use Test/Regression only for UAT evidence.</p><p><b>Revenue engineering/CI: READY</b> · <b>Staff UAT: REQUIRED</b> · <b>Production launch: separate gate</b></p></header><section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(270px,1fr))",gap:12}}>{surfaces.map(surface=><article key={surface.href} style={{border:"1px solid #ddd",borderRadius:12,padding:16,background:"white"}}><small>{surface.audience}</small><h2 style={{fontSize:18,margin:"6px 0"}}><Link href={surface.href}>{surface.label}</Link></h2><p style={{margin:0,lineHeight:1.5}}>{surface.note}</p><code style={{display:"block",marginTop:10}}>{surface.href}</code></article>)}</section></main>}
