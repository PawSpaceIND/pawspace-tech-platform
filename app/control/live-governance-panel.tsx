"use client";
import{useEffect,useState}from"react";
import styles from"./control.module.css";
import EmergencyRuntimeControls from"./emergency-runtime-controls";
type Mode="approvals"|"master"|"inventory"|"quality"|"security"|"health"|"audit";
type SourceState="ok"|"uninitialised"|"unreadable";
type EvidenceState="rows"|"empty"|"uninitialised"|"unreadable"|"not_queried";
export type Card={label:string;value:number|null;detail:string;source:string;connected:boolean;state?:SourceState;note?:string};
export type Evidence={state:EvidenceState;source:string|null;note:string};
export type Data={title:string;cards:Card[];rows:Array<Record<string,unknown>>;evidence?:Evidence};
const rowText=(row:Record<string,unknown>)=>Object.entries(row).map(([key,value])=>`${key.replaceAll("_"," ")}: ${String(value??"—")}`).join(" · ");
/* Schema drift is the one D1 failure lib/control-center-operations.ts absorbs instead of 500-ing, so
 * it is the one failure that can reach a founder looking like an answer. It gets the loud treatment -
 * these are inline because app/control/control.module.css is not this panel's to extend. */
const alarm={margin:"6px 0 0",padding:"10px",border:"1px solid #e3b3b3",borderRadius:"8px",background:"#fdf2f2",color:"#8f1d1d",fontSize:"7px",lineHeight:1.55} as const;
const alarmText={color:"#8f1d1d",fontWeight:900} as const;
const evidenceRows=(rows:Array<Record<string,unknown>>)=>rows.map((r,i)=><article className={styles.permission} key={i}><span>{rowText(r)}</span></article>);
/*
 * The panel renders one sentence per state and never one sentence for several.
 *
 * It used to render `data.rows.length ? rows : "No recent records in this source."`, and the server
 * had exactly one way to say "no rows" - an empty array - for four different situations: the query
 * ran and found nothing, the table does not exist here, the query failed on a missing column, and
 * (on Master settings) no evidence query was issued at all. Three of those four made that sentence a
 * claim about a query that never ran. On Master settings it printed over 112 rows the cards beside it
 * had just counted; on Quality & incidents it sat under six cards that all said "not connected", so
 * the same screen asserted both "there is no source" and "the source has no recent records".
 *
 * `state` is now carried on the payload and every branch below is reachable only when its own
 * sentence is true. "unreported" is the fallback for a response from an older build that carries no
 * state: it claims nothing, because that is all that can honestly be said about it.
 */
export function MetricCard({card}:{card:Card}){
 const state:SourceState|"unreported"=card.state??(card.connected?"ok":"unreported");
 if(state==="ok")return <article><span>{card.label}</span><strong>{card.value}</strong><small>{card.detail} · {card.source}</small></article>;
 if(state==="unreadable")return <article><span>{card.label}</span><strong style={alarmText}>!</strong><small style={alarmText}>{card.detail} · {card.source} · SCHEMA MISMATCH — {card.note||"this card queries a column that table does not have, so no count was read."}</small></article>;
 if(state==="uninitialised")return <article><span>{card.label}</span><strong>—</strong><small>{card.detail} · {card.source} · not created on this database yet, so nothing was counted</small></article>;
 return <article><span>{card.label}</span><strong>n/c</strong><small>{card.detail} · {card.source} · this build did not report why no count was read</small></article>;
}
export function EvidenceBody({data}:{data:Data}){
 const evidence=data.evidence;
 if(!evidence)return data.rows.length?<>{evidenceRows(data.rows)}</>:<p className={styles.muted}>This build did not report whether an evidence query ran against this view, so nothing is claimed about the source.</p>;
 if(evidence.state==="rows")return data.rows.length?<>{evidenceRows(data.rows)}</>:<p className={styles.muted}>The source reported recent rows but none arrived with this response.</p>;
 if(evidence.state==="unreadable")return <p style={alarm}><b>EVIDENCE QUERY FAILED · SCHEMA MISMATCH</b><br/>{evidence.note}</p>;
 const label=evidence.state==="empty"?"QUERIED · NO ROWS":evidence.state==="uninitialised"?"SOURCE NOT INITIALISED · NOT QUERIED":"NO EVIDENCE QUERY IN THIS VIEW";
 return <p className={styles.muted}><b>{label}</b><br/>{evidence.note}</p>;
}
export default function LiveGovernancePanel({mode}:{mode:Mode}){const[data,setData]=useState<Data|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);const load=()=>{setLoading(true);setError("");fetch(`/api/control-center-operations?mode=${mode}`,{cache:"no-store"}).then(async r=>{const b=await r.json()as{data?:Data;error?:string};if(!r.ok||!b.data)throw new Error(b.error||"Unable to load");setData(b.data)}).catch(e=>setError(e instanceof Error?e.message:"Unable to load")).finally(()=>setLoading(false))};useEffect(()=>{const timer=setTimeout(()=>load(),0);return()=>clearTimeout(timer)},[mode]);return <div className={styles.stack}><section className={styles.hero}><div><span>LIVE CANONICAL CONTROL</span><h2>{data?.title||mode}</h2><p>Every metric below is read from the domain table that owns it, and no number is filled in with a sample value. A source that has not been created on this database yet reads as not created yet, a source whose schema no longer matches this view reads as a schema mismatch, and a query that ran and found nothing says that instead.</p></div><button onClick={load} disabled={loading}>{loading?"Refreshing…":"Refresh"}</button></section>{error&&<p className={styles.notice}>{error}</p>}<section className={styles.metrics}>{data?.cards.map(c=><MetricCard card={c} key={c.label}/>)}</section>{mode==="health"&&<EmergencyRuntimeControls/>}<section className={styles.panel}><div className={styles.head}><div><span>RECENT CANONICAL RECORDS</span><h2>Evidence</h2></div></div>{data?<EvidenceBody data={data}/>:<p className={styles.muted}>{loading?"Loading evidence…":"No response has been read from this view yet."}</p>}</section></div>}
