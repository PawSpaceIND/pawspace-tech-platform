import{AsyncLocalStorage}from"node:async_hooks";

/**
 * Per-request D1 accounting for the scheduling preview (bug B2: the V2 east grooming availability check
 * answered with a platform 502 after ~30 s on staging).
 *
 * The store is opened by worker/index.ts for POST /api/uat-scheduling, or by the route itself when it is
 * called in-process (AI tools, voice sales, tests). Every D1 call made through withRequestD1Metrics() while
 * a store is active is counted: how long the Worker waited, how long D1 says it spent running the SQL
 * (meta.duration, only where D1 returns meta), and how many of the calls were strictly sequential - a
 * call counts as new sequential work when it starts after every earlier call has finished. With no
 * store active the wrapper is a pass-through, so no other request pays for it.
 *
 * Nothing here records SQL text, bound values, customer ids, addresses or tokens.
 */
export type RequestD1Metrics={startedAt:number;colo:string|null;isolateCold:boolean;viaWorker:boolean;waitUntil:((promise:Promise<unknown>)=>void)|null;calls:number;seq:number;clientMs:number;serverMs:number;rowsRead:number;writes:number;inflight:number;maxInflight:number;phases:Array<{name:string;ms:number}>;memo:Map<string,Promise<unknown>>;flags:Set<string>};

const storage=new AsyncLocalStorage<RequestD1Metrics>();
let isolateServedSchedulingRequest=false;
const clock=()=>performance.now();
const WRITE_SQL=/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i;

/**
 * `viaWorker` marks a store opened at the edge, so the route can report the Worker's own set-up time.
 * `waitUntil` is the request's ctx.waitUntil: work the request answers without waiting for (the preview
 * deadline) is handed to it, because the runtime cancels a finished request's unfinished I/O.
 */
export function createRequestD1Metrics(request?:Request,viaWorker=false,waitUntil:RequestD1Metrics["waitUntil"]=null):RequestD1Metrics{const isolateCold=!isolateServedSchedulingRequest;isolateServedSchedulingRequest=true;const colo=(request as unknown as {cf?:{colo?:unknown}}|undefined)?.cf?.colo;return{startedAt:clock(),colo:typeof colo==="string"?colo:null,isolateCold,viaWorker,waitUntil,calls:0,seq:0,clientMs:0,serverMs:0,rowsRead:0,writes:0,inflight:0,maxInflight:0,phases:[],memo:new Map(),flags:new Set()};}
export function currentRequestD1Metrics(){return storage.getStore()??null;}
export function runWithRequestD1Metrics<T>(metrics:RequestD1Metrics,work:()=>T):T{return storage.run(metrics,work);}
/** Joins the surrounding request scope when there is one (the Worker opened it), otherwise opens one. */
export function inRequestD1Metrics<T>(request:Request|undefined,work:(metrics:RequestD1Metrics)=>Promise<T>):Promise<T>{const existing=storage.getStore();if(existing)return work(existing);const metrics=createRequestD1Metrics(request);return storage.run(metrics,()=>work(metrics));}

/** The same promise for the same key within ONE request; nothing is shared across requests. */
export function requestMemo<T>(key:string,work:()=>Promise<T>):Promise<T>{const metrics=storage.getStore();if(!metrics)return work();const hit=metrics.memo.get(key) as Promise<T>|undefined;if(hit)return hit;const pending=work();metrics.memo.set(key,pending);pending.catch(()=>{if(metrics.memo.get(key)===pending)metrics.memo.delete(key);});return pending;}
export function markRequestFlag(name:string){storage.getStore()?.flags.add(name);}
export function requestFlag(name:string){return Boolean(storage.getStore()?.flags.has(name));}

type Meta={duration?:unknown;rows_read?:unknown}|undefined;
function record(metrics:RequestD1Metrics,startedAt:number,result:unknown){metrics.inflight-=1;metrics.clientMs+=clock()-startedAt;const metas:Meta[]=Array.isArray(result)?result.map(item=>(item as {meta?:Meta})?.meta):[(result as {meta?:Meta}|null)?.meta];for(const meta of metas){const duration=Number(meta?.duration),rows=Number(meta?.rows_read);if(Number.isFinite(duration))metrics.serverMs+=duration;if(Number.isFinite(rows))metrics.rowsRead+=rows;}}
function track<T>(write:boolean,work:()=>Promise<T>):Promise<T>{const metrics=storage.getStore();if(!metrics)return work();metrics.calls+=1;if(write)metrics.writes+=1;if(metrics.inflight===0)metrics.seq+=1;metrics.inflight+=1;metrics.maxInflight=Math.max(metrics.maxInflight,metrics.inflight);const startedAt=clock();return work().then(result=>{record(metrics,startedAt,result);return result;},error=>{record(metrics,startedAt,undefined);throw error;});}

