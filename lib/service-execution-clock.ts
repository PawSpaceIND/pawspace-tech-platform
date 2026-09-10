type RuntimeEnv=Record<string,unknown>;

const on=(value:unknown)=>["on","true","1"].includes(String(value??"").trim().toLowerCase());

async function runtimeEnv():Promise<RuntimeEnv>{
 try{const{env}=await import("cloudflare:workers");return env as unknown as RuntimeEnv;}catch{return{};}
}

/**
 * Service-lifecycle time is wall-clock time everywhere except an explicitly isolated UAT run.
 * The override is server-owned runtime configuration: clients cannot send or select it.
 */
export async function serviceExecutionNow():Promise<number>{
 const runtime=await runtimeEnv(),raw=String(runtime.PAWSPACE_UAT_EXECUTION_NOW_MS??"").trim();
 if(!raw)return Date.now();
 const isolated=String(runtime.NODE_ENV||"")==="test"
  &&String(runtime.FORBID_PRODUCTION||"")==="true"
  &&String(runtime.PAWSPACE_SCHEDULING_ENV||"")==="uat"
  &&on(runtime.PAWSPACE_UAT_SERVICE_CLOCK);
 if(!isolated)throw new Response("UAT service clock override is permitted only in isolated test UAT",{status:503});
 const value=Number(raw),min=Date.UTC(2020,0,1),max=Date.UTC(2100,0,1);
 if(!Number.isSafeInteger(value)||value<min||value>max)throw new Response("UAT service clock override is invalid",{status:503});
 return value;
}
