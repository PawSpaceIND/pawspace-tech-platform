import Link from"next/link";

type Entry={title:string;href:string;who:string;detail:string};
const entries:Entry[]=[
 {title:"Customer app",href:"/mobile-app",who:"Customers",detail:"Book, manage pets, subscriptions, payments, activity and support."},
 {title:"Website",href:"/",who:"Customers",detail:"Public PawSpace service discovery and booking entry."},
 {title:"Partner app",href:"/partner-app",who:"All service partners",detail:"One role-based app for groomers, trainers, hosts, sitters, walkers and delivery partners; future roles such as vets belong here too."},
 {title:"CRM & Revenue",href:"/crm",who:"Sales / CX",detail:"Customers, leads, pipeline, opportunities and revenue execution. Revenue Mission Control is a governed staff module within this operating layer."},
 {title:"Control Center",href:"/control",who:"Founder / Admin",detail:"Governance, launch readiness, approvals, pricing, integrations, security and company controls."},
 {title:"Operations & Sales",href:"/team",who:"Staff",detail:"Role-based front door for Operations, Sales, CX and Marketing workspaces."},
 {title:"Finance",href:"/team/finance",who:"Finance",detail:"Collections, payouts, refunds, reconciliation and close controls."},
 {title:"People / HR",href:"/team/people",who:"People",detail:"Employees, attendance, payroll, performance and people operations."},
 {title:"Pre-launch / Test",href:"/prelaunch",who:"UAT team",detail:"Controlled access map, Test Lab, Regression Lab and release evidence."},
];

export default function BusinessHub(){return <main style={{maxWidth:1100,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}><header style={{marginBottom:24}}><p style={{fontWeight:800,letterSpacing:1.1,margin:0}}>PAWSPACE BUSINESS HUB</p><h1 style={{margin:"8px 0"}}>Run the company from nine front doors.</h1><p style={{maxWidth:780,lineHeight:1.6}}>Deep routes remain available for modules and troubleshooting, but they are not separate products. Day-to-day work should start from these business surfaces.</p></header><section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:12}}>{entries.map(entry=><Link key={entry.href} href={entry.href} style={{display:"block",padding:18,border:"1px solid #dcece5",borderRadius:12,textDecoration:"none",color:"inherit",background:"white"}}><small>{entry.who}</small><h2 style={{fontSize:19,margin:"6px 0"}}>{entry.title} →</h2><p style={{margin:0,lineHeight:1.5}}>{entry.detail}</p><code style={{display:"block",marginTop:10}}>{entry.href}</code></Link>)}</section></main>}
