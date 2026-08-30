import { hmac, bytesToBase64Url, type AssertionPayload } from "./verified-identity-assertion";
import { equalConstantTime, generateSixDigitOtp, getOtpSecurityConfig, hmacOtp, mayDiscloseSandboxOtp } from "./otp-crypto";

type Db=D1Database;
type Row=Record<string,unknown>;
type OtpSecurityConfig=Awaited<ReturnType<typeof getOtpSecurityConfig>>;
type PartnerOtpRequestResult={challengeId:string;phone:string;expiresInSeconds:number;sandboxDelivery:boolean;liveSmsDelivered:boolean};
type PartnerOtpSandboxRequestResult=PartnerOtpRequestResult&{sandboxCode:string};

const text=(v:unknown)=>String(v??"").trim();
const normalizePhone=(value:string)=>String(value??"").replace(/\D/g,"").slice(-10);
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
async function canonicalOtpProviderId(phone:string){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`pawspace:partner-otp:${phone}`));
  const suffix=Array.from(new Uint8Array(digest)).slice(0,12).map(byte=>byte.toString(16).padStart(2,"0")).join("").toUpperCase();
  return `PROV-OTP-${suffix}`;
}

/**
 * Partner OTP challenge flow. The raw OTP is generated with Web Crypto and only an HMAC digest is
 * persisted. The ordinary request API never exposes the raw code; sandbox disclosure is isolated
 * behind requestPartnerOtpForSandbox and requires both sandbox mode and the dedicated test secret.
 */
export async function ensurePartnerOtpTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS partner_otp_challenges (id TEXT PRIMARY KEY,phone TEXT NOT NULL,code TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_partner_otp_phone ON partner_otp_challenges(phone,created_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,phone TEXT NOT NULL UNIQUE,email TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

async function createPartnerOtpChallenge(db:Db,input:{phone:string},security:OtpSecurityConfig){
  await ensurePartnerOtpTables(db);
  const phone=normalizePhone(input.phone);
  if(phone.length!==10)throw new Error("A valid 10-digit phone number is required");
  const now=Date.now(),code=generateSixDigitOtp(),id=uid("POTP");
  const digest=await hmacOtp(id,code,security.pepper);
  await db.prepare("INSERT INTO partner_otp_challenges (id,phone,code,attempts,consumed,created_at,expires_at) VALUES (?,?,?,0,0,?,?)")
    .bind(id,phone,digest,now,now+5*60000).run();
  return{
    result:{challengeId:id,phone,expiresInSeconds:300,sandboxDelivery:security.identityEnv==="sandbox",liveSmsDelivered:false} satisfies PartnerOtpRequestResult,
    code,
  };
}

export async function requestPartnerOtp(db:Db,input:{phone:string}):Promise<PartnerOtpRequestResult>{
  const security=await getOtpSecurityConfig();
  const {result}=await createPartnerOtpChallenge(db,input,security);
  return result;
}

export async function requestPartnerOtpForSandbox(db:Db,input:{phone:string;testSecret:string}):Promise<PartnerOtpSandboxRequestResult>{
  const security=await getOtpSecurityConfig();
  if(!mayDiscloseSandboxOtp(security.identityEnv,security.testSecret,input.testSecret))throw new Error("Sandbox OTP disclosure is not authorized");
  const {result,code}=await createPartnerOtpChallenge(db,{phone:input.phone},security);
  return{...result,sandboxCode:code};
}

export async function signPartnerIdentityAssertion(input:{providerId:string;phone:string;cityId?:string|null;issuedAt?:number;expiresAt?:number;nonce?:string}){
  const providerId=text(input.providerId),phone=normalizePhone(input.phone);
  if(!providerId)throw new Error("Provider identity is required");
  if(phone.length!==10)throw new Error("A valid 10-digit phone number is required");
  const issuedAt=input.issuedAt??Date.now();
  const payload:AssertionPayload={
    v:1,identitySource:"partner_otp",principalType:"identity_subject",principalKey:phone,
    subjectType:"provider",subjectId:providerId,cityId:input.cityId??null,
    issuedAt,expiresAt:input.expiresAt??issuedAt+120000,nonce:input.nonce??uid("NONCE"),
  };
  const encodedPayload=bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature=await hmac(encodedPayload,await getAssertionSecret());
  return `${encodedPayload}.${signature}`;
}

export async function verifyPartnerOtp(db:Db,input:{challengeId:string;code:string;name?:string;cityId?:string}){
  await ensurePartnerOtpTables(db);
  const row=await db.prepare("SELECT * FROM partner_otp_challenges WHERE id=?").bind(input.challengeId).first<Row>();
  if(!row)throw new Error("OTP challenge not found");
  if(Number(row.consumed)===1)throw new Error("This OTP has already been used");
  if(Date.now()>Number(row.expires_at))throw new Error("OTP has expired - request a new one");
  if(Number(row.attempts)>=5)throw new Error("Too many incorrect attempts - request a new OTP");
  const security=await getOtpSecurityConfig();
  const submittedDigest=await hmacOtp(input.challengeId,text(input.code),security.pepper);
  if(!equalConstantTime(text(row.code),submittedDigest)){
    // Pre-hardening plaintext rows intentionally fail closed; users must request a fresh challenge.
    await db.prepare("UPDATE partner_otp_challenges SET attempts=attempts+1 WHERE id=? AND attempts<5 AND consumed=0").bind(input.challengeId).run();
    throw new Error("Incorrect OTP code");
  }
  const claim=await db.prepare("UPDATE partner_otp_challenges SET consumed=1 WHERE id=? AND consumed=0").bind(input.challengeId).run();
  if(!Number(claim.meta.changes))throw new Error("This OTP has already been used");

  const phone=text(row.phone);
  let provider=await db.prepare("SELECT id,name,phone,city_id FROM canonical_providers WHERE phone=?").bind(phone).first<Row>();
  if(!provider){
    const providerId=await canonicalOtpProviderId(phone),now=Date.now();
    await db.prepare("INSERT OR IGNORE INTO canonical_providers (id,city_id,name,phone,email,source,created_at,updated_at) VALUES (?,?,?,?,NULL,'partner_app_otp',?,?)")
      .bind(providerId,input.cityId||"blr",text(input.name)||"PawSpace Caregiver",phone,now,now).run();
    provider=await db.prepare("SELECT id,name,phone,city_id FROM canonical_providers WHERE phone=?").bind(phone).first<Row>();
    if(!provider||text(provider.phone)!==phone)throw new Error("Canonical provider identity conflict - human review required");
  }
  const assertion=await signPartnerIdentityAssertion({
    providerId:text(provider.id),phone,cityId:text(provider.city_id)||null,
  });
  return{assertion,providerId:text(provider.id),providerName:text(provider.name),phone};
}

async function getAssertionSecret(){
  const {env}=await import("cloudflare:workers");
  const runtime=env as unknown as Record<string,unknown>;
  const secret=String(runtime.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT||"").trim();
  if(secret.length<32)throw new Error("PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT is not configured");
  return secret;
}
