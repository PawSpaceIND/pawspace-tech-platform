import{authError,database}from"../../../lib/server-auth";
import{applyIdfyCallback}from"../../../lib/idfy-callback-boundary";

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
 * The body is bounded before it is buffered: this path is gateway-allowlisted (a provider has no
 * session), so an oversized body is reachable with no credential at all and the limit has to bite
 * before the allocation, not after it.
 */
export async function POST(request:Request){
  try{
    const{env}=await import("cloudflare:workers");
    const runtime=env as unknown as Record<string,unknown>;
    const declared=Number(request.headers.get("content-length")||0);
    if(Number.isFinite(declared)&&declared>MAX_CALLBACK_BYTES)return json({error:"Verification callback payload is too large"},413);
    const raw=await request.text();
    if(raw.length>MAX_CALLBACK_BYTES)return json({error:"Verification callback payload is too large"},413);
    const db=await database();
    const result=await applyIdfyCallback(db,runtime,{rawBody:raw,headers:request.headers});
    if(!result.accepted)return json({error:result.reason},result.status);
    return json({ok:true,applicationId:result.applicationId,verificationType:result.verificationType,outcome:result.outcome,duplicate:result.duplicate},result.status);
  }catch(error){return authError(error,"Unable to process verification callback");}
}
