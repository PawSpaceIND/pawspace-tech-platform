import { hmac, bytesToBase64Url, type AssertionPayload } from "./verified-identity-assertion";
import { identifyInstall } from "./app-to-revenue-funnel";

type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const normalizePhone=(value:string)=>value.replace(/\D/g,"").slice(-10);
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

/**
 * The real "send OTP, verify code, issue signed assertion" flow that was missing - the codebase
 * had verifyIdentityAssertion() to VALIDATE an assertion, but nothing anywhere generated one for a
 * real customer typing a phone number into a login screen. No real SMS gateway exists yet (same
 * sandboxed state as WhatsApp/Razorpay elsewhere), so the OTP code is returned directly in the
 * sandbox response rather than actually sent - explicitly marked as such, never claimed as sent.
 */
export async function ensureCustomerOtpTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS customer_otp_challenges (id TEXT PRIMARY KEY,phone TEXT NOT NULL,code TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_customer_otp_phone ON customer_otp_challenges(phone,created_at)"),
]);}

export async function requestCustomerOtp(db:Db,input:{phone:string}){
 await ensureCustomerOtpTables(db);
 const phone=normalizePhone(input.phone);
 if(phone.length!==10)throw new Error("A valid 10-digit phone number is required");
 const now=Date.now(),code=String(Math.floor(100000+Math.random()*900000)),id=uid("OTP");
 await db.prepare("INSERT INTO customer_otp_challenges (id,phone,code,attempts,consumed,created_at,expires_at) VALUES (?,?,?,0,0,?,?)")
   .bind(id,phone,code,now,now+5*60000).run();
 // Fail-closed OTP disclosure (finding D5): the one-time code must NEVER be returned in the response
 // outside an explicit staging/UAT gate. PAWSPACE_UAT_LOGIN==="on" is the established staging flag; in
 // production it is unset, so no code is disclosed. Verification is unchanged — the code is persisted
 // and checked by verifyCustomerOtp regardless of disclosure.
 const {env}=await import("cloudflare:workers");
 const disclose=String((env as Record<string,unknown>).PAWSPACE_UAT_LOGIN||"")==="on";
 return{challengeId:id,phone,expiresInSeconds:300,sandboxDelivery:disclose,...(disclose?{sandboxCode:code}:{}),liveSmsDelivered:false};
}

export async function verifyCustomerOtp(db:Db,input:{challengeId:string;code:string;name?:string;cityId?:string;installId?:string}){
 await ensureCustomerOtpTables(db);
 const row=await db.prepare("SELECT * FROM customer_otp_challenges WHERE id=?").bind(input.challengeId).first<Row>();
 if(!row)throw new Error("OTP challenge not found");
 if(Number(row.consumed)===1)throw new Error("This OTP has already been used");
 if(Date.now()>Number(row.expires_at))throw new Error("OTP has expired - request a new one");
 if(Number(row.attempts)>=5)throw new Error("Too many incorrect attempts - request a new OTP");
 if(text(row.code)!==text(input.code)){
   await db.prepare("UPDATE customer_otp_challenges SET attempts=attempts+1 WHERE id=? AND attempts<5").bind(input.challengeId).run();
   throw new Error("Incorrect OTP code");
 }
 // Atomic consume: without the consumed=0 guard two concurrent verifies of the same challenge
 // both passed the read-side check and each minted a signed assertion from one OTP.
 const claim=await db.prepare("UPDATE customer_otp_challenges SET consumed=1 WHERE id=? AND consumed=0").bind(input.challengeId).run();
 if(!Number(claim.meta.changes))throw new Error("This OTP has already been used");
 const phone=text(row.phone);
 let customer=await db.prepare("SELECT id,name,primary_phone,city_id FROM canonical_customers WHERE primary_phone=? OR secondary_phone=?").bind(phone,phone).first<Row>();
 if(!customer){
   const id=uid("CUS"),now=Date.now();
   await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app_otp','{}',?,?)")
     .bind(id,input.cityId||"blr",text(input.name)||"PawSpace Customer",phone,now,now).run();
   customer={id,name:text(input.name)||"PawSpace Customer",primary_phone:phone,city_id:input.cityId||"blr"};
 }
 const now=Date.now(),nonce=uid("NONCE"),payload:AssertionPayload={
   v:1,identitySource:"customer_otp",principalType:"identity_subject",principalKey:phone,
   subjectType:"customer",subjectId:text(customer.id),cityId:text(customer.city_id)||null,
   issuedAt:now,expiresAt:now+120000,nonce,
 };
 // bind the app install to this identified customer (funnel: installed -> identified). Best-effort.
 if(text(input.installId))await identifyInstall(db,{installId:text(input.installId),customerId:text(customer.id),at:now}).catch(()=>{});
 const encodedPayload=bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
 const secret=await getAssertionSecret();
 const signature=await hmac(encodedPayload,secret);
 return{assertion:`${encodedPayload}.${signature}`,customerId:text(customer.id),customerName:text(customer.name),phone};
}

async function getAssertionSecret(){
 const {env}=await import("cloudflare:workers");
 const runtime=env as unknown as Record<string,unknown>;
 const secret=String(runtime.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT||"").trim();
 if(secret.length<32)throw new Error("PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT is not configured");
 return secret;
}
