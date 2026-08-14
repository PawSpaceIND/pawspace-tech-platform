"use client";
import Link from"next/link";
import{useEffect,useState}from"react";
import{StatCard}from"../../../components/ui";

type Row=Record<string,unknown>;
type Overview={blocks:Row[];features:Array<Row&{key:string;enabled:number;description:string;cityIds:string[];serviceCodes:string[]}>;events:Row[];metrics:{published:number;draft:number;enabledFeatures:number}};

const label=(value:unknown)=>String(value||"—").replaceAll("_"," ").replace(/\b\w/g,letter=>letter.toUpperCase());

async function loadOverview():Promise<Overview>{const response=await fetch("/api/content-controls?view=admin",{cache:"no-store"});const body=await response.json();if(!response.ok)throw new Error(body.error||"Unable to load content controls");return body.data as Overview;}
async function act(input:Record<string,unknown>){const response=await fetch("/api/content-controls",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json();if(!response.ok)throw new Error(body.error||"Content action failed");return body.data as Row;}

export default function ContentControlsPage(){
 const[overview,setOverview]=useState<Overview|null>(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
 const[title,setTitle]=useState(""),[bodyMd,setBodyMd]=useState(""),[placement,setPlacement]=useState("home_banner"),[cityId,setCityId]=useState(""),[serviceCode,setServiceCode]=useState("");
 const[featureKey,setFeatureKey]=useState(""),[featureDescription,setFeatureDescription]=useState(""),[featureCities,setFeatureCities]=useState("");
 function refresh(){loadOverview().then(data=>{setOverview(data);setError("");}).catch(problem=>setError(problem instanceof Error?problem.message:"Unable to load content controls"));}
 useEffect(()=>{loadOverview().then(setOverview).catch(problem=>setError(problem instanceof Error?problem.message:"Unable to load content controls"));},[]);
 async function run(input:Record<string,unknown>,done:string){setBusy(true);setError("");setMessage("");try{await act(input);setMessage(done);refresh();}catch(problem){setError(problem instanceof Error?problem.message:"Content action failed");}finally{setBusy(false);}}
 return <main style={{maxWidth:1400,margin:"0 auto",padding:24,fontFamily:"system-ui",display:"grid",gap:16}}>
  <header><Link href="/team/marketing">← Marketing home</Link><p>TEAM OS · MARKETING · CONTENT & FEATURES</p><h1>Content & feature controls</h1><p>Versioned, placement-scoped content with an explicit publish window, and governed feature flags with city/service rollout scopes. The public read serves published copy only — drafts never leak.</p></header>
  {overview&&<section style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(140px,1fr))",gap:12}}>
   {[["Published blocks",overview.metrics.published],["Drafts",overview.metrics.draft],["Enabled features",overview.metrics.enabledFeatures]].map(([name,value])=><StatCard key={String(name)} label={String(name)} value={value as number}/>)}
  </section>}
  {error&&<p role="alert">{error}</p>}{message&&<p>{message}</p>}
  <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))",gap:16,alignItems:"start"}}>
   <article style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
    <h2>Author a content block</h2>
    <input placeholder="Title" value={title} onChange={event=>setTitle(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <textarea placeholder="Body (markdown)" value={bodyMd} onChange={event=>setBodyMd(event.target.value)} style={{width:"100%",minHeight:80,marginBottom:6}}/>
    <select value={placement} onChange={event=>setPlacement(event.target.value)} style={{width:"100%",marginBottom:6}}>{["home_banner","service_page","faq","announcement"].map(option=><option key={option} value={option}>{label(option)}</option>)}</select>
    <input placeholder="City scope (blank = all cities)" value={cityId} onChange={event=>setCityId(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Service scope (blank = all services)" value={serviceCode} onChange={event=>setServiceCode(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <button disabled={busy} onClick={()=>void run({action:"save_block",title,bodyMd,placement,cityId:cityId||null,serviceCode:serviceCode||null},"Content saved as draft")}>Save draft</button>
   </article>
   <article style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
    <h2>Feature control</h2>
    <input placeholder="Feature key (e.g. show_referral_banner)" value={featureKey} onChange={event=>setFeatureKey(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="Description" value={featureDescription} onChange={event=>setFeatureDescription(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <input placeholder="City scope, comma-separated (blank = everywhere)" value={featureCities} onChange={event=>setFeatureCities(event.target.value)} style={{width:"100%",marginBottom:6}}/>
    <div style={{display:"flex",gap:8}}>
     <button disabled={busy} onClick={()=>void run({action:"set_feature",key:featureKey,description:featureDescription,enabled:true,cityIds:featureCities.split(",").map(city=>city.trim()).filter(Boolean)},"Feature enabled")}>Enable</button>
     <button disabled={busy} onClick={()=>void run({action:"set_feature",key:featureKey,description:featureDescription,enabled:false,cityIds:featureCities.split(",").map(city=>city.trim()).filter(Boolean)},"Feature disabled")}>Disable</button>
    </div>
    <ul>{(overview?.features??[]).map(feature=><li key={feature.key}><code>{feature.key}</code> · {Number(feature.enabled)===1?"ON":"off"} · {feature.cityIds.length?`cities: ${feature.cityIds.join(", ")}`:"all cities"}</li>)}</ul>
   </article>
  </section>
  {overview&&<section style={{border:"1px solid #dcece5",borderRadius:14,padding:16}}>
   <h2>Content blocks</h2>
   {overview.blocks.map(block=><div key={String(block.id)} style={{borderBottom:"1px solid #e9f1ee",padding:"8px 0"}}>
    <b>{String(block.title)}</b> · {label(block.placement)} · v{Number(block.version)} · {label(block.status)} · {block.city_id?`city ${String(block.city_id)}`:"all cities"} · {block.service_code?String(block.service_code):"all services"}
    <div style={{display:"flex",gap:8,marginTop:4}}>
     {String(block.status)==="draft"&&<button disabled={busy} onClick={()=>void run({action:"publish_block",blockId:block.id},"Content published")}>Publish</button>}
     {String(block.status)!=="archived"&&<button disabled={busy} onClick={()=>void run({action:"archive_block",blockId:block.id},"Content archived")}>Archive</button>}
    </div>
   </div>)}
  </section>}
  <footer><small>Public reads at /api/content-controls serve published, in-window blocks and server-evaluated feature flags only.</small></footer>
 </main>;
}
