import { hmac, bytesToBase64Url, type AssertionPayload } from "./verified-identity-assertion";
import { identifyInstall } from "./app-to-revenue-funnel";
import { resolveOtpAssertionSecret } from "./otp-sandbox-runtime";

type Db=D1Database;
type Row=Record<string,unknown>;

const text=(v:unknown)=>String(v??"").trim();
const normalizePhone=(value:string)=>value.replace(/\D/g,"").slice(-10);
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
async function canonicalOtpCustomerId(phone:string){
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`pawspace:customer-otp:${phone}`));
 const suffix=Array.from(new Uint8Array(digest)).slice(0,12).map(byte=>byte.toString(16).padStart(2,"0")).join("").toUpperCase();
 return `CUS-OTP-${suffix}`;
}

/** The OTP identity adapter is sandbox-first in local development. The generated code is returned to
 * the caller only through a route that has already established explicit UAT or local-development
 * sandbox authority. No live SMS delivery is claimed here. */
export async function ensureCustomerOtpTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS customer_otp_challenges (id TEXT PRIMARY KEY,phone TEXT NOT NULL,code TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_customer_otp_phone ON customer_otp_challenges(phone,created_at)"),
]);}

export async function requestCustomerOtp(db:Db,input:{phone:string}){
 await ensureCustomerOtpTables(db);
 const phone=normalizePhone(input.phone);
 if(phone.length!==10)throw new Error("A valid 10-digit phone number is required");
 const now=Date.now(),code=String(Math.floor(100000+Math.random()*900000)),id=uid("OTP");
 await db.prepare("INSERT INTO customer_otp_challenges (id,phone,code,attempts,consumed,created_at,expires_at) VALUES (?,?,?,0,0,?,?)").bind(id,phone,code,now,now+5*60000).run();
 return{challengeId:id,phone,expiresInSeconds:300,sandboxDelivery:true,sandboxCode:code,liveSmsDelivered:false};
}

export async function resolveOtpCustomer(db:D1Database,phone:string){return db.prepare("SELECT id,name,primary_phone,city_id FROM canonical_customers WHERE primary_phone=? ORDER BY created_at ASC LIMIT 1").bind(phone).first<Row>();}

export async function verifyCustomerOtp(db:Db,input:{challengeId:string;code:string;name?:string;cityId?:string;installId?:string}){
 await ensureCustomerOtpTables(db);
 const row=await db.prepare("SELECT * FROM customer_otp_challenges WHERE id=?").bind(input.challengeId).first<Row>();
 if(!row)throw new Error("OTP challenge not found");
 if(Number(row.consumed)===1)throw new Error("This OTP has already been used");
 if(Date.now()>Number(row.expires_at))throw new Error("OTP has expired - request a new one");
 if(Number(row.attempts)>=5)throw new Error("Too many incorrect attempts - request a new OTP");
 if(text(row.code)!==text(input.code)){await db.prepare("UPDATE customer_otp_challenges SET attempts=attempts+1 WHERE id=? AND attempts<5").bind(input.challengeId).run();throw new Error("Incorrect OTP code");}
 const claim=await db.prepare("UPDATE customer_otp_challenges SET consumed=1 WHERE id=? AND consumed=0").bind(input.challengeId).run();
 if(!Number(claim.meta.changes))throw new Error("This OTP has already been used");
 const phone=text(row.phone);
 let customer=await resolveOtpCustomer(db,phone);
 if(!customer){
   const id=await canonicalOtpCustomerId(phone),now=Date.now();
   await db.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app_otp','{}',?,?)").bind(id,input.cityId||"blr",text(input.name)||"PawSpace Customer",phone,now,now).run();
   customer=await db.prepare("SELECT id,name,primary_phone,city_id FROM canonical_customers WHERE id=?").bind(id).first<Row>();
   if(!customer||text(customer.primary_phone)!==phone)throw new Error("Canonical customer identity conflict - human review required");
 }
 const now=Date.now(),nonce=uid("NONCE"),payload:AssertionPayload={v:1,identitySource:"customer_otp",principalType:"identity_subject",principalKey:phone,subjectType:"customer",subjectId:text(customer.id),cityId:text(customer.city_id)||null,issuedAt:now,expiresAt:now+120000,nonce};
 if(text(input.installId))await identifyInstall(db,{installId:text(input.installId),customerId:text(customer.id),at:now}).catch(()=>{});
 const encodedPayload=bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
 const secret=await getAssertionSecret();
 const signature=await hmac(encodedPayload,secret);
 return{assertion:`${encodedPayload}.${signature}`,customerId:text(customer.id),customerName:text(customer.name),phone};
}

async function getAssertionSecret(){
 const {env}=await import("cloudflare:workers");
 const secret=resolveOtpAssertionSecret(env as unknown as Record<string,unknown>);
 if(secret.length<32)throw new Error("PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT is not configured");
 return secret;
}
