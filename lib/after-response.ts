import{currentRequestD1Metrics}from"./request-d1-metrics";

/**
 * Work a route may finish after it has answered.
 *
 * The Workers runtime cancels a finished request's unfinished I/O, so work that outlives the answer
 * must be handed to the request's waitUntil - the same rule app/api/uat-scheduling applies to a preview
 * that runs past its deadline. The request's waitUntil is taken from the per-request D1 scope when the
 * Worker opened one (lib/request-d1-metrics.ts), else from `cloudflare:workers`.
 *
 * Where there is no waitUntil at all (scripts, tests without a request scope) nothing would keep the
 * work alive after the answer, so it is simply finished BEFORE answering and its value returned. The
 * caller therefore never loses the work; it only learns whether it already has the result.
 *
 * The work must be idempotent and must settle on its own: a deferred failure is logged, never thrown,
 * because nobody is waiting for it any more.
 */
export async function finishAfterResponse<T>(label:string,work:()=>Promise<T>):Promise<{deferred:true}|{deferred:false;value:T}>{
 const waitUntil=currentRequestD1Metrics()?.waitUntil??await runtimeWaitUntil();
 if(!waitUntil)return{deferred:false,value:await work()};
 // Started on the next task, once the answer has been produced, so none of its D1 calls sits in front of
 // the answer's own.
 const started=new Promise<void>(resolve=>setTimeout(resolve,0)).then(work);
 waitUntil(started.then(()=>undefined,error=>{console.error(JSON.stringify({level:"error",event:"after_response_work_failed",work:label,message:error instanceof Error?error.message.slice(0,300):String(error).slice(0,300)}));}));
 return{deferred:true};
}

async function runtimeWaitUntil():Promise<((promise:Promise<unknown>)=>void)|null>{
 try{
  const runtime=await import("cloudflare:workers") as unknown as {waitUntil?:(promise:Promise<unknown>)=>void};
  return typeof runtime.waitUntil==="function"?promise=>runtime.waitUntil!(promise):null;
 }catch{return null;}
}
