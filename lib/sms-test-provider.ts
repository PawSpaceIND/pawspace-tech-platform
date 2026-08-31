export const PAWSPACE_SMS_TEST_MESSAGE="PawSpace SMS API test successful. No action is required.";

type Fetcher=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>;
type Fast2SmsPayload={return?:boolean;request_id?:string;message?:string[]|string};

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

  const response=await fetcher(url,{method:"GET",headers:{Authorization:apiKey.trim(),accept:"application/json"}});
  let payload:Fast2SmsPayload|null=null;
  try{payload=await response.json() as Fast2SmsPayload;}catch{}
  if(!response.ok||payload?.return!==true)throw new Error(`Fast2SMS test request rejected (${response.status})`);
  return {requestId:typeof payload.request_id==="string"?payload.request_id:null};
}
