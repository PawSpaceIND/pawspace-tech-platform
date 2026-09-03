const SQLITE_BUSY_PATTERN=/\bSQLITE_BUSY(?:_[A-Z_]+)?\b|database (?:table )?is locked|database is busy/i;
const SQLITE_CONSTRAINT_PATTERN=/\bSQLITE_CONSTRAINT(?:_[A-Z_]+)?\b|(?:UNIQUE|FOREIGN KEY|CHECK|NOT NULL) constraint failed/i;

export type D1WriteRetryOptions={
  attempts?:number;
  baseDelayMs?:number;
  maxDelayMs?:number;
  sleep?:(delayMs:number)=>Promise<void>;
  random?:()=>number;
};

function errorDetails(error:unknown){
  const parts:string[]=[];
  const seen=new Set<unknown>();
  let current:unknown=error;
  for(let depth=0;current!==null&&current!==undefined&&depth<6&&!seen.has(current);depth+=1){
    seen.add(current);
    if(typeof current==="object"){
      const record=current as {code?:unknown;name?:unknown;message?:unknown;cause?:unknown};
      for(const value of [record.code,record.name,record.message])if(value!==undefined&&value!==null)parts.push(String(value));
      current=record.cause;
      continue;
    }
    parts.push(String(current));
    break;
  }
  return parts.join(" ");
}

export function isSqliteBusyError(error:unknown){return SQLITE_BUSY_PATTERN.test(errorDetails(error));}
export function isSqliteConstraintError(error:unknown){return SQLITE_CONSTRAINT_PATTERN.test(errorDetails(error));}

export async function withD1WriteRetry<T>(work:()=>Promise<T>,options:D1WriteRetryOptions={}):Promise<T>{
  const attempts=Math.max(1,Math.floor(options.attempts??6));
  const baseDelayMs=Math.max(1,Math.floor(options.baseDelayMs??10));
  const maxDelayMs=Math.max(baseDelayMs,Math.floor(options.maxDelayMs??160));
  const sleep=options.sleep??((delayMs:number)=>new Promise<void>(resolve=>setTimeout(resolve,delayMs)));
  const random=options.random??Math.random;
  for(let attempt=0;attempt<attempts;attempt+=1){
    try{return await work();}
    catch(error){
      if(!isSqliteBusyError(error)||attempt===attempts-1)throw error;
      const exponential=Math.min(maxDelayMs,baseDelayMs*(2**attempt));
      const jitter=Math.floor(Math.max(0,Math.min(0.999999,random()))*baseDelayMs);
      await sleep(exponential+jitter);
    }
  }
  throw new Error("D1 write retry loop exhausted unexpectedly");
}

const rawStatements=new WeakMap<object,D1PreparedStatement>();
function retryingStatement(statement:D1PreparedStatement):D1PreparedStatement{
  const proxy=new Proxy(statement,{
    get(target,property,receiver){
      if(property==="bind")return(...values:unknown[])=>retryingStatement(target.bind(...values));
      if(property==="run")return()=>withD1WriteRetry(()=>target.run());
      const value=Reflect.get(target,property,receiver);
      return typeof value==="function"?value.bind(target):value;
    },
  }) as D1PreparedStatement;
  rawStatements.set(proxy as object,statement);
  return proxy;
}

const retryingDatabases=new WeakMap<object,D1Database>();

/**
 * Wrap a D1 binding so every route-owned or helper-owned write using run(), batch(), or exec()
 * gets the same bounded SQLITE_BUSY retry policy. Read operations are passed through unchanged.
 * D1 batches are transactional, so retrying a batch after SQLITE_BUSY does not replay a partial commit.
 *
 * The wrapper is stable per raw D1 binding. Several scheduling helpers memoize idempotent schema/setup
 * work with WeakMap/WeakSet keyed by the database object; returning a fresh Proxy on every request made
 * those caches miss and repeated CREATE TABLE/INDEX + seed work on the hot scheduling path.
 */
export function withRetryingD1Writes(db:D1Database):D1Database{
  const existing=retryingDatabases.get(db as object);
  if(existing)return existing;
  const proxy=new Proxy(db,{
    get(target,property,receiver){
      if(property==="prepare")return(query:string)=>retryingStatement(target.prepare(query));
      if(property==="batch")return(statements:D1PreparedStatement[])=>withD1WriteRetry(()=>target.batch(statements.map(statement=>rawStatements.get(statement as object)??statement)));
      if(property==="exec")return(query:string)=>withD1WriteRetry(()=>target.exec(query));
      const value=Reflect.get(target,property,receiver);
      return typeof value==="function"?value.bind(target):value;
    },
  }) as D1Database;
  retryingDatabases.set(db as object,proxy);
  return proxy;
}
