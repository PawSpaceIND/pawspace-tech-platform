type Env=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const digits=(value:unknown)=>text(value).replace(/\D/g,"");

export type CommunicationRuntimeMode="sandbox"|"live";

/**
 * External communication is live only when BOTH communication and payment runtimes are explicitly live.
 * Any missing, unknown or sandbox value fails closed to sandbox. This prevents a production worker that
 * still carries live provider secrets from using them while the platform is operating under sandbox
 * payment isolation.
 */
export function communicationRuntimeMode(env:Env):CommunicationRuntimeMode{
 const communication=text(env.PAWSPACE_COMMUNICATION_ENV).toLowerCase();
 const payment=text(env.PAWSPACE_PAYMENT_ENV).toLowerCase();
 return communication==="live"&&payment==="live"?"live":"sandbox";
}

export function liveCommunicationEnabled(env:Env){
 return text(env.PAWSPACE_DEPLOYMENT_ENV).toLowerCase()==="production"&&communicationRuntimeMode(env)==="live";
}

export function metaWhatsAppCredentials(env:Env){
 const mode=communicationRuntimeMode(env);
 if(mode==="live")return{
  mode,
  token:text(env.META_WHATSAPP_ACCESS_TOKEN),
  phoneNumberId:text(env.META_WHATSAPP_PHONE_NUMBER_ID),
  wabaId:text(env.META_WHATSAPP_WABA_ID),
 };
 return{
  mode,
  token:text(env.META_WHATSAPP_UAT_ACCESS_TOKEN),
  phoneNumberId:text(env.META_WHATSAPP_PHONE_NUMBER_ID_UAT),
  wabaId:text(env.META_WHATSAPP_WABA_ID_UAT),
 };
}

export function sandboxRecipientAllowed(env:Env,recipient:string){
 if(communicationRuntimeMode(env)==="live")return true;
 const target=digits(recipient);
 if(!target)return false;
 const allowlist=text(env.PAWSPACE_COMMUNICATION_UAT_ALLOWLIST).split(",").map(digits).filter(Boolean);
 return allowlist.includes(target);
}
