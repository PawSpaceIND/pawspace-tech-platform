"use client";
import{useCallback,useEffect,useMemo,useState}from"react";
import Link from"next/link";
import{Badge,EmptyState,PageHeader,StatCard}from"../../components/ui";
import styles from"../team-console.module.css";

type Employee={id:string;employee_code:string;display_name:string;work_email:string;phone?:string|null;employment_status:string;title?:string|null;team_code?:string|null;cost_centre_code?:string|null;location_code?:string|null;sensitiveMasked:boolean};

const WORKSPACES=[
 ["/team/people/time","Attendance & leave"],
 ["/team/people/payroll","Payroll"],
 ["/team/people/incentives","Incentives"],
 ["/team/people/service-incentives","Groomer / trainer / sales incentives"],
 ["/team/people/manager-dashboard","Manager & founder dashboard"],
 ["/team/people/finance","Finance + statutory"],
 ["/team/people/reports","People reports"],
 ["/team/performance","Employee performance"],
] as const;

// A field the HR record has never been given reads as "not set" rather than as a demand on the reader.
const value=(input:unknown)=>{const text=String(input??"").trim();return text?{text,set:true}:{text:"not set",set:false};};

export default function PeoplePage(){
 const[employees,setEmployees]=useState<Employee[]>([]);
 const[error,setError]=useState("");
 const[loading,setLoading]=useState(true);
 const[query,setQuery]=useState("");

 const load=useCallback(async()=>{
  try{
   const response=await fetch("/api/people-foundation",{cache:"no-store"});
   const payload=await response.json().catch(()=>({}) as Record<string,unknown>) as {data?:{employees?:Employee[]};error?:string};
   if(!response.ok)throw new Error(payload.error||`People load failed (HTTP ${response.status})`);
   setEmployees(payload.data?.employees||[]);setError("");
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setLoading(false);}
 },[]);
 useEffect(()=>{const timer=setTimeout(()=>{void load();},0);return()=>clearTimeout(timer);},[load]);

 const shown=useMemo(()=>{
  const needle=query.trim().toLowerCase();
  if(!needle)return employees;
  return employees.filter(row=>[row.display_name,row.employee_code,row.work_email,row.team_code,row.title].some(field=>String(field||"").toLowerCase().includes(needle)));
 },[employees,query]);
 const active=employees.filter(row=>row.employment_status==="active").length;
 const unconfigured=employees.filter(row=>!row.title||!row.team_code).length;

 return <main className={styles.shell}>
  <PageHeader
    eyebrow="PAWSPACE · PEOPLE"
    title="Employee and employment system of record"
    description="Canonical employee identity, effective-dated employment, attendance and leave, payroll, governed incentives, finance/statutory integration and source-derived reporting share one People foundation. External statutory submission and live bank transmission remain disabled."
    actions={<Badge tone={active?"success":"warning"} dot>{active} active</Badge>}
  />
  <nav className={styles.nav} aria-label="People workspaces">
   <Link href="/team">← Team</Link>{WORKSPACES.map(([href,label])=><Link key={href} href={href}>{label}</Link>)}
  </nav>

  {error?<div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b></div>:null}

  <section className={styles.tiles}>
   <StatCard label="Employees" value={employees.length} />
   <StatCard label="Active" value={active} />
   <StatCard label="Awaiting role or team" value={unconfigured} meta="HR fields not set" />
   <StatCard label="Sensitive fields" value={employees.some(row=>row.sensitiveMasked)?"masked":"visible"} />
  </section>

  <section className={styles.panel}>
   <label className={styles.field}>Find someone<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="name, code, email, team or role" /></label>
  </section>

  {loading?<EmptyState title="Loading the employee record" body="Reading the canonical People foundation…" />
   :shown.length===0?<EmptyState title={employees.length?`No one matches “${query}”`:"No employees on record yet"} body={employees.length?"Clear the search to see the full directory.":"Employees appear here once they exist in the canonical People foundation."} />
   :<div className={styles.recordList}>{shown.map(row=>{
     const title=value(row.title),team=value(row.team_code),cost=value(row.cost_centre_code),location=value(row.location_code),phone=value(row.phone);
     return <article key={row.id} className={styles.record}>
      <div className={styles.recordHead}>
       <div className={styles.stack}>
        <small>{row.employee_code} · <Badge tone={row.employment_status==="active"?"success":"neutral"}>{row.employment_status}</Badge></small>
        <h3>{row.display_name}</h3>
       </div>
       <code className={styles.muted}>{row.id}</code>
      </div>
      <div className={styles.recordMeta}>
       <span><b>Role:</b> <span className={title.set?"":styles.muted}>{title.text}</span></span>
       <span><b>Team:</b> <span className={team.set?"":styles.muted}>{team.text}</span></span>
       <span><b>Work email:</b> {row.work_email}</span>
       <span><b>Phone:</b> <span className={phone.set?"":styles.muted}>{phone.text}</span></span>
       <span><b>Cost centre:</b> <span className={cost.set?"":styles.muted}>{cost.text}</span></span>
       <span><b>Location:</b> <span className={location.set?"":styles.muted}>{location.text}</span></span>
      </div>
     </article>;
   })}</div>}

  <footer className={styles.footnote}>
   Sensitive fields are masked unless the actor holds the permission to see them.<br />
   <b>People Gates 1–6:</b> IMPLEMENTED FOR UAT · <b>External statutory/live bank:</b> NOT ENABLED · <b>Production ready:</b> NO
  </footer>
 </main>;
}
