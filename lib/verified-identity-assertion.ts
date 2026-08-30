import { z } from "zod";
import type{IdentitySource,IdentitySubjectType,PrincipalType}from"./identity-binding";

export type AssertionPayload={v:1;identitySource:"customer_otp"|"partner_otp";principalType:"identity_subject";principalKey:string;subjectType:IdentitySubjectType;subjectId:string;cityId?:string|null;issuedAt:number;expiresAt:number;nonce:string};

const assertionPayloadSchema=z.object({
  v:z.literal(1),
  identitySource:z.enum(["customer_otp","partner_otp"]),
  principalType:z.literal("identity_subject"),
  principalKey:z.string().min(1).max(256),
  subjectType:z.enum(["customer","provider"]),
  subjectId:z.string().min(1).max(256),
  cityId:z.string().min(1).max(128).nullable().optional(),
  issuedAt:z.number().int().safe().nonnegative(),
  expiresAt:z.number().int().safe().nonnegative(),
  nonce:z.string().min(1).max(256),
}).strict();

function base64UrlToBytes(value:string){const normalized=value.replaceAll("-","+").replaceAll("_","/")+"=".repeat((4-value.length%4)%4);const binary=atob(normalized),bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes;}
export function bytesToBase64Url(bytes:Uint8Array){let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");}
export async function hmac(value:string,secret:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const signature=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value));return bytesToBase64Url(new Uint8Array(signature));}
function equalConstantTime(left:string,right:string){const a=new TextEncoder().encode(left),b=new TextEncoder().encode(right);if(a.length!==b.length)return false;let diff=0;for(let index=0;index<a.length;index++)diff|=a[index]^b[index];return diff===0;}

export async function ensureIdentityAssertionTables(db:D1Database){await db.prepare("CREATE TABLE IF NOT EXISTS verified_identity_assertion_nonces (nonce TEXT PRIMARY KEY,identity_source TEXT NOT NULL,principal_key TEXT NOT NULL,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,used_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)").run();}

export async function verifyIdentityAssertion(db:D1Database,assertion:string){
  await ensureIdentityAssertionTables(db);
  const{env}=await import("cloudflare:workers");
  const runtime=env as unknown as Record<string,unknown>,mode=String(runtime.PAWSPACE_IDENTITY_ENV||"sandbox").toLowerCase(),secret=String(runtime.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT||"").trim();
  if(mode!=="sandbox")throw new Response("Identity assertion exchange is locked to sandbox",{status:503});
  if(secret.length<32)throw new Response("PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT is not configured",{status:503});
  const parts=assertion.split(".");
  if(parts.length!==2)throw new Response("Malformed identity assertion",{status:401});

  // Authenticate the exact encoded bytes before decoding or parsing attacker-controlled content.
  const expected=await hmac(parts[0],secret);
  if(!equalConstantTime(expected,parts[1]))throw new Response("Invalid identity assertion signature",{status:401});

  let decoded:unknown;
  try{decoded=JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));}catch{throw new Response("Malformed identity assertion payload",{status:401});}
  const parsed=assertionPayloadSchema.safeParse(decoded);
  if(!parsed.success)throw new Response("Incomplete identity assertion",{status:401});
  const payload=parsed.data;

  if(payload.identitySource==="customer_otp"&&payload.subjectType!=="customer")throw new Response("Customer OTP assertion subject mismatch",{status:401});
  if(payload.identitySource==="partner_otp"&&payload.subjectType!=="provider")throw new Response("Partner OTP assertion subject mismatch",{status:401});
  if(payload.expiresAt<=payload.issuedAt)throw new Response("Invalid assertion lifetime",{status:401});

  const now=Date.now();
  if(payload.expiresAt<=now||payload.issuedAt>now+60_000||payload.issuedAt<now-5*60_000||payload.expiresAt-payload.issuedAt>5*60_000)throw new Response("Identity assertion is expired or outside the allowed window",{status:401});
  const claimed=await db.prepare("INSERT OR IGNORE INTO verified_identity_assertion_nonces (nonce,identity_source,principal_key,subject_type,subject_id,used_at,expires_at) VALUES (?,?,?,?,?,?,?)").bind(payload.nonce,payload.identitySource,payload.principalKey,payload.subjectType,payload.subjectId,now,payload.expiresAt).run();
  if(!Number(claimed.meta.changes))throw new Response("Identity assertion has already been used",{status:409});
  return payload as AssertionPayload&{identitySource:IdentitySource;principalType:PrincipalType};
}
