"use client";
import{useCallback,useEffect,useState}from"react";
import Link from"next/link";
import{Badge,Button,EmptyState,PageHeader,StatCard}from"../../../components/ui";
import styles from"./ad-spend.module.css";

type Source={id:string;provider:string;external_account_id:string;label:string;status:string;currency:string;write_mode:string;max_daily_budget:number|null;supermetrics_ds_id:string|null;last_sync_at:number|null;last_synced_through:string|null;last_error:string|null};
type Readiness={provider:string;requiredCredentials:string[];missingCredentials:string[]};
type Link_={provider:string;external_campaign_id:string;external_campaign_name:string|null;campaign_id:string;campaign_name:string|null};
type SpendRow={campaign_id:string;provider:string;spend:number;first_day:string;last_day:string};
type Unmapped={provider:string;external_campaign_id:string;external_campaign_name:string|null;spend:number};
type Run={id:string;provider:string;window_start:string;window_end:string;status:string;days:number;campaigns:number;spend:number;error:string|null;created_at:number};
type Change={id:string;provider:string;external_campaign_id:string;change_type:string;status:string;reason:string;approval_reference:string;actor_id:string;error:string|null;created_at:number};
type Directory={sources:Source[];links:Link_[];runs:Run[];spendByCampaign:SpendRow[];unmappedSpend:Unmapped[];changes:Change[];readiness:Readiness[];writeCapableProviders:string[]};

const PROVIDERS=[["google_ads","Google Ads"],["meta_ads","Meta Ads"],["supermetrics","Supermetrics"]] as const;
const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:0}).format(v||0);
const when=(v:number|null)=>v?new Date(v).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"never";
const today=()=>new Date().toISOString().slice(0,10);
const daysAgo=(n:number)=>new Date(Date.now()-n*86_400_000).toISOString().slice(0,10);

/**
 * Two ways in - straight to Google Ads and Meta, or through Supermetrics - so the same spend can be
 * pulled either way and compared before anyone commits to one. Spend never appears without
 * credentials behind it, and the write side (pausing a campaign, moving a budget) is off until it is
 * deliberately switched on for an account.
 */
