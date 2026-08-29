const LOCAL_OTP_HOSTS=new Set(["terminal.local","localhost","127.0.0.1"]);
const DEVELOPMENT_ASSERTION_SECRET="pawspace-local-development-otp-assertion-secret-v1";

function processEnv(name:string){
  try{return typeof process!=="undefined"&&process?.env?String(process.env[name]??"").trim().toLowerCase():"";}catch{return"";}
}

function localHost(request:Request){try{return LOCAL_OTP_HOSTS.has(new URL(request.url).hostname);}catch{return false;}}

/** Sandbox OTP is automatically available only to the local development runtime. A request hostname
 * alone is never authority: deployed production builds do not have NODE_ENV=development, and an
 * explicit live identity mode always wins. PAWSPACE_LOCAL_PREVIEW=on keeps controlled preview/test
 * harnesses on the same local-host boundary without opening production. */
export function developmentOtpSandboxEnabled(request:Request,runtime:Record<string,unknown>={}){
  if(String(runtime.PAWSPACE_IDENTITY_ENV??"sandbox").trim().toLowerCase()==="live")return false;
  const nodeEnv=processEnv("NODE_ENV");
  const declaredDevelopment=nodeEnv==="development";
  const explicitLocalPreview=(nodeEnv==="development"||nodeEnv==="test")&&processEnv("PAWSPACE_LOCAL_PREVIEW")==="on";
  return localHost(request)&&(declaredDevelopment||explicitLocalPreview);
}

/** A checked-in development secret is intentionally NOT a deployment credential. It is accepted only
 * in an explicit local development/preview runtime so request+verify works with no live provider creds.
 * Production and live identity mode still return an empty value and therefore fail closed. */
export function resolveOtpAssertionSecret(runtime:Record<string,unknown>={}){
  const configured=String(runtime.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT??"").trim();
  if(configured.length>=32)return configured;
  if(String(runtime.PAWSPACE_IDENTITY_ENV??"sandbox").trim().toLowerCase()==="live")return"";
  const nodeEnv=processEnv("NODE_ENV");
  if(nodeEnv==="development"||((nodeEnv==="development"||nodeEnv==="test")&&processEnv("PAWSPACE_LOCAL_PREVIEW")==="on"))return DEVELOPMENT_ASSERTION_SECRET;
  return"";
}
