/** Sandbox-only RazorpayX payout provider boundary. No live credential path exists here. */
type Env=Record<string,unknown>;
export type RazorpayXPayoutMode="IMPS"|"NEFT"|"RTGS";
export type RazorpayXResult=
 |{connected:true;environment:"sandbox";payout:Record<string,unknown>}
 |{connected:false;environment:"sandbox"|"unconfigured";reason:string};

const API="https://api.razorpay.com";
const MAX_BYTES=64*1024;
const value=(env:Env,name:string)=>String(env?.[name]??"").trim();

export function razorpayXSandboxReadiness(env:Env){
 const payment=value(env,"PAWSPACE_PAYMENT_ENV").toLowerCase();
 const payout=value(env,"PAWSPACE_RAZORPAYX_ENV").toLowerCase();
 const keyId=value(env,"RAZORPAYX_KEY_ID_SANDBOX");
 const keySecret=value(env,"RAZORPAYX_KEY_SECRET_SANDBOX");
 const accountNumber=value(env,"RAZORPAYX_ACCOUNT_NUMBER_SANDBOX");
 const webhookSecret=value(env,"RAZORPAYX_WEBHOOK_SECRET_SANDBOX");
 const problems:string[]=[];
 if(payment!=="sandbox")problems.push("PAWSPACE_PAYMENT_ENV must equal sandbox");
 if(payout!=="sandbox")problems.push("PAWSPACE_RAZORPAYX_ENV must equal sandbox");
 if(value(env,"PAWSPACE_RAZORPAYX_LIVE_APPROVED").toLowerCase()!=="false")problems.push("PAWSPACE_RAZORPAYX_LIVE_APPROVED must equal false");
 if(!keyId.startsWith("rzp_test_"))problems.push("RazorpayX TEST key is required");
 if(!keySecret)problems.push("RAZORPAYX_KEY_SECRET_SANDBOX is required");
 if(!accountNumber)problems.push("RAZORPAYX_ACCOUNT_NUMBER_SANDBOX is required");
 return{ready:problems.length===0,problems,keyIdConfigured:Boolean(keyId),accountNumberConfigured:Boolean(accountNumber),webhookSecretConfigured:Boolean(webhookSecret),environment:problems.length?"unconfigured":"sandbox" as const};
}

function providerBase(env:Env){
 const raw=value(env,"PAWSPACE_RAZORPAYX_API_BASE_URL")||API;
 if(raw===API)return raw;
 if(value(env,"PAWSPACE_RAZORPAYX_CONTRACT_TEST").toLowerCase()!=="true")throw new Error("RazorpayX provider override is allowed only for contract tests");
 const url=new URL(raw);
 if(!["localhost","127.0.0.1","[::1]"].includes(url.hostname)||!["http:","https:"].includes(url.protocol))throw new Error("RazorpayX contract-test provider must use loopback HTTP(S)");
 return raw.replace(/\/$/,"");
}

async function bounded(response:Response){
 const length=Number(response.headers.get("content-length")||0);
 if(Number.isFinite(length)&&length>MAX_BYTES)throw new Error("RazorpayX provider response exceeded the size limit");
 if(!response.body)return"";
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 for(;;){const{done,value}=await reader.read();if(done)break;if(!value)continue;total+=value.byteLength;if(total>MAX_BYTES){await reader.cancel();throw new Error("RazorpayX provider response exceeded the size limit");}chunks.push(value);}
 const out=new Uint8Array(total);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder().decode(out);
}

async function request(env:Env,path:string,init:RequestInit){
 const timeout=Math.max(250,Math.min(Number(env.PAWSPACE_RAZORPAYX_TIMEOUT_MS||10_000),30_000));
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 try{
  const response=await fetch(`${providerBase(env)}${path}`,{...init,redirect:"manual",signal:controller.signal});
  const raw=await bounded(response);let body:Record<string,unknown>={};
  try{const parsed=JSON.parse(raw);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))body=parsed as Record<string,unknown>;}catch{}
  return{response,body};
 }catch(error){if(error instanceof Error&&error.name==="AbortError")throw new Error(`RazorpayX request timed out after ${timeout}ms`);throw error;}finally{clearTimeout(timer);}
}

