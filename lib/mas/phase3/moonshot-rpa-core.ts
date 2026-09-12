type BrowserBinding={fetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response>};
export type MoonshotRpaEnv=Record<string,unknown>&{BROWSER?:BrowserBinding};
const text=(v:unknown,max=160)=>String(v??"").trim().slice(0,max);
const truthy=(v:unknown)=>["1","true","on","yes"].includes(String(v??"").trim().toLowerCase());
export const MOONSHOT_RPA_ALLOWLIST=new Set(["municipal_pet_registration","legacy_vet_clinic"]);
export type MoonshotRpaAction={system:string;action:string;correlationId:string;input?:unknown};
export async function executeMoonshotRpaAction(env:MoonshotRpaEnv,input:MoonshotRpaAction){
 if(!truthy(env.PAWSPACE_RPA_ACTIVE))return{executed:false,status:"disabled" as const,reason:"moonshot_rpa_disabled"};
 const system=text(input.system,80),action=text(input.action,100),correlationId=text(input.correlationId,120);
 if(!MOONSHOT_RPA_ALLOWLIST.has(system)||!action||!correlationId)throw new Response("RPA request is not allow-listed",{status:403});
 if(!env.BROWSER)throw new Response("Browser binding unavailable",{status:503});
 const endpoint=text(env.PAWSPACE_RPA_BRIDGE_URL,500);if(!endpoint||!endpoint.startsWith("https://"))throw new Response("RPA bridge not configured",{status:503});
 const res=await env.BROWSER.fetch(endpoint,{method:"POST",headers:{"content-type":"application/json","x-pawspace-correlation-id":correlationId},body:JSON.stringify({system,action,correlationId,input:input.input??null})});
 if(!res.ok)throw new Response("RPA bridge rejected request",{status:502});
 return{executed:true,status:"accepted" as const,httpStatus:res.status,system,action,correlationId};
}
