/**
 * Fail-closed adapter for triggering Haptik OUTBOUND voice calls.
 * PawSpace decides who to call and calls Haptik's outbound API.
 */

type HEnv = Record<string, unknown>;
export type OutboundTrigger =
  | { connected: true; callRef: string }
  | { connected: false; reason: string };

const HAPTIK_OUTBOUND_TIMEOUT_MS=2500;
const HAPTIK_ALLOWED_SUFFIXES=["haptikapi.com","hellohaptik.com"] as const;

function isPrivateOrSpecialIp(hostname:string){
  const host=hostname.replace(/^\[|\]$/g,"").toLowerCase();
  if(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)){
    const parts=host.split(".").map(Number);
    if(parts.some(part=>part<0||part>255))return true;
    const[a,b]=parts;
    return a===10||a===127||a===0||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||a>=224;
  }
  if(host.includes(":"))return host==="::1"||host==="::"||host.startsWith("fe80:")||host.startsWith("fc")||host.startsWith("fd");
  return false;
}

export function isAllowedHaptikOutboundUrl(value:string){
  let url:URL;
  try{url=new URL(value);}catch{return false;}
  if(url.protocol!=="https:"||url.username||url.password)return false;
  const host=url.hostname.toLowerCase().replace(/\.$/,"");
  if(!host||host==="localhost"||host.endsWith(".localhost")||isPrivateOrSpecialIp(host))return false;
  return HAPTIK_ALLOWED_SUFFIXES.some(suffix=>host===suffix||host.endsWith(`.${suffix}`));
}

export function haptikOutboundConfigured(env: HEnv): boolean {
  return Boolean(String(env?.HAPTIK_OUTBOUND_API_KEY || env?.HAPTIK_API_KEY || "").trim() && String(env?.HAPTIK_OUTBOUND_URL || "").trim());
}

export async function triggerHaptikCall(env: HEnv, input: { phone: string; campaign: string; context?: Record<string, unknown> }): Promise<OutboundTrigger> {
  const key = String(env?.HAPTIK_OUTBOUND_API_KEY || env?.HAPTIK_API_KEY || "").trim();
  const url = String(env?.HAPTIK_OUTBOUND_URL || "").trim();
  if (!key || !url) return { connected: false, reason: "Haptik outbound is not connected (HAPTIK_OUTBOUND_API_KEY / HAPTIK_OUTBOUND_URL not configured)" };
  if(!isAllowedHaptikOutboundUrl(url))return{connected:false,reason:"Haptik outbound URL is not on the approved Haptik HTTPS allowlist"};
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),HAPTIK_OUTBOUND_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "POST", redirect:"error", signal:controller.signal, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ phone: input.phone, campaign: input.campaign, context: input.context || {} }) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return { connected: false, reason: `Haptik outbound call failed (${response.status}): ${String((body.error as Record<string, unknown> | undefined)?.message || "request failed")}` };
    const callRef = String(body.callId || body.id || body.reference || "").trim();
    return { connected: true, callRef };
  } catch {
    return { connected: false, reason: controller.signal.aborted?"Haptik outbound request timed out":"Haptik outbound request failed" };
  } finally {
    clearTimeout(timeout);
  }
}
