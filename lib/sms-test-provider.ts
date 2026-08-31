export const PAWSPACE_SMS_TEST_MESSAGE="PawSpace SMS API test successful. No action is required.";

type Fetcher=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;
type Fast2SmsPayload={return?:boolean;request_id?:string;message?:string[]|string;status_code?:string|number};

export class Fast2SmsProviderError extends Error{
  readonly httpStatus:number|null;
  readonly providerStatusCode:string|null;
  constructor(httpStatus:number|null,providerStatusCode:string|null){
    const detail=httpStatus===null?"transport":`HTTP ${httpStatus}${providerStatusCode?` / code ${providerStatusCode}`:""}`;
    super(`Fast2SMS test request rejected (${detail})`);
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

export async function sendFast2SmsTest({apiKey,phone,fetcher=fetch}:{apiKey:string;phone:string;fetcher?:Fetcher}){
  const normalized=normalizeIndianMobile(phone);
  if(!normalized)throw new Error("Invalid Indian mobile number");
  if(!apiKey.trim())throw new Error("Fast2SMS API key is not configured");

  const url=new URL("https://www.fast2sms.com/dev/bulkV2");
  url.searchParams.set("route","q");
  url.searchParams.set("message",PAWSPACE_SMS_TEST_MESSAGE);
  url.searchParams.set("numbers",normalized);
  url.searchParams.set("sms_details","1");
  url.searchParams.set("udf1","pawspace-sms-test");

  let response:Response;
  try{
    response=await fetcher(url,{method:"GET",headers:{Authorization:apiKey.trim(),accept:"application/json"}});
  }catch{
    throw new Fast2SmsProviderError(null,"transport");
  }
  let payload:Fast2SmsPayload|null=null;
  try{payload=await response.json() as Fast2SmsPayload;}catch{}
  if(!response.ok||payload?.return!==true){
    const providerStatusCode=payload?.status_code===undefined?null:String(payload.status_code);
    throw new Fast2SmsProviderError(response.status,providerStatusCode);
  }
  return {requestId:typeof payload.request_id==="string"?payload.request_id:null};
}
