const OTP_MIN = 100_000;
const OTP_RANGE = 900_000;
const UINT32_SIZE = 0x1_0000_0000;
const OTP_LIMIT = UINT32_SIZE - (UINT32_SIZE % OTP_RANGE);
const encoder = new TextEncoder();

export function generateSixDigitOtp(){
  const values=new Uint32Array(1);
  let value:number;
  do{
    crypto.getRandomValues(values);
    value=values[0]!;
  }while(value>=OTP_LIMIT);
  return String(OTP_MIN+(value%OTP_RANGE));
}

export async function hmacOtp(challengeId:string,otp:string,pepper:string){
  const key=await crypto.subtle.importKey("raw",encoder.encode(pepper),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const digest=await crypto.subtle.sign("HMAC",key,encoder.encode(`${challengeId}:${otp}`));
  return bytesToHex(new Uint8Array(digest));
}

export function equalConstantTime(left:string,right:string){
  const a=encoder.encode(left),b=encoder.encode(right);
  if(a.length!==b.length)return false;
  let diff=0;
  for(let index=0;index<a.length;index++)diff|=a[index]^b[index];
  return diff===0;
}

export async function getOtpSecurityConfig(){
  const {env}=await import("cloudflare:workers");
  const runtime=env as unknown as Record<string,unknown>;
  const pepper=String(runtime.PAWSPACE_OTP_PEPPER||"").trim();
  const assertionSecret=String(runtime.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT||"").trim();
  if(pepper.length<32)throw new Error("PAWSPACE_OTP_PEPPER is not configured");
  if(assertionSecret&&equalConstantTime(pepper,assertionSecret))throw new Error("PAWSPACE_OTP_PEPPER must be separate from the identity assertion secret");
  return{
    pepper,
    identityEnv:String(runtime.PAWSPACE_IDENTITY_ENV||"").trim().toLowerCase(),
    testSecret:String(runtime.PAWSPACE_IDENTITY_TEST_SECRET||"").trim(),
  };
}

export function mayDiscloseSandboxOtp(identityEnv:string,configuredTestSecret:string,suppliedTestSecret?:string){
  if(identityEnv!=="sandbox"||configuredTestSecret.length<32||!suppliedTestSecret)return false;
  return equalConstantTime(configuredTestSecret,suppliedTestSecret);
}

function bytesToHex(bytes:Uint8Array){
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,"0")).join("");
}
