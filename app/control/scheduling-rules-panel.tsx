"use client";
import {useEffect,useState} from "react";
import {apiSend} from "../../lib/api-fetch";
import styles from "./scheduling-control-panel.module.css";

type Rule={id:string;name:string;service_code:string|null;city_id:string|null;zone_id:string|null;active:number};
const services=[['grooming','Grooming'],['dog_training','Training'],['boarding','Boarding'],['pet_sitting','Sitting'],['dog_walking','Walking'],['pet_taxi','Taxi']];
async function readRules(){
  const data=await apiSend<Rule[]>("/api/scheduling-rules",{cache:"no-store"});
  if(!Array.isArray(data)||data.some(rule=>!rule||typeof rule.id!=="string"||typeof rule.name!=="string"))throw new Error("Scheduling rules could not be read. Refresh to try again.");
  return data;
}
export default function SchedulingRulesPanel({notify}:{notify:(message:string)=>void}) {
  const [rules,setRules]=useState<Rule[]|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [name,setName]=useState(""),[service,setService]=useState("grooming"),[zone,setZone]=useState("blr-east"),[field,setField]=useState("rating"),[value,setValue]=useState("");
  useEffect(()=>{let active=true;readRules().then(data=>{if(active)setRules(data);}).catch(problem=>{if(active)setError(problem instanceof Error?problem.message:"Unable to read rules");}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  async function refresh(){setLoading(true);setRules(null);setError("");try{setRules(await readRules());}catch(problem){setError(problem instanceof Error?problem.message:"Unable to refresh rules");}finally{setLoading(false);}}
  async function save(){
    if(busy||loading||rules===null)return;
    const numeric=Number(value);
    if(!name.trim()||!value.trim()||(field!=="model"&&(!Number.isFinite(numeric)||numeric<0||(field==="rating"&&numeric>5)||(field==="qualityScore"&&numeric>100)||(field==="capacity"&&(!Number.isInteger(numeric)||numeric<1))))){setError("Enter a rule name and a valid value for the selected constraint.");return;}
    setBusy(true);setError("");
    try{
      const saved=await apiSend<{id:string}>("/api/scheduling-rules",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:name.trim(),serviceCode:service,cityId:"blr",zoneId:zone||undefined,conditions:[{code:`custom_${field}`,field,operator:field==="model"?"eq":"gte",value:field==="model"?value:numeric}]})});
      if(!saved?.id)throw new Error("The save could not be confirmed. Refresh the rules before trying again.");
      notify("Scheduling rule saved.");setName("");await refresh();
    }catch(problem){setError(problem instanceof Error?problem.message:"The save could not be confirmed. Refresh before retrying.");}finally{setBusy(false);}
  }
  async function toggle(rule:Rule){
    if(busy||loading)return;
    // Disabling takes a constraint out of live provider matching straight away, so
    // confirm that direction. Re-enabling only restores a constraint and needs no gate.
    if(rule.active===1&&typeof window!=="undefined"&&!window.confirm(`Disable "${rule.name}"? Future provider matching will stop applying it.`))return;
    setBusy(true);setError("");
    try{await apiSend("/api/scheduling-rules",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({id:rule.id,active:rule.active!==1})});notify(rule.active===1?"Rule disabled.":"Rule enabled.");await refresh();}
    catch(problem){setError(problem instanceof Error?problem.message:"Rule update could not be confirmed. Refresh before retrying.");}finally{setBusy(false);}
  }
  return <>
    {error&&<p role="alert">{error}</p>}
    <section className={styles.two}>
      <div className={styles.panel}><h3>Add a scheduling constraint</h3><p>Changes apply to future provider matching in the selected location.</p>
        <fieldset disabled={busy||loading||rules===null} style={{border:0,padding:0,minWidth:0}}>
          <label>Rule name<input value={name} onChange={event=>setName(event.target.value)}/></label>
          <label>Service<select aria-label="Service" value={service} onChange={event=>setService(event.target.value)}>{services.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
          <label>Location<select aria-label="Location" value={zone} onChange={event=>setZone(event.target.value)}><option value="blr-east">Bengaluru · East zone</option><option value="blr-south">Bengaluru · South zone</option><option value="">All Bengaluru</option></select></label>
          <label>Constraint<select aria-label="Constraint" value={field} onChange={event=>{setField(event.target.value);setValue(event.target.value==="model"?"commission":"");}}><option value="rating">Minimum rating (0–5)</option><option value="qualityScore">Minimum quality score (0–100)</option><option value="capacity">Minimum capacity</option><option value="model">Provider model</option></select></label>
          <label>Required value{field==="model"?<select aria-label="Required value" value={value} onChange={event=>setValue(event.target.value)}><option value="commission">Commission</option><option value="full_time">Full-time</option></select>:<input inputMode="decimal" value={value} onChange={event=>setValue(event.target.value)}/>}</label>
          <button className={styles.save} onClick={()=>void save()}>{busy?"Saving…":"Save & activate rule"}</button>
        </fieldset>
      </div>
      <div className={styles.panel}><header><div><h3>Saved scheduling rules</h3><p>{rules?`${rules.length} saved rules`:"Rule list not loaded"}</p></div><button disabled={busy||loading} onClick={()=>void refresh()}>Refresh</button></header>
        {loading?<p>Loading rules…</p>:rules===null?<p>Rules are unavailable. Refresh to try again.</p>:rules.length===0?<p>No custom scheduling rules are saved.</p>:rules.map(rule=><article className={styles.choice} key={rule.id}><div><strong>{rule.name}</strong><p>{rule.service_code||"All services"} · {rule.city_id||"All cities"} · {rule.zone_id||"All zones"}</p><small>{rule.active===1?"Active":"Inactive"}</small></div><button disabled={busy} onClick={()=>void toggle(rule)}>{rule.active===1?"Disable":"Enable"}</button></article>)}
      </div>
    </section>
  </>;
}
