"use client";
import Link from"next/link";
import{useVisibleStaffLinks}from"../components/hub-workspace-links";
import type{Permission}from"../../lib/platform-security";

/**
 * The company front-door map. It is linked from the PUBLIC marketing footer and from the customer
 * app, so a customer and a signed-out visitor both land here - and it listed Control Center, Team,
 * Finance, People and CRM to all of them. Every one of those refuses a customer, so five of the nine
 * cards were a "Permission denied" behind a `who:` label that read like an invitation.
 *
 * `permission` is the permission the DESTINATION's API demands to load, read off that route:
 * /api/control-tower is audit.view, /api/operations-overview behind /team is dashboard.view,
 * /api/crm GET is customers.view, Finance is finance.view and People is people.view. An entry
 * without one is an open page (the website, the customer app, the partner app, /prelaunch) and is
 * always listed.
 */
type Entry={title:string;href:string;who:string;detail:string;permission?:Permission};
const entries:Entry[]=[
 {title:"Customer app",href:"/mobile-app",who:"Customers",detail:"Book, manage pets, subscriptions, payments, activity and support."},
 {title:"Website",href:"/",who:"Customers",detail:"Public PawSpace service discovery and booking entry."},
 {title:"Partner app",href:"/partner-app",who:"All service partners",detail:"One role-based app for groomers, trainers, hosts, sitters, walkers and delivery partners; future roles such as vets belong here too."},
 {title:"CRM & Revenue",href:"/crm",who:"Sales / CX",detail:"Customers, leads, pipeline, opportunities and revenue execution. Revenue Mission Control is a governed staff module within this operating layer.",permission:"customers.view"},
 {title:"Control Center",href:"/control",who:"Founder / Admin",detail:"Governance, launch readiness, approvals, pricing, integrations, security and company controls.",permission:"audit.view"},
 {title:"Operations & Sales",href:"/team",who:"Staff",detail:"Role-based front door for Operations, Sales, CX and Marketing workspaces.",permission:"dashboard.view"},
 {title:"Finance",href:"/team/finance",who:"Finance",detail:"Collections, payouts, refunds, reconciliation and close controls.",permission:"finance.view"},
 {title:"People / HR",href:"/team/people",who:"People",detail:"Employees, attendance, payroll, performance and people operations.",permission:"people.view"},
 {title:"Pre-launch / Test",href:"/prelaunch",who:"UAT team",detail:"Controlled access map, Test Lab, Regression Lab and release evidence."},
];
const gated=entries.filter((entry):entry is Entry&{permission:Permission}=>Boolean(entry.permission));

export default function BusinessHub(){
 const visible=useVisibleStaffLinks(gated),allowed=new Set(visible.map(entry=>entry.href));
 const shown=entries.filter(entry=>!entry.permission||allowed.has(entry.href));
 return <main style={{maxWidth:1100,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}><header style={{marginBottom:24}}><p style={{fontWeight:800,letterSpacing:1.1,margin:0}}>PAWSPACE BUSINESS HUB</p><h1 style={{margin:"8px 0"}}>Every front door your role can open.</h1><p style={{maxWidth:780,lineHeight:1.6}}>Deep routes remain available for modules and troubleshooting, but they are not separate products. Day-to-day work should start from these business surfaces. Staff workspaces are listed only for the roles that can open them.</p></header><section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:12}}>{shown.map(entry=><Link key={entry.href} href={entry.href} style={{display:"block",padding:18,border:"1px solid #ddd",borderRadius:12,textDecoration:"none",color:"inherit",background:"white"}}><small>{entry.who}</small><h2 style={{fontSize:19,margin:"6px 0"}}>{entry.title} →</h2><p style={{margin:0,lineHeight:1.5}}>{entry.detail}</p><code style={{display:"block",marginTop:10}}>{entry.href}</code></Link>)}</section></main>;
}
