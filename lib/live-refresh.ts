/** Bounded, non-overlapping refresh with cancellation for a mounted view. */
export function startLiveRefresh(run:(signal:AbortSignal)=>Promise<void>,options:{intervalMs?:number;timeoutMs?:number;onError:(error:unknown)=>void}){
 let stopped=false,running=false;
 let timer:ReturnType<typeof setTimeout>|undefined,deadline:ReturnType<typeof setTimeout>|undefined,controller:AbortController|undefined;
 const refresh=async()=>{
  if(stopped||running)return;
  if(timer)clearTimeout(timer);
  running=true;controller=new AbortController();
  const current=controller;
  deadline=setTimeout(()=>current.abort(),options.timeoutMs??10000);
  try{await run(current.signal);}catch(error){if(!stopped)options.onError(error);}
  finally{
   if(deadline)clearTimeout(deadline);
   running=false;controller=undefined;
   if(!stopped)timer=setTimeout(()=>void refresh(),options.intervalMs??3000);
  }
 };
 queueMicrotask(()=>void refresh());
 return{refresh:()=>void refresh(),stop:()=>{stopped=true;if(timer)clearTimeout(timer);if(deadline)clearTimeout(deadline);controller?.abort();}};
}
