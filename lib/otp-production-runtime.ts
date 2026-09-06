const text=(value:unknown)=>String(value??"").trim();

/** Production OTP is opt-in twice: this must be a production artifact and Fast2SMS must be
 * configured as a Worker secret. Merely setting a deployment label cannot turn on delivery. */
export function productionOtpEnabled(runtime:Record<string,unknown>={}){
 return text(runtime.PAWSPACE_DEPLOYMENT_ENV).toLowerCase()==="production"&&text(runtime.FAST2SMS_API_KEY).length>0;
}
