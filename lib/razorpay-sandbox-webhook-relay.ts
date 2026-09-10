type Env=Record<string,unknown>;
type FetchLike=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;

const text=(value:unknown)=>String(value??"").trim();
const sha=/^[0-9a-f]{40}$/;
const checkoutHost=/^pawspace-checkout-674-[1-9][0-9]{0,19}-[1-9][0-9]{0,5}\.[a-z0-9-]+\.workers\.dev$/i;

export type RazorpaySandboxRelayConfig=
 |{enabled:false}
 |{enabled:true;targetOrigin:string;candidateSha:string};

export function resolveRazorpaySandboxRelay(env:Env):RazorpaySandboxRelayConfig{
 const targetOrigin=text(env.PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_ORIGIN);
 const candidateSha=text(env.PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_SHA);
 if(!targetOrigin&&!candidateSha)return{enabled:false};
 if(!targetOrigin||!candidateSha)throw new Error("Razorpay sandbox relay target origin and SHA must be configured together");
 if(text(env.PAWSPACE_DEPLOYMENT_ENV)!=="staging"||text(env.PAWSPACE_PAYMENT_ENV)!=="sandbox"||text(env.PAWSPACE_PAYMENT_LIVE_APPROVED)==="true")throw new Error("Razorpay sandbox relay is permitted only on sandbox-locked staging");
 if(!sha.test(candidateSha))throw new Error("Razorpay sandbox relay requires an exact lowercase candidate SHA");
 let url:URL;try{url=new URL(targetOrigin)}catch{throw new Error("Razorpay sandbox relay target origin is invalid")}
 if(url.protocol!=="https:"||url.username||url.password||url.port||url.search||url.hash||!checkoutHost.test(url.hostname)||!['','/'].includes(url.pathname))throw new Error("Razorpay sandbox relay target must be an exact isolated PR674 workers.dev origin");
 return{enabled:true,targetOrigin:`https://${url.hostname}`,candidateSha};
}

export async function forwardVerifiedRazorpaySandboxWebhook(env:Env,input:{rawBody:string;signature:string;eventId:string;contentType?:string;fetchImpl?:FetchLike}){
 const config=resolveRazorpaySandboxRelay(env);if(!config.enabled)return{enabled:false as const,delivered:false as const};
 const fetchImpl=input.fetchImpl??fetch;
 try{
  const response=await fetchImpl(`${config.targetOrigin}/api/razorpay-webhook`,{
   method:"POST",headers:{"content-type":input.contentType||"application/json","x-razorpay-signature":input.signature,"x-razorpay-event-id":input.eventId,"x-pawspace-relay-candidate-sha":config.candidateSha},
   body:input.rawBody,redirect:"manual",signal:AbortSignal.timeout(15_000),
  });
  return{enabled:true as const,delivered:response.ok,status:response.status,targetSha:config.candidateSha};
 }catch(error){
  return{enabled:true as const,delivered:false as const,status:0,targetSha:config.candidateSha,reason:error instanceof Error?error.name:"relay_fetch_failed"};
 }
}