function credentials(env:Env){
 const readiness=razorpayXSandboxReadiness(env);if(!readiness.ready)return{ok:false as const,reason:readiness.problems.join("; ")};
 return{ok:true as const,keyId:value(env,"RAZORPAYX_KEY_ID_SANDBOX"),keySecret:value(env,"RAZORPAYX_KEY_SECRET_SANDBOX"),accountNumber:value(env,"RAZORPAYX_ACCOUNT_NUMBER_SANDBOX")};
}
const auth=(keyId:string,keySecret:string)=>`Basic ${btoa(`${keyId}:${keySecret}`)}`;
const safeReference=(value:string)=>value.replace(/[^A-Za-z0-9_.:-]/g,"_").slice(0,40);

export async function createRazorpayXSandboxPayout(env:Env,input:{localPayoutId:string;bookingId?:string|null;statementId?:string|null;providerId:string;fundAccountId:string;amountPaise:number;currency:string;idempotencyKey:string;mode?:RazorpayXPayoutMode}):Promise<RazorpayXResult>{
 const c=credentials(env);if(!c.ok)return{connected:false,environment:"unconfigured",reason:c.reason};
 if(!/^fa_[A-Za-z0-9]+$/.test(input.fundAccountId))return{connected:false,environment:"sandbox",reason:"A RazorpayX TEST fund account id is required"};
 if(!Number.isSafeInteger(input.amountPaise)||input.amountPaise<100)return{connected:false,environment:"sandbox",reason:"RazorpayX payout amount must be integer paise and at least 100"};
 if(input.currency!=="INR")return{connected:false,environment:"sandbox",reason:"RazorpayX sandbox payout currency must be INR"};
 const idempotency=input.idempotencyKey.trim();if(!idempotency)return{connected:false,environment:"sandbox",reason:"RazorpayX payout idempotency key is required"};
 const mode=input.mode||"IMPS";if(!["IMPS","NEFT","RTGS"].includes(mode))return{connected:false,environment:"sandbox",reason:"Unsupported RazorpayX payout mode"};
 try{
  const{response,body}=await request(env,"/v1/payouts",{method:"POST",headers:{authorization:auth(c.keyId,c.keySecret),"content-type":"application/json","X-Payout-Idempotency":idempotency},body:JSON.stringify({account_number:c.accountNumber,fund_account_id:input.fundAccountId,amount:input.amountPaise,currency:"INR",mode,purpose:"payout",queue_if_low_balance:true,reference_id:safeReference(input.localPayoutId),narration:"PawSpace Partner",notes:{pawspace_payout_id:input.localPayoutId,booking_id:input.bookingId||"",statement_id:input.statementId||"",provider_id:input.providerId,pawspace_environment:"sandbox"}})});
  if(!response.ok)return{connected:false,environment:"sandbox",reason:`RazorpayX TEST payout create failed (${response.status}): ${String((body.error as Record<string,unknown>|undefined)?.description||"request failed")}`};
  if(!String(body.id||"").startsWith("pout_"))return{connected:false,environment:"sandbox",reason:"RazorpayX did not return a payout id"};
  return{connected:true,environment:"sandbox",payout:body};
 }catch(error){return{connected:false,environment:"sandbox",reason:`RazorpayX TEST request failed: ${error instanceof Error?error.message:String(error)}`};}
}

export async function fetchRazorpayXSandboxPayout(env:Env,payoutId:string):Promise<RazorpayXResult>{
 const c=credentials(env);if(!c.ok)return{connected:false,environment:"unconfigured",reason:c.reason};
 if(!/^pout_[A-Za-z0-9]+$/.test(payoutId))return{connected:false,environment:"sandbox",reason:"A RazorpayX payout id is required"};
 try{const{response,body}=await request(env,`/v1/payouts/${encodeURIComponent(payoutId)}`,{headers:{authorization:auth(c.keyId,c.keySecret)}});if(!response.ok)return{connected:false,environment:"sandbox",reason:`RazorpayX TEST payout fetch failed (${response.status})`};return{connected:true,environment:"sandbox",payout:body};}
 catch(error){return{connected:false,environment:"sandbox",reason:`RazorpayX TEST fetch failed: ${error instanceof Error?error.message:String(error)}`};}
}
