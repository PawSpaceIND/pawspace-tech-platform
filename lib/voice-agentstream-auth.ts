type Env=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const FRESHNESS_MS=5*60*1000;

function secret(env:Env){return text(env.PAWSPACE_VOICE_STREAM_SECRET)||text(env.EXOTEL_WEBHOOK_SECRET);}
function hex(bytes:ArrayBuffer){return[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function safeEqual(a:string,b:string){if(a.length!==b.length)return false;let out=0;for(let i=0;i<a.length;i++)out|=a.charCodeAt(i)^b.charCodeAt(i);return out===0;}
async function signature(keyText:string,payload:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(keyText),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(payload)));}

export const AGENTSTREAM_AUTH_REF="ps_ref";
export const AGENTSTREAM_AUTH_TS="ps_ts";
export const AGENTSTREAM_AUTH_SIG="ps_sig";

export async function signedAgentStreamUrl(env:Env,baseUrl:string,callRef:string,asOf=Date.now()){
 const key=secret(env);
 if(!key)throw new Error("A voice stream signing secret is required");
 const ref=text(callRef);
 if(!ref)throw new Error("A call reference is required for AgentStream authentication");
 const timestamp=String(Math.floor(asOf/1000));
 const sig=await signature(key,`${ref}.${timestamp}`);
 const url=new URL(baseUrl);
 url.searchParams.set(AGENTSTREAM_AUTH_REF,ref);
 url.searchParams.set(AGENTSTREAM_AUTH_TS,timestamp);
 url.searchParams.set(AGENTSTREAM_AUTH_SIG,sig);
 return url.toString();
}

export async function verifyAgentStreamStart(env:Env,customParameters:Record<string,unknown>|undefined,expectedCallRef:string,asOf=Date.now()){
 const key=secret(env);
 if(!key)return{verified:false,reason:"Voice stream signing secret is not configured"};
 const params=customParameters||{};
 const ref=text(params[AGENTSTREAM_AUTH_REF]??params.PsRef??params.psRef);
 const timestamp=text(params[AGENTSTREAM_AUTH_TS]??params.PsTs??params.psTs);
 const supplied=text(params[AGENTSTREAM_AUTH_SIG]??params.PsSig??params.psSig).toLowerCase();
 if(!ref||!timestamp||!supplied)return{verified:false,reason:"AgentStream authentication parameters are missing"};
 if(ref!==text(expectedCallRef))return{verified:false,reason:"AgentStream call reference does not match the governed call"};
 const seconds=Number(timestamp);
 if(!Number.isFinite(seconds))return{verified:false,reason:"AgentStream authentication timestamp is malformed"};
 const stampedAt=seconds*1000;
 if(Math.abs(asOf-stampedAt)>FRESHNESS_MS)return{verified:false,reason:"AgentStream authentication token is outside the freshness window"};
 const expected=await signature(key,`${ref}.${timestamp}`);
 return safeEqual(expected,supplied)?{verified:true,reason:null}:{verified:false,reason:"AgentStream authentication signature does not match"};
}