/**
 * Writes to a wrapper stay on the wrapper. Instrumentation that patches methods in place (Sentry's D1
 * integration assigns statement.bind/first/all/run/raw) would otherwise write through to the wrapped
 * object, and this wrapper's bind(), which calls the wrapped object's bind(), would then call itself.
 */
function keepWritesLocal<T extends object>(get:NonNullable<ProxyHandler<T>["get"]>):ProxyHandler<T>{const overrides=new Map<PropertyKey,unknown>();return{get(target,property,receiver){return overrides.has(property)?overrides.get(property):get(target,property,receiver);},set(_target,property,value){overrides.set(property,value);return true;}};}
const rawStatements=new WeakMap<object,D1PreparedStatement>(),statementSql=new WeakMap<object,string>();
function countedStatement(statement:D1PreparedStatement,sql:string):D1PreparedStatement{
 const proxy=new Proxy(statement,keepWritesLocal<D1PreparedStatement>((target,property,receiver)=>{
  if(property==="bind")return(...values:unknown[])=>countedStatement(target.bind(...values),sql);
  if(property==="first"||property==="all"||property==="run"||property==="raw"){const method=Reflect.get(target,property,receiver) as (...args:unknown[])=>Promise<unknown>;return(...args:unknown[])=>track(WRITE_SQL.test(sql),()=>method.apply(target,args));}
  const value=Reflect.get(target,property,receiver);return typeof value==="function"?value.bind(target):value;})) as D1PreparedStatement;
 rawStatements.set(proxy as object,statement);statementSql.set(proxy as object,sql);return proxy;
}
const countedDatabases=new WeakMap<object,D1Database>();
/**
 * Stable per raw binding, like withRetryingD1Writes: the per-isolate schema guards are WeakSets keyed by
 * the database object, so a fresh wrapper per request would make every one of them miss.
 */
export function withRequestD1Metrics(db:D1Database):D1Database{
 if(!db||typeof db!=="object")return db;
 const existing=countedDatabases.get(db as object);if(existing)return existing;
 const proxy=new Proxy(db,keepWritesLocal<D1Database>((target,property,receiver)=>{
  if(property==="prepare")return(query:string)=>countedStatement(target.prepare(query),query);
  if(property==="batch")return(statements:D1PreparedStatement[])=>track(statements.some(item=>WRITE_SQL.test(statementSql.get(item as object)??"INSERT")),()=>target.batch(statements.map(item=>rawStatements.get(item as object)??item)));
  if(property==="exec")return(query:string)=>track(true,()=>target.exec(query));
  const value=Reflect.get(target,property,receiver);return typeof value==="function"?value.bind(target):value;})) as D1Database;
 countedDatabases.set(db as object,proxy);return proxy;
}
/** The Worker env with DB counted; every other binding is passed through untouched. */
export function withRequestD1MetricsEnv<E extends{DB:D1Database}>(env:E):E{return new Proxy(env,{get(target,property,receiver){return property==="DB"?withRequestD1Metrics(target.DB):Reflect.get(target,property,receiver);}});}

const ms=(value:number)=>Math.max(0,Math.round(value*10)/10);
/** `Server-Timing` for browser devtools and Playwright traces: phase durations plus the D1 summary. */
export function serverTimingHeader(metrics:RequestD1Metrics,totalMs:number){return[...metrics.phases.map(phase=>`${phase.name};dur=${ms(phase.ms)}`),`d1;dur=${ms(metrics.clientMs)};desc="n=${metrics.calls} seq=${metrics.seq} srv=${ms(metrics.serverMs)}ms"`,`total;dur=${ms(totalMs)}`].join(", ");}
export function requestD1Summary(metrics:RequestD1Metrics){return{d1Calls:metrics.calls,d1Seq:metrics.seq,d1ClientMs:ms(metrics.clientMs),d1ServerMs:ms(metrics.serverMs),d1Writes:metrics.writes,maxInflight:metrics.maxInflight,isolateCold:metrics.isolateCold,colo:metrics.colo};}
