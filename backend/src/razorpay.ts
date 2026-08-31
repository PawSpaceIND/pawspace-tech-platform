export type FetchLike=(input:string,init?:RequestInit)=>Promise<Response>;

export interface RazorpayOrderResult { id:string; amount:number; currency:string; status:string; }
export interface RazorpayRefundResult { id:string; paymentId:string; amount:number; status:string; }
export interface RazorpayPayoutResult { id:string; amount:number; currency:string; status:string; }

const API_BASE="https://api.razorpay.com/v1";
const configured=(env:NodeJS.ProcessEnv,key:string)=>Boolean(env[key]?.trim());
const fail=(code:string,message:string,statusCode=503):never=>{throw Object.assign(new Error(message),{code,statusCode});};
const subunits=(amount:number)=>{if(!Number.isFinite(amount)||amount<=0)fail("INVALID_PROVIDER_AMOUNT","Provider amount must be positive",422);return Math.round(amount*100);};
const basicAuth=(keyId:string,keySecret:string)=>`Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;

async function parseResponse(response:Response,code:string){
  let body:unknown;
  try{body=await response.json();}catch{body=null;}
  if(!response.ok){const detail=body&&typeof body==="object"&&"error" in body?JSON.stringify((body as {error:unknown}).error):response.statusText;fail(code,`${code}: ${detail||`HTTP ${response.status}`}`,502);}
  if(!body||typeof body!=="object")fail(code,`${code}: malformed provider response`,502);
  return body as Record<string,unknown>;
}

function paymentCredentials(env:NodeJS.ProcessEnv){
  const keyId=env.RAZORPAY_KEY_ID?.trim(),keySecret=env.RAZORPAY_KEY_SECRET?.trim();
  if(!keyId||!keySecret)fail("PAYMENTS_NOT_CONFIGURED","Razorpay key id and secret are required");
  return {keyId,keySecret};
}

export function paymentReadiness(env:NodeJS.ProcessEnv=process.env){
  const missing=["RAZORPAY_KEY_ID","RAZORPAY_KEY_SECRET","RAZORPAY_WEBHOOK_SECRET"].filter(key=>!configured(env,key));
  const providerMode=env.RAZORPAY_MODE?.trim();
  if(providerMode!=="test"&&providerMode!=="live")missing.push("RAZORPAY_MODE(test|live)");
  return {ready:missing.length===0,providerMode:providerMode==="test"||providerMode==="live"?providerMode:null,missing};
}

export function payoutReadiness(env:NodeJS.ProcessEnv=process.env){
  const missing=["RAZORPAY_KEY_ID","RAZORPAY_KEY_SECRET","RAZORPAYX_ACCOUNT_NUMBER","RAZORPAYX_FUND_ACCOUNT_MAP"].filter(key=>!configured(env,key));
  const providerMode=env.RAZORPAYX_MODE?.trim();
  if(providerMode!=="test"&&providerMode!=="live")missing.push("RAZORPAYX_MODE(test|live)");
  if(env.RAZORPAYX_IP_ALLOWLIST_CONFIRMED!=="true")missing.push("RAZORPAYX_IP_ALLOWLIST_CONFIRMED=true");
  return {ready:missing.length===0,providerMode:providerMode==="test"||providerMode==="live"?providerMode:null,missing};
}

export function resolveRazorpayXFundAccount(providerId:string,env:NodeJS.ProcessEnv=process.env){
  const raw=env.RAZORPAYX_FUND_ACCOUNT_MAP?.trim();
  if(!raw)fail("PAYOUT_FUND_ACCOUNT_NOT_CONFIGURED","RazorpayX provider fund-account map is required");
  let map:Record<string,unknown>;
  try{map=JSON.parse(raw) as Record<string,unknown>;}catch{fail("PAYOUT_FUND_ACCOUNT_MAP_INVALID","RazorpayX fund-account map must be valid JSON");}
  const fundAccountId=map[providerId];
  if(typeof fundAccountId!=="string"||!fundAccountId.startsWith("fa_"))fail("PAYOUT_FUND_ACCOUNT_NOT_CONFIGURED",`No RazorpayX fund account is configured for provider ${providerId}`,422);
  return fundAccountId;
}

export async function createRazorpayOrder(amount:number,receipt:string,fetchImpl:FetchLike=globalThis.fetch,env:NodeJS.ProcessEnv=process.env):Promise<RazorpayOrderResult>{
  const {keyId,keySecret}=paymentCredentials(env);const amountSubunits=subunits(amount);
  const response=await fetchImpl(`${API_BASE}/orders`,{method:"POST",headers:{authorization:basicAuth(keyId,keySecret),"content-type":"application/json"},body:JSON.stringify({amount:amountSubunits,currency:"INR",receipt,notes:{pawspace_receipt:receipt}})});
  const body=await parseResponse(response,"RAZORPAY_ORDER_CREATE_FAILED");
  if(typeof body.id!=="string"||!body.id.startsWith("order_"))fail("RAZORPAY_ORDER_RESPONSE_INVALID","Razorpay order response did not contain a valid order id",502);
  if(Number(body.amount)!==amountSubunits||body.currency!=="INR")fail("RAZORPAY_ORDER_AMOUNT_MISMATCH","Razorpay order amount/currency did not match PawSpace",502);
  return {id:body.id,amount:amountSubunits,currency:"INR",status:String(body.status??"created")};
}

export async function createRazorpayRefund(paymentId:string,amount:number,idempotencyKey:string,fetchImpl:FetchLike=globalThis.fetch,env:NodeJS.ProcessEnv=process.env):Promise<RazorpayRefundResult>{
  const {keyId,keySecret}=paymentCredentials(env);if(!paymentId.startsWith("pay_"))fail("RAZORPAY_PAYMENT_ID_INVALID","A Razorpay payment id is required for refund",422);const amountSubunits=subunits(amount);
  const response=await fetchImpl(`${API_BASE}/payments/${encodeURIComponent(paymentId)}/refund`,{method:"POST",headers:{authorization:basicAuth(keyId,keySecret),"content-type":"application/json","X-Refund-Idempotency":idempotencyKey},body:JSON.stringify({amount:amountSubunits,receipt:idempotencyKey,notes:{pawspace_refund_key:idempotencyKey}})});
  const body=await parseResponse(response,"RAZORPAY_REFUND_CREATE_FAILED");
  if(typeof body.id!=="string"||!body.id.startsWith("rfnd_"))fail("RAZORPAY_REFUND_RESPONSE_INVALID","Razorpay refund response did not contain a valid refund id",502);
  if(body.payment_id!==paymentId||Number(body.amount)!==amountSubunits)fail("RAZORPAY_REFUND_AMOUNT_MISMATCH","Razorpay refund did not match the requested PawSpace payment/amount",502);
  return {id:body.id,paymentId,amount:amountSubunits,status:String(body.status??"processing")};
}

export async function createRazorpayXPayout(amount:number,fundAccountId:string,idempotencyKey:string,fetchImpl:FetchLike=globalThis.fetch,env:NodeJS.ProcessEnv=process.env):Promise<RazorpayPayoutResult>{
  const readiness=payoutReadiness(env);if(!readiness.ready)fail("PAYOUTS_NOT_CONFIGURED",`RazorpayX is not operational: ${readiness.missing.join(", ")}`);
  const {keyId,keySecret}=paymentCredentials(env);const accountNumber=env.RAZORPAYX_ACCOUNT_NUMBER!.trim();const amountSubunits=subunits(amount);
  const response=await fetchImpl(`${API_BASE}/payouts`,{method:"POST",headers:{authorization:basicAuth(keyId,keySecret),"content-type":"application/json","X-Payout-Idempotency":idempotencyKey},body:JSON.stringify({account_number:accountNumber,fund_account_id:fundAccountId,amount:amountSubunits,currency:"INR",mode:env.RAZORPAYX_PAYOUT_MODE?.trim()||"IMPS",purpose:"payout",queue_if_low_balance:false,reference_id:idempotencyKey,narration:"PawSpace provider payout",notes:{pawspace_payout_key:idempotencyKey}})});
  const body=await parseResponse(response,"RAZORPAYX_PAYOUT_CREATE_FAILED");
  if(typeof body.id!=="string"||!body.id.startsWith("pout_"))fail("RAZORPAYX_PAYOUT_RESPONSE_INVALID","RazorpayX response did not contain a valid payout id",502);
  if(Number(body.amount)!==amountSubunits||body.currency!=="INR")fail("RAZORPAYX_PAYOUT_AMOUNT_MISMATCH","RazorpayX payout amount/currency did not match PawSpace",502);
  return {id:body.id,amount:amountSubunits,currency:"INR",status:String(body.status??"processing")};
}
