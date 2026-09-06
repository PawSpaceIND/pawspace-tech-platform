const SQLITE_BUSY_PATTERN=/\bSQLITE_BUSY(?:_[A-Z_]+)?\b|database (?:table )?is locked|database is busy/i;
const SQLITE_CONSTRAINT_PATTERN=/\bSQLITE_CONSTRAINT(?:_[A-Z_]+)?\b|(?:UNIQUE|FOREIGN KEY|CHECK|NOT NULL) constraint failed/i;

export type D1WriteRetryOptions={attempts?:number;baseDelayMs?:number;maxDelayMs?:number;maxTotalDelayMs?:number;sleep?:(delayMs:number)=>Promise<void>;random?:()=>number;};

function errorDetails(error:unknown){const parts:string[]=[];const seen=new Set<unknown>();let current:unknown=error;for(let depth=0;current!==null&&current!==undefined&&depth<6&&!seen.has(current);depth+=1){seen.add(current);if(typeof current==="object"){const record=current as{code?:unknown;name?:unknown;message?:unknown;cause?:unknown};for(const value of[record.code,record.name,record.message])if(value!==undefined&&value!==null)parts.push(String(value));current=record.cause;continue;}parts.push(String(current));break;}return parts.join(" ");}
export function isSqliteBusyError(error:unknown){return SQLITE_BUSY_PATTERN.test(errorDetails(error));}
export function isSqliteConstraintError(error:unknown){return SQLITE_CONSTRAINT_PATTERN.test(errorDetails(error));}

export async function withD1WriteRetry<T>(work:()=>Promise<T>,options:D1WriteRetryOptions={}):Promise<T>{const attempts=Math.min(3,Math.max(1,Math.floor(options.attempts??3))),baseDelayMs=Math.min(50,Math.max(1,Math.floor(options.baseDelayMs??5))),maxDelayMs=Math.min(50,Math.max(baseDelayMs,Math.floor(options.maxDelayMs??40))),maxTotalDelayMs=Math.min(100,Math.max(0,Math.floor(options.maxTotalDelayMs??75))),sleep=options.sleep??((delayMs:number)=>new Promise<void>(resolve=>setTimeout(resolve,delayMs))),random=options.random??Math.random;let totalDelayMs=0;for(let attempt=0;attempt<attempts;attempt+=1){try{return await work();}catch(error){if(!isSqliteBusyError(error)||attempt===attempts-1)throw error;const exponential=Math.min(maxDelayMs,baseDelayMs*(2**attempt)),floor=Math.max(1,Math.ceil(exponential/2)),unit=Math.max(0,Math.min(.999999,random())),delay=Math.min(maxDelayMs,floor+Math.floor(unit*(exponential-floor+1)));if(totalDelayMs+delay>maxTotalDelayMs)throw error;totalDelayMs+=delay;await sleep(delay);}}throw new Error("D1 write retry loop exhausted unexpectedly");}

const rawStatements=new WeakMap<object,D1PreparedStatement>();
const statementQueries=new WeakMap<object,string>();
function retryingStatement(statement:D1PreparedStatement,query:string):D1PreparedStatement{const proxy=new Proxy(statement,{get(target,property,receiver){if(property==="bind")return(...values:unknown[])=>retryingStatement(target.bind(...values),query);if(property==="run")return()=>withD1WriteRetry(()=>target.run());const value=Reflect.get(target,property,receiver);return typeof value==="function"?value.bind(target):value;}})as D1PreparedStatement;rawStatements.set(proxy as object,statement);statementQueries.set(proxy as object,query);return proxy;}

const retryingDatabases=new WeakMap<object,D1Database>();
let managedStagingPromise:Promise<boolean>|undefined;
async function managedStaging(){managedStagingPromise??=import("cloudflare:workers").then(({env})=>String((env as unknown as Record<string,unknown>).PAWSPACE_DEPLOYMENT_ENV||"").trim().toLowerCase()==="staging").catch(()=>false);return managedStagingPromise;}
const DDL=/^\s*(?:CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX|TRIGGER)|ALTER\s+TABLE)\b/i;
const SCHEDULING_SCHEMA=/(?:scheduling_|provider_capacity_|provider_unavailability|provider_assignment_|provider_recovery_|provider_performance_|provider_home_base|provider_verification|provider_onboarding)/i;
function preflightedSchedulingDdl(statements:D1PreparedStatement[]){if(!statements.length)return false;const queries=statements.map(statement=>statementQueries.get(statement as object)||"");return queries.every(query=>DDL.test(query)&&SCHEDULING_SCHEMA.test(query));}
function skippedDdlResult(){return{success:true,meta:{changes:0,rows_written:0}} as unknown as D1Result<unknown>;}

/**
 * Wrap a D1 binding so writes get the same bounded SQLITE_BUSY retry policy.
 *
 * The wrapper is stable per raw binding so helper WeakMap/WeakSet caches work. On the deployed staging
 * Worker, scheduling/provider schema is prepared before concurrent pilot traffic. Schema-only batches
 * for those known tables are therefore treated as already satisfied instead of re-entering D1's
 * single-writer lane on every customer request. This optimization is deliberately limited to
 * PAWSPACE_DEPLOYMENT_ENV=staging and to scheduling/provider DDL; production, local tests and ordinary
 * data writes retain their original behavior.
 */
export function withRetryingD1Writes(db:D1Database):D1Database{const existing=retryingDatabases.get(db as object);if(existing)return existing;const proxy=new Proxy(db,{get(target,property,receiver){if(property==="prepare")return(query:string)=>retryingStatement(target.prepare(query),query);if(property==="batch")return async(statements:D1PreparedStatement[])=>{if(preflightedSchedulingDdl(statements)&&await managedStaging())return statements.map(()=>skippedDdlResult());return withD1WriteRetry(()=>target.batch(statements.map(statement=>rawStatements.get(statement as object)??statement)));};if(property==="exec")return(query:string)=>withD1WriteRetry(()=>target.exec(query));const value=Reflect.get(target,property,receiver);return typeof value==="function"?value.bind(target):value;}})as D1Database;retryingDatabases.set(db as object,proxy);return proxy;}
