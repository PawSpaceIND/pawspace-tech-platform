import{authError,database}from"../../../lib/server-auth";
import{applyIdfyCallback}from"../../../lib/idfy-callback-boundary";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../lib/voice-safe-fetch";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const MAX_CALLBACK_BYTES=65_536;

/**
 * IDfy verification callbacks (Aadhaar / PAN / address outcomes).
 *
 * Unauthenticated by session on purpose - IDfy has no cookie - and therefore verified by shared secret
 * instead. Everything that decides whether the payload is trustworthy lives in applyIdfyCallback; this
 * route only bounds the body and hands over the EXACT bytes, because those bytes are what the signature
 * covers. Re-serialising a parsed object here would change the string being verified.
 *
 * BOUNDED WHILE STREAMING, not after. The first version checked content-length and then called
 * request.text(), which is two separate holes: a chunked body carries no content-length at all, so 40 MiB
 * was buffered in full before the limit was consulted; and `raw.length` counts UTF-16 code units, so an
 * 80,000-byte multibyte payload measured as 40,000 and passed. readBoundedRequestText - already used by
 * the telephony callback for the same reason - counts received BYTES as they arrive and cancels the
 * stream the moment the limit is crossed. This path is gateway-allowlisted, so an oversized body is
 * reachable with no credential at all: the limit has to bite before the allocation, not after it.
 */
export async function POST(request:Request){
  try{
    const{env}=await import("cloudflare:workers");
    const runtime=env as unknown as Record<string,unknown>;
    let raw:string;
    try{raw=await readBoundedRequestText(request,MAX_CALLBACK_BYTES);}
    catch(error){if(error instanceof VoiceFetchRefused)return json({error:"Verification callback payload is too large"},413);throw error;}
    const db=await database();
    const result=await applyIdfyCallback(db,runtime,{rawBody:raw,headers:request.headers});
    if(!result.accepted)return json({error:result.reason},result.status);
    return json({ok:true,applicationId:result.applicationId,verificationType:result.verificationType,outcome:result.outcome,duplicate:result.duplicate},result.status);
  }catch(error){return authError(error,"Unable to process verification callback");}
}
