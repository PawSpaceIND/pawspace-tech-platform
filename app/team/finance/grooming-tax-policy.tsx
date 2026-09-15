"use client";
import{useState}from"react";
import{hasPermission}from"../../../lib/platform-security";
import{useStaffPermissions}from"../../components/hub-workspace-links";

/*
 * THE 409's OWN REMEDY HAD NO SCREEN. [R3-C/F8]
 *
 * /api/assisted-orders refuses an order it cannot price with: "An assisted order cannot be created
 * until the governed Grooming price for this city can be computed - publish the city GST policy
 * through Grooming finance (save_tax_policy) first." That refusal is right, and until now it named
 * something no operator could do: `save_tax_policy` was reachable for Grooming over the API only. The
 * one save_tax_policy control in the codebase belonged to Training
 * (app/team/finance/training/page.tsx), and it publishes a TRAINING policy, which prices nothing in
 * Grooming. Measured on the UAT database: grooming_tax_policies had no row for `blr` at all, so every
 * assisted order 409'd, and the only way out was a curl.
 *
 * Gated on finance.manage - the permission app/api/grooming-finance's POST actually demands - through
 * the same client gate the hubs use. A control that is always shown and always refused teaches people
 * to ignore refusals; the server check is of course still the real one.
 *
 * A form rather than the Training screen's chain of window.prompt() calls: the mode is a choice
 * between two named options, not a string somebody has to spell, and the difference between them is
 * the difference between every assisted order working and none of them working.
 */
export type GroomingTaxPolicyRow={city_id?:unknown;tax_mode?:unknown;tax_rate?:unknown;status?:unknown;version?:unknown;effective_from?:unknown;updated_by?:unknown;reason?:unknown};

/** Exported so a test can run the gate without a renderer, like visibleHubLinks. */
export const canPublishGroomingTaxPolicy=(permissions:string[])=>hasPermission(permissions,"finance.manage");

const card={margin:"22px 0 0",padding:18,background:"white",border:"1px solid #e5dcef",borderRadius:14} as const;
const eyebrow={display:"block",fontWeight:800,letterSpacing:1.1,fontSize:12,color:"#6c39a8"} as const;
const field={display:"grid",gap:4,fontSize:13,color:"#24133f"} as const;
const input={padding:"9px 11px",borderRadius:9,border:"1px solid #d9cde8",fontSize:14} as const;
const row={display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:12,marginTop:12} as const;
const primary={padding:"11px 16px",borderRadius:10,border:"none",background:"#4b168c",color:"white",fontWeight:700,cursor:"pointer"} as const;
const today=()=>new Date().toISOString().slice(0,10);

export default function GroomingTaxPolicyControl({policies,onSaved}:{policies:GroomingTaxPolicyRow[];onSaved:()=>void|Promise<void>}){
  const{permissions,loaded}=useStaffPermissions();
  const[cityId,setCityId]=useState("blr");
  const[taxMode,setTaxMode]=useState<"inclusive"|"exclusive">("inclusive");
  const[taxRate,setTaxRate]=useState("18");
  const[effectiveFrom,setEffectiveFrom]=useState(today);
  const[reason,setReason]=useState("");
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState("");
  const[notice,setNotice]=useState("");

  async function publish(){
    setError("");setNotice("");setBusy(true);
    try{
      const response=await fetch("/api/grooming-finance",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({action:"save_tax_policy",cityId:cityId.trim().toLowerCase(),taxMode,taxRate:Number(taxRate),effectiveFrom,reason:reason.trim()})});
      const body=await response.json() as{data?:{version?:number};error?:string};
      if(!response.ok)throw new Error(body.error||"The Grooming GST policy could not be published");
      setNotice(`Published ${taxMode} ${taxRate}% GST for ${cityId.trim().toLowerCase()} (version ${body.data?.version??"?"}). Assisted orders for this city can be priced now.`);
      setReason("");
      await onSaved();
    }catch(problem){setError(problem instanceof Error?problem.message:"The Grooming GST policy could not be published");}
    finally{setBusy(false);}
  }

  const published=policies.filter(policy=>String(policy.status||"")==="published");
  return <section style={card} aria-label="Grooming GST policy">
    <span style={eyebrow}>GROOMING FINANCE · CITY GST POLICY</span>
    <h2 style={{margin:"6px 0 2px",fontSize:20}}>City GST policy for Grooming</h2>
    <p style={{margin:"0 0 10px",color:"#6d6379",fontSize:13,lineHeight:1.5}}>Grooming quotes and assisted orders cannot be priced for a city until its GST policy is published here. <b>Inclusive</b> means the catalogue price already contains GST; <b>exclusive</b> means GST is added on top of it.</p>

    {published.length===0
      ? <p style={{margin:"0 0 6px",color:"#8a5a12",background:"#fff7e8",border:"1px solid #efd4a5",borderRadius:10,padding:"10px 12px",fontSize:13}}>No city has a published Grooming GST policy. Every assisted order will be refused until one is published.</p>
      : <ul style={{margin:"0 0 6px",paddingLeft:18,fontSize:13,color:"#24133f"}}>{published.map(policy=><li key={String(policy.city_id)}><b>{String(policy.city_id)}</b>: {String(policy.tax_mode)} {String(policy.tax_rate)}% · version {String(policy.version)} · from {String(policy.effective_from||"—")}{policy.updated_by?` · ${String(policy.updated_by)}`:""}</li>)}</ul>}

    {!loaded?<p style={{margin:0,color:"#6d6379",fontSize:13}}>Loading what your role can change…</p>
     :!canPublishGroomingTaxPolicy(permissions)?<p style={{margin:0,color:"#6d6379",fontSize:13}}>Publishing a GST policy needs the finance.manage permission. Ask Finance to publish it.</p>
     :<>
      <div style={row}>
        <label style={field}>City<input style={input} value={cityId} onChange={event=>setCityId(event.target.value)} placeholder="blr"/></label>
        <label style={field}>GST mode<select style={input} value={taxMode} onChange={event=>setTaxMode(event.target.value==="exclusive"?"exclusive":"inclusive")}><option value="inclusive">Inclusive — GST is inside the catalogue price</option><option value="exclusive">Exclusive — GST is added on top</option></select></label>
        <label style={field}>GST rate %<input style={input} value={taxRate} inputMode="decimal" onChange={event=>setTaxRate(event.target.value)} placeholder="18"/></label>
        <label style={field}>Effective from<input style={input} type="date" value={effectiveFrom} onChange={event=>setEffectiveFrom(event.target.value)}/></label>
      </div>
      <label style={{...field,marginTop:12}}>Reason / approval reference (8 characters or more)<input style={input} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Finance approval FIN-2026-014"/></label>
      <div style={{marginTop:14}}><button type="button" style={primary} disabled={busy} onClick={()=>void publish()}>{busy?"Publishing…":"Publish Grooming GST policy"}</button></div>
     </>}

    {error&&<p role="alert" style={{marginTop:12,color:"#a01c1c"}}>{error}</p>}
    {notice&&<p style={{marginTop:12,color:"#1c6b3a"}}>{notice}</p>}
  </section>;
}
