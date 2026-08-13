"use client";
import { FormEvent, useEffect, useMemo, useState } from "react";
import css from "./launch-controls.module.css";
import { isFullAccessRole } from "../../lib/platform-security";

type Role={code:string;name:string;description:string;permissions:string[]};

/**
 * Only roles this screen is actually permitted to hand out. The API refuses a full-access role from
 * user management, so offering Founder or Superuser in these dropdowns only invited a request that
 * comes back 400 — and it previously filtered Founder alone, leaving Superuser (also ["*"]) on offer
 * as though it were an ordinary role.
 */
const assignableRoles=(data:Data|null)=>(data?.roles||[]).filter(role=>!isFullAccessRole(role.permissions));
/** The stored permissions for a user's current role, so a full-access holder can be shown as locked. */
const u_role=(data:Data|null,roleCode:string)=>(data?.roles||[]).find(role=>role.code===roleCode)?.permissions||[];
type User={id:string;email:string;name:string;role_code:string;status:string};
type Data={current:{name:string;email:string;roleCode:string;permissions:string[]};permissionCatalog:string[];roles:Role[];users:User[]};

export default function AccessControlPanel(){
  const[data,setData]=useState<Data|null>(null);const[selected,setSelected]=useState("admin");const[toast,setToast]=useState("");const[busy,setBusy]=useState(false);
  const load=async()=>{try{const response=await fetch("/api/platform-governance");if(!response.ok)throw new Error();setData(await response.json());}catch{setToast("Open this Site inside the PawSpace workspace to manage access.");}};
  useEffect(()=>{let active=true;void (async()=>{try{const response=await fetch("/api/platform-governance");if(!response.ok)throw new Error();const body=await response.json();if(active)setData(body);}catch{if(active)setToast("Open this Site inside the PawSpace workspace to manage access.");}})();return()=>{active=false;};},[]);
  const role=useMemo(()=>data?.roles.find(r=>r.code===selected),[data,selected]);
  async function create(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);const fd=new FormData(e.currentTarget);const res=await fetch("/api/platform-governance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create_user",name:fd.get("name"),email:fd.get("email"),roleCode:fd.get("role")})});const body=await res.json();setToast(res.ok?"User created with controlled access":body.error||"Unable to create user");if(res.ok){e.currentTarget.reset();void load();}setBusy(false);}
  async function changeUser(id:string,roleCode:string,status="active"){const res=await fetch("/api/platform-governance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"update_user",id,roleCode,status})});setToast(res.ok?"User access updated":"Protected or unauthorised change blocked");if(res.ok)void load();}
  const metrics=[["Founder","1","Protected identity"],["Privileged APIs","10","Server-enforced RBAC"],["Write safety","Same-origin","Cross-origin writes blocked"],["Audit","Every request","Allowed, failed or denied"]];
  return <div className={css.stack}>
    <section className={css.hero}><div><span>IDENTITY · LEAST PRIVILEGE · FOUNDER PROTECTION</span><h2>Control every user and every permission.</h2><p>Every privileged API passes through one server-side access gateway. Unknown identities are denied, disabled users are blocked, and role checks happen before finance, CRM, marketing, pricing, scheduling or launch data is read or changed.</p></div><div className={css.badge}>{data?`${data.users.length} provisioned identities`:"Secure workspace sign-in"}</div></section>
    <section className={css.metrics}>{metrics.map(x=><article key={x[0]}><span>{x[0]}</span><strong>{x[1]}</strong><small>{x[2]}</small></article>)}</section>
    <section className={css.grid}><div className={css.panel}><div className={css.head}><div><span className={css.kicker}>ROLE DIRECTORY</span><h3>Who can do what</h3></div></div>{data?.roles.map(r=><button className={css.role} key={r.code} onClick={()=>setSelected(r.code)}><div><strong>{r.name}</strong><p>{r.description}</p><div className={css.chips}>{r.permissions.slice(0,6).map(p=><span key={p} className={isFullAccessRole(r.permissions)?css.protected:""}>{p==="*"?"All permissions":p.replaceAll("_"," ")}</span>)}</div></div><b>{r.code===selected?"Selected":"Open →"}</b></button>)}</div>
      <aside className={css.panel}><span className={css.kicker}>SELECTED ROLE</span><h3>{role?.name||"Admin"}</h3><p>{role?.description}</p><div className={css.permissionList}>{data?.permissionCatalog.map(p=><label key={p}><input type="checkbox" checked={role?.permissions.includes("*")||role?.permissions.includes(p)||false} readOnly disabled/>{p.replaceAll("_"," ")}</label>)}</div>
        {/* This said "Permission editing is available to Founder/Superuser and is audit logged" while
            every checkbox was readOnly and nothing on the page could save one. Worse, an edit made
            through the API would not have survived: built-in roles are seeded system_role=1 and
            ensureSecurityTables restores them from the platform definition on every fresh Worker
            isolate. The list is a reference view, and now says so. */}
        <p className={css.warning}>{isFullAccessRole(role?.permissions)?"Full-access roles cannot be changed anywhere in the platform.":"Built-in role permissions are fixed by the platform definition and restored on every deploy — this list is a reference view, not an editor."}</p></aside></section>
    <section className={css.grid}><div className={css.panel}><div className={css.head}><div><span className={css.kicker}>USER DIRECTORY</span><h3>Workspace identities</h3></div></div>{data?.users.length?data.users.map(u=><div className={css.user} key={u.id}><div><strong>{u.name}</strong><small>{u.email}</small></div><select value={u.role_code} disabled={isFullAccessRole(u_role(data,u.role_code))} onChange={e=>changeUser(u.id,e.target.value)}>{assignableRoles(data).map(r=><option key={r.code} value={r.code}>{r.name}</option>)}{isFullAccessRole(u_role(data,u.role_code))&&<option value={u.role_code}>{u.role_code}</option>}</select><button className={css.danger} disabled={u.role_code==="founder"} onClick={()=>changeUser(u.id,u.role_code,"disabled")}>Disable</button></div>):<div className={css.empty}>No employee identities are provisioned yet.</div>}</div>
      <aside className={css.panel}><span className={css.kicker}>CREATE USER</span><h3>Add a controlled identity</h3><form className={css.form} onSubmit={create}><label>Name<input name="name" required placeholder="Team member name"/></label><label>Email<input name="email" type="email" required placeholder="name@pawspace.in"/></label><label className={css.wide}>Role<select name="role">{assignableRoles(data).map(r=><option key={r.code} value={r.code}>{r.name}</option>)}</select></label><button className={`${css.primary} ${css.wide}`} disabled={busy}>{busy?"Creating…":"Create user"}</button></form></aside></section>
    {toast&&<div className={css.toast}>{toast}</div>}
  </div>;
}
