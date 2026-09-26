/**
 * Staging-only D1 timing. Every D1 call a request makes is timed and the slowest are reported in that
 * response's Server-Timing header by query fingerprint, so a slow screen names the query that makes it slow.
 *
 * The prototypes of the D1 binding and its prepared statements are patched once per isolate, which keeps
 * the binding's identity (per-database caches such as ensureD1Once are keyed on it). Only calls made
 * inside withD1Timing() are recorded; everything else passes straight through.
 */
import{AsyncLocalStorage}from"node:async_hooks";

type Timing={sql:string;ms:number};
type Callable=(...args:unknown[])=>Promise<unknown>;
const recording=new AsyncLocalStorage<Timing[]>();
let installed=false;

function timed(owner:Record<string,unknown>,name:string,label:(self:Record<string,unknown>,args:unknown[])=>string){
 const original=owner[name];if(typeof original!=="function")return;
 owner[name]=async function(this:Record<string,unknown>,...args:unknown[]){
  const timings=recording.getStore();if(!timings)return(original as Callable).apply(this,args);
  const started=Date.now();
  try{return await(original as Callable).apply(this,args);}
  finally{timings.push({sql:label(this,args),ms:Date.now()-started});}
 };
}

export function installD1RequestTiming(db:D1Database){
 if(installed)return;installed=true;
 try{
  const statement=Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<string,unknown>;
  for(const name of["first","run","all","raw"])timed(statement,name,self=>String(self.statement??"?"));
  timed(Object.getPrototypeOf(db) as Record<string,unknown>,"batch",(_self,args)=>{const list=Array.isArray(args[0])?args[0] as Record<string,unknown>[]:[];return`BATCH(${list.length}) ${String(list[0]?.statement??"")}`;});
 }catch{/* timing is diagnostic only; the binding keeps working unpatched */}
}

export async function withD1RequestTiming<T>(run:()=>Promise<T>){const timings:Timing[]=[];const result=await recording.run(timings,run);return{result,timings};}

/**
 * A query's fingerprint: FNV-1a over its whitespace-normalised SQL. The header carries only this, never SQL
 * or table names, so a public response reveals nothing about the schema; the same function run locally over
 * the same code path maps a fingerprint back to its query.
 */
export function sqlFingerprint(sql:string){let hash=0x811c9dc5;for(const char of sql.replace(/\s+/g," ").trim()){hash^=char.charCodeAt(0);hash=Math.imul(hash,0x01000193)>>>0;}return hash.toString(16).padStart(8,"0");}

/** Server-Timing value: total time, D1 total and count, then the slowest calls by fingerprint. */
export function d1ServerTiming(timings:Timing[],totalMs:number,limit=8){
 const clean=(sql:string)=>sqlFingerprint(sql);
 const sum=timings.reduce((total,entry)=>total+entry.ms,0);
 const slowest=[...timings].map((entry,index)=>({...entry,index})).sort((a,b)=>b.ms-a.ms).slice(0,limit);
 return[`app;dur=${totalMs}`,`d1;dur=${sum};desc="${timings.length} calls"`,...slowest.map(entry=>`q${entry.index+1};dur=${entry.ms};desc="${clean(entry.sql)}"`)].join(", ");
}
