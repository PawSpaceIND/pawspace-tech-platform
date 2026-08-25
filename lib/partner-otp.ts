import { hmac, bytesToBase64Url, type AssertionPayload } from "./verified-identity-assertion";

type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const normalizePhone=(value:string)=>String(value??"").replace(/\D/g,"").slice(-10);
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
async function canonicalOtpProviderId(phone:string){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`pawspace:partner-otp:${phone}`));
  const suffix=Array.from(new Uint8Array(digest)).slice(0,12).map(byte=>byte.toString(16).padStart(2,"0")).join("").toUpperCase();
  return `PROV-OTP-${suffix}`;
}

/**
 * Real "send OTP, verify code, issue signed assertion" flow for providers/caregivers - mirrors
 * lib/customer-otp.ts exactly. verifyIdentityAssertion() already validated "partner_otp" assertions
 * with subjectType "provider", but nothing anywhere generated one - a new applicant clicking
 * "Start your application" from /careers had no way to ever get a session, so /partner/onboarding
 * was unreachable. No real SMS gateway exists yet. The generated OTP is available only to the
 * explicitly gated staging/UAT API route; production-like request routes fail closed before calling
 * this function and therefore do not create an undeliverable challenge.
 */
export async function ensurePartnerOtpTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS partner_otp_challenges (id TEXT PRIMARY KEY,phone TEXT NOT NULL,code TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_partner_otp_phone ON partner_otp_challenges(phone,created_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,phone TEXT NOT NULL UNIQUE,email TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

export async function requestPartnerOtp(db:Db,input:{phone:string}){
  await ensurePartnerOtpTables(db);
  const phone=normalizePhone(input.phone);
  if(phone.length!==10)throw new Error("A valid 10-digit phone number is required");
  const now=Date.now(),code=String(Math.floor(100000+Math.random()*900000)),id=uid("POTP");
  await db.prepare("INSERT INTO partner_otp_challenges (id,phone,code,attempts,consumed,created_at,expires_at) VALUES (?,?,?,0,0,?,?)")
    .bind(id,phone,code,now,now+5*60000).run();
  return{challengeId:id,phone,expiresInSeconds:300,sandboxDelivery:true,sandboxCode:code,liveSmsDelivered:false};
}

export async function verifyPartnerOtp(db:Db,input:{challengeId:string;code:string;name?:string;cityId?:string}){
  await ensurePartnerOtpTables(db);
  const row=await db.prepare("SELECT * FROM partner_otp_challenges WHERE id=?").bind(input.challengeId).first<Row>();
  if(!row)throw new Error("OTP challenge not found");
  if(Number(row.consumed)===1)throw new Error("This OTP has already been used");
  if(Date.now()>Number(row.expires_at))throw new Error("OTP has expired - request a new one");
  if(Number(row.attempts)>=5)throw new Error("Too many incorrect attempts - request a new OTP");
  if(text(row.code)!==text(input.code)){
    await db.prepare("UPDATE partner_otp_challenges SET attempts=attempts+1 WHERE id=? AND attempts<5 AND consumed=0").bind(input.challengeId).run();
    throw new Error("Incorrect OTP code");
  }
  // A read-side consumed check is not enough: two correct verifications can both observe consumed=0.
  // Claim the challenge atomically so only one request can mint an assertion from one OTP.
  const claim=await db.prepare("UPDATE partner_otp_challenges SET consumed=1 WHERE id=? AND consumed=0").bind(input.challengeId).run();
  if(!Number(claim.meta.changes))throw new Error("This OTP has already been used");

  const phone=text(row.phone);
  let provider=await db.prepare("SELECT id,name,phone,city_id FROM canonical_providers WHERE phone=?").bind(phone).first<Row>();
  if(!provider){
    // Separate valid challenges for the same phone may be verified concurrently. Use a stable,
    // phone-derived opaque id and INSERT OR IGNORE so both requests converge on one provider row.
    const providerId=await canonicalOtpProviderId(phone),now=Date.now();
    await db.prepare("INSERT OR IGNORE INTO canonical_providers (id,city_id,name,phone,email,source,created_at,updated_at) VALUES (?,?,?,?,NULL,'partner_app_otp',?,?)")
      .bind(providerId,text(input.cityId)||null,text(input.name)||"PawSpace Caregiver",phone,now,now).run();
    provider=await db.prepare("SELECT id,name,phone,city_id FROM canonical_providers WHERE phone=?").bind(phone).first<Row>();
    if(!provider||text(provider.phone)!==phone)throw new Error("Canonical provider identity conflict - human review required");
  }
  const now=Date.now(),nonce=uid("NONCE"),payload:AssertionPayload={
    v:1,identitySource:"partner_otp",principalType:"identity_subject",principalKey:phone,
    subjectType:"provider",subjectId:text(provider.id),cityId:text(provider.city_id)||null,
    issuedAt:now,expiresAt:now+120000,nonce,
  };
  const encodedPayload=bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const secret=await getAssertionSecret();
  const signature=await hmac(encodedPayload,secret);
  return{assertion:`${encodedPayload}.${signature}`,providerId:text(provider.id),providerName:text(provider.name),phone};
}

async function getAssertionSecret(){
  const {env}=await import("cloudflare:workers");
  const runtime=env as unknown as Record<string,unknown>;
  const secret=String(runtime.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT||"").trim();
  if(secret.length<32)throw new Error("PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT is not configured");
  return secret;
}