export default function AdSpendPage(){
 const[data,setData]=useState<Directory|null>(null);
 const[error,setError]=useState("");
 const[notice,setNotice]=useState("");
 const[busy,setBusy]=useState("");
 const[form,setForm]=useState({provider:"google_ads",externalAccountId:"",label:"",writeMode:"disabled",maxDailyBudget:"",supermetricsDsId:""});
 const[window_,setWindow]=useState({start:daysAgo(7),end:today()});
 const[link,setLink]=useState({provider:"google_ads",externalCampaignId:"",campaignId:""});

 const load=useCallback(async()=>{
  const response=await fetch("/api/ad-spend",{cache:"no-store"});
  const payload=await response.json().catch(()=>({}) as Record<string,unknown>);
  if(!response.ok)throw new Error(String(payload.error||`Unable to load ad spend (HTTP ${response.status})`));
  setData(payload.data as Directory);
 },[]);
 const refresh=useCallback(async()=>{
  try{await load();setError("");}
  catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
 },[load]);
 useEffect(()=>{const timer=setTimeout(()=>{void refresh();},0);return()=>clearTimeout(timer);},[refresh]);

 async function call(body:Record<string,unknown>,label:string){
  setBusy(label);setNotice("");
  try{
   const response=await fetch("/api/ad-spend",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
   const payload=await response.json().catch(()=>({}) as Record<string,unknown>);
   if(!response.ok)throw new Error(String(payload.error||`${String(body.action)} failed (HTTP ${response.status})`));
   await refresh();
   return payload.data as Record<string,unknown>;
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));return null;}
  finally{setBusy("");}
 }

 async function sync(source:Source){
  const result=await call({action:"sync",provider:source.provider,externalAccountId:source.external_account_id,start:window_.start,end:window_.end},`sync:${source.id}`);
  if(!result)return;
  if(result.status==="configuration_required")setNotice(`${source.label}: still missing ${(result.missing as string[]).join(", ")}. Nothing was written.`);
  else if(result.status==="failed")setNotice(`${source.label}: ${String(result.error)}`);
  else setNotice(`${source.label}: ${money(Number(result.spend))} across ${result.days} days and ${result.campaigns} campaigns.${(result.unmapped as string[]).length?` ${(result.unmapped as string[]).length} campaign(s) still need mapping.`:""}`);
 }

 async function change(source:Source,externalCampaignId:string,type:"pause"|"resume"|"set_daily_budget"){
  const reason=prompt(`Why is this campaign being changed? (recorded against ${externalCampaignId})`)||"";
  if(reason.trim().length<8){setError("A change to a live campaign needs a reason of at least 8 characters.");return;}
  const approvalReference=prompt("Approval reference for this change")||"";
  const dailyBudget=type==="set_daily_budget"?Number(prompt("New daily budget in INR")||0):undefined;
  const result=await call({action:"apply_change",provider:source.provider,externalAccountId:source.external_account_id,externalCampaignId,change:{type,dailyBudget},reason,approvalReference,idempotencyKey:`${type}-${externalCampaignId}-${Date.now()}`},`change:${externalCampaignId}`);
  if(result)setNotice(String(result.status)==="preview"?`Preview only - nothing was sent to ${source.provider}. Switch the account to live to apply it.`:`Change ${String(result.status)} on ${source.provider}.`);
 }

 const readiness=Object.fromEntries((data?.readiness||[]).map(entry=>[entry.provider,entry]));
 const totalSpend=(data?.spendByCampaign||[]).reduce((sum,row)=>sum+Number(row.spend||0),0);
 const unmappedSpend=(data?.unmappedSpend||[]).reduce((sum,row)=>sum+Number(row.spend||0),0);

 return <main className={styles.shell}>
  <PageHeader
    eyebrow="PawSpace · Marketing"
    title="Ad spend connectors"
    description="Google Ads and Meta directly, or the same numbers through Supermetrics. Spend is either real or absent: an account without credentials reports what is missing and writes nothing."
    actions={<Badge tone={data?.sources.some(source=>source.status==="connected")?"success":"warning"} dot>{data?.sources.filter(source=>source.status==="connected").length||0} connected</Badge>}
  />
  <nav className={styles.nav}><Link href="/team/marketing">← Campaign command centre</Link><Link href="/team/analytics">Analytics</Link></nav>

  {error?<div className={`${styles.panel} ${styles.panelError}`}><b>{error}</b></div>:null}
  {notice?<div className={styles.panel}>{notice}</div>:null}

  <section className={styles.tiles}>
   <StatCard label="Attributed spend" value={money(totalSpend)} />
   <StatCard label="Awaiting mapping" value={money(unmappedSpend)} meta={`${data?.unmappedSpend.length||0} campaigns`} />
   <StatCard label="Accounts" value={data?.sources.length||0} />
   <StatCard label="Live-write accounts" value={data?.sources.filter(source=>source.write_mode==="live").length||0} />
  </section>

  <section className={styles.panel}>
   <div className={styles.panelHead}><h2>Credentials</h2><Badge tone="info">Cloudflare secrets</Badge></div>
   <p className={styles.panelNote}>Set these with <code>npx wrangler secret put NAME</code>. They are never read back into this screen - only their presence is.</p>
   <div className={styles.providerGrid}>
    {PROVIDERS.map(([provider,label])=>{
     const entry=readiness[provider];
     const ready=entry&&entry.missingCredentials.length===0;
     return <div key={provider} className={styles.provider}>
      <div className={styles.providerHead}><b>{label}</b><Badge tone={ready?"success":"warning"}>{ready?"ready":"needs credentials"}</Badge></div>
      <ul className={styles.credentials}>{(entry?.requiredCredentials||[]).map(name=><li key={name} className={entry?.missingCredentials.includes(name)?styles.missing:styles.present}><code>{name}</code></li>)}</ul>
      {data?.writeCapableProviders.includes(provider)?<small>Can change live campaigns once switched on.</small>:<small>Reporting only - cannot change a live campaign.</small>}
     </div>;
    })}
   </div>
  </section>

  <section className={styles.panel}>
   <div className={styles.panelHead}><h2>Ad accounts</h2></div>
   <div className={styles.fieldRow}>
    <label className={styles.field}>Provider<select value={form.provider} onChange={event=>setForm({...form,provider:event.target.value})}>{PROVIDERS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label className={styles.field}>Account id<input value={form.externalAccountId} onChange={event=>setForm({...form,externalAccountId:event.target.value})} placeholder={form.provider==="meta_ads"?"act_1234567890":"123-456-7890"} /></label>
    <label className={styles.field}>Label<input value={form.label} onChange={event=>setForm({...form,label:event.target.value})} placeholder="PawSpace India" /></label>
    {form.provider==="supermetrics"?<label className={styles.field}>Data source (ds_id)<input value={form.supermetricsDsId} onChange={event=>setForm({...form,supermetricsDsId:event.target.value})} placeholder="AW / FA" /></label>:null}
    {form.provider!=="supermetrics"?<>
     <label className={styles.field}>Live changes<select value={form.writeMode} onChange={event=>setForm({...form,writeMode:event.target.value})}><option value="disabled">Off (read only)</option><option value="preview">Preview only</option><option value="live">Live — changes the real account</option></select></label>
     <label className={styles.field}>Daily budget ceiling ₹<input value={form.maxDailyBudget} onChange={event=>setForm({...form,maxDailyBudget:event.target.value})} placeholder="5000" inputMode="numeric" /></label>
    </>:null}
   </div>
   <div className={styles.actions}>
    <Button size="sm" disabled={!form.externalAccountId.trim()||form.label.trim().length<3||busy==="save"} onClick={()=>{void call({action:"save_source",provider:form.provider,externalAccountId:form.externalAccountId.trim(),label:form.label.trim(),writeMode:form.writeMode,maxDailyBudget:form.maxDailyBudget?Number(form.maxDailyBudget):null,supermetricsDsId:form.supermetricsDsId||undefined},"save");}}>Save account</Button>
    {form.writeMode==="live"?<small className={styles.warn}>Live mode lets this screen pause campaigns and move budgets in the real account.</small>:null}
   </div>

   {data?.sources.length?<div className={styles.tableWrap}><table className={styles.table}>
    <thead><tr><th>Account</th><th>Status</th><th>Writes</th><th>Last sync</th><th>Actions</th></tr></thead>
    <tbody>{data.sources.map(source=><tr key={source.id}>
     <td><div className={styles.person}><b>{source.label}</b><small>{source.provider} · {source.external_account_id}</small></div></td>
     <td><Badge tone={source.status==="connected"?"success":source.status==="disabled"?"neutral":"warning"}>{source.status}</Badge>{source.last_error?<small className={styles.warn}> {source.last_error}</small>:null}</td>
     <td>{source.write_mode==="live"?<Badge tone="danger">live · ≤{money(Number(source.max_daily_budget||0))}/day</Badge>:<Badge tone="neutral">{source.write_mode}</Badge>}</td>
     <td><small>{when(source.last_sync_at)}</small></td>
     <td><div className={styles.actions}>
      <Button size="sm" variant="secondary" disabled={busy===`sync:${source.id}`} onClick={()=>{void sync(source);}}>{busy===`sync:${source.id}`?"Pulling…":"Pull spend"}</Button>
      {source.write_mode!=="disabled"?<>
       <Button size="sm" variant="ghost" onClick={()=>{const id=prompt("Platform campaign id to pause")||"";if(id)void change(source,id,"pause");}}>Pause…</Button>
       <Button size="sm" variant="ghost" onClick={()=>{const id=prompt("Platform campaign id to change budget for")||"";if(id)void change(source,id,"set_daily_budget");}}>Budget…</Button>
      </>:null}
     </div></td>
    </tr>)}</tbody>
   </table></div>:<EmptyState title="No ad account is configured yet" body="Add the Google Ads, Meta or Supermetrics account above. Spend only appears once its credentials are set as Cloudflare secrets." />}

   <div className={styles.fieldRow}>
    <label className={styles.field}>Window from<input type="date" value={window_.start} onChange={event=>setWindow({...window_,start:event.target.value})} /></label>
    <label className={styles.field}>to<input type="date" value={window_.end} onChange={event=>setWindow({...window_,end:event.target.value})} /></label>
   </div>
  </section>

  <section className={styles.panel}>
   <div className={styles.panelHead}><h2>Campaign mapping</h2><Badge tone={data?.unmappedSpend.length?"warning":"success"}>{data?.unmappedSpend.length||0} unmapped</Badge></div>
   <p className={styles.panelNote}>Spend is only attributed to a governed campaign once its platform campaign is linked here. Until then it is held, never spread by guesswork.</p>
   {data?.unmappedSpend.length?<ul className={styles.memberList}>{data.unmappedSpend.map(row=><li key={`${row.provider}:${row.external_campaign_id}`}>
    <span><b>{row.external_campaign_name||row.external_campaign_id}</b> <small>{row.provider} · {row.external_campaign_id}</small></span>
    <span>{money(Number(row.spend))}</span>
   </li>)}</ul>:null}
   <div className={styles.fieldRow}>
    <label className={styles.field}>Provider<select value={link.provider} onChange={event=>setLink({...link,provider:event.target.value})}>{PROVIDERS.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
    <label className={styles.field}>Platform campaign id<input value={link.externalCampaignId} onChange={event=>setLink({...link,externalCampaignId:event.target.value})} /></label>
    <label className={styles.field}>Governed campaign id<input value={link.campaignId} onChange={event=>setLink({...link,campaignId:event.target.value})} placeholder="CMP-…" /></label>
   </div>
   <div className={styles.actions}><Button size="sm" variant="secondary" disabled={!link.externalCampaignId.trim()||!link.campaignId.trim()||busy==="link"} onClick={()=>{void call({action:"link_campaign",provider:link.provider,externalCampaignId:link.externalCampaignId.trim(),campaignId:link.campaignId.trim()},"link");}}>Link campaign</Button></div>
   {data?.links.length?<ul className={styles.memberList}>{data.links.map(row=><li key={`${row.provider}:${row.external_campaign_id}`}>
    <span><b>{row.external_campaign_name||row.external_campaign_id}</b> <small>{row.provider}</small></span>
    <span><small>→ {row.campaign_name||row.campaign_id}</small></span>
   </li>)}</ul>:null}
  </section>

  {data?.spendByCampaign.length?<section className={styles.panel}>
   <div className={styles.panelHead}><h2>Attributed spend</h2></div>
   <div className={styles.tableWrap}><table className={styles.table}>
    <thead><tr><th>Campaign</th><th>Source</th><th>Days covered</th><th className={styles.numeric}>Spend</th></tr></thead>
    <tbody>{data.spendByCampaign.map(row=><tr key={`${row.campaign_id}:${row.provider}`}>
     <td>{row.campaign_id}</td><td>{row.provider}</td><td><small>{row.first_day} → {row.last_day}</small></td><td className={styles.numeric}>{money(Number(row.spend))}</td>
    </tr>)}</tbody>
   </table></div>
  </section>:null}

  {data?.changes.length?<section className={styles.panel}>
   <div className={styles.panelHead}><h2>Live changes made from here</h2></div>
   <div className={styles.tableWrap}><table className={styles.table}>
    <thead><tr><th>When</th><th>Campaign</th><th>Change</th><th>Status</th><th>Who / why</th></tr></thead>
    <tbody>{data.changes.map(row=><tr key={row.id}>
     <td><small>{when(row.created_at)}</small></td>
     <td>{row.provider} · {row.external_campaign_id}</td>
     <td>{row.change_type}</td>
     <td><Badge tone={row.status==="applied"?"success":row.status==="failed"?"danger":"neutral"}>{row.status}</Badge>{row.error?<small className={styles.warn}> {row.error}</small>:null}</td>
     <td><div className={styles.person}><small>{row.actor_id}</small><small>{row.approval_reference} · {row.reason}</small></div></td>
    </tr>)}</tbody>
   </table></div>
  </section>:null}

  <footer className={styles.footnote}>
   <b>Spend source:</b> platform-reported · <b>Fabricated spend:</b> never · <b>Conversion attribution:</b> not connected · <b>Production ready:</b> NO
  </footer>
 </main>;
}
