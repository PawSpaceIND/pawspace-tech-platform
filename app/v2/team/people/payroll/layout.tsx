"use client";
import{useEffect,useState,type ReactNode}from"react";
import StaffModule from"../../../../components/staff-workspace/StaffModule";
import V2PayrollGovernancePanel from"./V2PayrollGovernancePanel";

type Run={id:string;status:string;period_start:number;period_end:number};
type Emp={id:string;employee_code:string;display_name:string};
type Payload={runs:Run[];employees:Emp[]};

export default function V2PayrollLayout({children}:{children:ReactNode}){
 const[data,setData]=useState<Payload|null>(null),[error,setError]=useState("");
 useEffect(()=>{let active=true;void fetch("/api/payroll",{cache:"no-store"}).then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.error||"Payroll load failed");if(active)setData(p.data);}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));});return()=>{active=false;};},[]);
 return <StaffModule>{children}<main style={{maxWidth:1180,margin:"0 auto",padding:"0 20px 40px",fontFamily:"inherit"}}>{error&&<p role="alert">{error}</p>}{data?<V2PayrollGovernancePanel runs={data.runs} employees={data.employees}/>:<p>Loading V2 HR/payroll controls…</p>}</main></StaffModule>;
}
