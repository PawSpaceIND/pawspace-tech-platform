const LOCAL_OTP_HOSTS=new Set(["terminal.local","localhost","127.0.0.1"]);
const DEVELOPMENT_ASSERTION_SECRET="pawspace-local-development-otp-assertion-secret-v1";

function processEnv(name:string){
  try{return typeof process!=="undefined"&&process?.env?String(process.env[name]??"").trim().toLowerCase():"";}catch{return"";}
}
function runtimeEnv(runtime:Record<string,unknown>,name:string){return String(runtime[name]??"").trim().toLowerCase();}
function localHost(request:Request){try{return LOCAL_OTP_HOSTS.has(new URL(request.url).hostname);}catch{return false;}}
function localPreviewEnabled(runtime:Record<string,unknown>={}){
  const nodeEnv=processEnv("NODE_ENV");
  const runtimePreview=runtimeEnv(runtime,"PAWSPACE_LOCAL_PREVIEW")==="on";
  const processPreview=processEnv("PAWSPACE_LOCAL_PREVIEW")==="on";
  return nodeEnv==="development"||runtimePreview||((nodeEnv==="development"||nodeEnv==="test")&&processPreview);
}

/** Sandbox OTP is automatically available only to the local development runtime. A request hostname
 * alone is never authority: an explicit live identity mode always wins, and the Vite/Cloudflare dev
 * server injects PAWSPACE_LOCAL_PREVIEW=on as a non-secret local Worker binding. */
export function developmentOtpSandboxEnabled(request:Request,runtime:Record<string,unknown>={}){
  if(runtimeEnv(runtime,"PAWSPACE_IDENTITY_ENV")==="live")return false;
  return localHost(request)&&localPreviewEnabled(runtime);
}

/** A checked-in development secret is intentionally NOT a deployment credential. It is accepted only
 * in an explicit local development/preview runtime so request+verify works with no live provider creds.
 * Production and live identity mode still return an empty value and therefore fail closed. */
export function resolveOtpAssertionSecret(runtime:Record<string,unknown>={}){
  const configured=String(runtime.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT??"").trim();
  if(configured.length>=32)return configured;
  if(runtimeEnv(runtime,"PAWSPACE_IDENTITY_ENV")==="live")return"";
  if(localPreviewEnabled(runtime))return DEVELOPMENT_ASSERTION_SECRET;
  return"";
}
