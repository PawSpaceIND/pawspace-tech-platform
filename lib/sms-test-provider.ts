export const PAWSPACE_SMS_TEST_MESSAGE="PawSpace SMS API test successful. No action is required.";
const FAST2SMS_TIMEOUT_MS=4000;

type Fetcher=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;
type Fast2SmsPayload={return?:boolean;request_id?:string;message?:string[]|string;status_code?:string|number};

export class Fast2SmsProviderError extends Error{
  readonly httpStatus:number|null;
  readonly providerStatusCode:string|null;
  constructor(httpStatus:number|null,providerStatusCode:string|null){
    const detail=httpStatus===null?"transport":`HTTP ${httpStatus}${providerStatusCode?` / code ${providerStatusCode}`:""}`;
    super(`Fast2SMS request rejected (${detail})`);
    this.name="Fast2SmsProviderError";
    this.httpStatus=httpStatus;
    this.providerStatusCode=providerStatusCode;
  }
}

export function normalizeIndianMobile(value:string){
  const digits=value.replace(/\D/g,"");
  const national=digits.length===12&&digits.startsWith("91")?digits.slice(2):digits;
  return /^[6-9]\d{9}$/.test(national)?national:null;
}

export function parseSmsTestAllowlist(value:string){
  return new Set(value.split(",").map(normalizeIndianMobile).filter((phone):phone is string=>Boolean(phone)));
}

export async function sendFast2SmsMessage({apiKey,phone,message,udf1="pawspace-live-message",fetcher=fetch}:{apiKey:string;phone:string;message:string;udf1?:string;fetcher?:Fetcher}){
  const normalized=normalizeIndianMobile(phone);
  if(!normalized)throw new Error("Invalid Indian mobile number");
  if(!apiKey.trim())throw new Error("Fast2SMS API key is not configured");
  const safeMessage=String(message||"").trim();
  if(!safeMessage)throw new Error("SMS message is required");
  const safeUdf=String(udf1||"").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,64)||"pawspace-live-message";

  const url="https://www.fast2sms.com/dev/bulkV2";
  const requestBody=new URLSearchParams({route:"q",message:safeMessage,numbers:normalized,sms_details:"1",udf1:safeUdf}).toString();

  // [AUDIT-2026-09-06 ②] Bound the outbound Fast2SMS call so a hung gateway connection cannot stall the
  // OTP request path indefinitely. An abort surfaces as a transport-class provider error, fail-safe.
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),FAST2SMS_TIMEOUT_MS);
  let response:Response;
  try{
    response=await fetcher(url,{method:"POST",headers:{Authorization:apiKey.trim(),accept:"application/json","content-type":"application/x-www-form-urlencoded;charset=UTF-8"},body:requestBody,signal:controller.signal});
  }catch{
    throw new Fast2SmsProviderError(null,"transport");
  }finally{
    clearTimeout(timeout);
  }
  let payload:Fast2SmsPayload|null=null;
  try{payload=await response.json() as Fast2SmsPayload;}catch{}
  if(!response.ok||payload?.return!==true){
    const providerStatusCode=payload?.status_code===undefined?null:String(payload.status_code);
    throw new Fast2SmsProviderError(response.status,providerStatusCode);
  }
  return {requestId:typeof payload.request_id==="string"?payload.request_id:null};
}

export async function sendFast2SmsTest({apiKey,phone,fetcher=fetch}:{apiKey:string;phone:string;fetcher?:Fetcher}){
  return sendFast2SmsMessage({apiKey,phone,message:PAWSPACE_SMS_TEST_MESSAGE,udf1:"pawspace-sms-test",fetcher});
}
