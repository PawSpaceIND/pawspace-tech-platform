// Generates scripts/staging-seed.sql — a deterministic, re-runnable D1 seed for human UAT:
// 220 customers across 5 cities, pets, ~307 bookings across all 6 verticals, payments (mixed
// captured/pending/failed), marketing-consent, and grooming subscriptions. Uses the EXACT production
// table schemas (CREATE TABLE IF NOT EXISTS) so it is consistent whether the app or the seed runs first,
// and INSERT OR IGNORE so re-running is safe. Fixed timestamps → identical output every run.
// Run:  node scripts/staging-seed-gen.mjs   Load: npx wrangler d1 execute pawspace-staging --remote --file=scripts/staging-seed.sql
import { writeFileSync } from "node:fs";

const BASE = Date.UTC(2026, 7, 1), DAY = 86400000;
const CITIES = ["blr", "hyd", "mumbai", "delhi", "pune"];
const ZONES = { blr: "blr-east", hyd: "hyd-north", mumbai: "mum-south", delhi: "del-north", pune: "pun-east" };
const SERVICES = ["grooming", "dog_training", "boarding", "pet_sitting", "dog_walking", "pet_taxi"];
const SPECIES = ["dog", "cat"];
const PAY = ["captured", "captured", "captured", "created", "failed"];
const AMT = [799, 1299, 699, 399, 599, 899];
const s = [];

s.push("-- PawSpace staging UAT seed (generated). Safe to re-run.");
s.push("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS payment_reconciliation_records (payment_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gateway TEXT NOT NULL,environment TEXT NOT NULL,expected_amount REAL NOT NULL,captured_amount REAL NOT NULL DEFAULT 0,refunded_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,gateway_status TEXT NOT NULL DEFAULT 'not_started',reconciliation_status TEXT NOT NULL DEFAULT 'pending',variance_amount REAL NOT NULL DEFAULT 0,last_event_id TEXT,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY,marketing_consent INTEGER NOT NULL DEFAULT 0,service_consent INTEGER NOT NULL DEFAULT 1,whatsapp_consent INTEGER NOT NULL DEFAULT 0,sms_consent INTEGER NOT NULL DEFAULT 0,email_consent INTEGER NOT NULL DEFAULT 0,opt_out INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT 'customer',updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);");
s.push("CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);");

const N = 220;
let bseq = 0, subs = 0;
for (let i = 0; i < N; i++) {
  const id = `CUS${String(i).padStart(4, "0")}`, city = CITIES[i % CITIES.length], phone = `9${String(100000000 + i)}`;
  const cust = BASE - ((i * 3) % 400) * DAY, consent = i % 3 === 0 ? 1 : 0;
  s.push(`INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,source,consent_json,created_at,updated_at) VALUES ('${id}','${city}','Customer ${i}','${phone}','uat_seed','{"marketing":${consent ? "true" : "false"}}',${cust},${BASE});`);
  s.push(`INSERT OR IGNORE INTO customer_contact_preferences (customer_id,marketing_consent,updated_by,updated_at) VALUES ('${id}',${consent},'uat_seed',${BASE});`);
  const pets = 1 + (i % 3 === 0 ? 1 : 0);
  for (let p = 0; p < pets; p++) s.push(`INSERT OR IGNORE INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,created_at,updated_at) VALUES ('${id}-P${p}','${id}','Pet${p}','${SPECIES[(i + p) % 2]}','Mixed','verified',${cust},${BASE});`);
  if (i % 10 < 7) {
    const nb = 1 + (i % 3);
    for (let b = 0; b < nb; b++) {
      const svc = SERVICES[(i + b) % SERVICES.length], zone = ZONES[city], bid = `BK${String(bseq++).padStart(5, "0")}`;
      const amount = AMT[(i + b) % 6], pstate = PAY[(i + b) % PAY.length], ago = (i + b) % 120;
      const bstatus = pstate === "captured" ? (b === 0 ? "completed" : "confirmed") : "confirmed";
      const start = new Date(BASE - ago * DAY).toISOString(), end = new Date(BASE - ago * DAY + 3600000).toISOString(), at = BASE - ago * DAY;
      s.push(`INSERT OR IGNORE INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES ('${bid}','idem-${bid}','${id}','["${id}-P0"]','["${id}-P0"]','${city}','${zone}','${svc}','${svc}-std','${svc} standard','SG-${bid}','PROV-${city}-${svc}','${start}','${end}','${bstatus}','customer_app',${amount},'INR','{}','uat_seed',${at},${BASE});`);
      s.push(`INSERT OR IGNORE INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES ('PAY-${bid}','${bid}','${id}',${amount},${amount},'card','prepaid','${pstate}','pidem-${bid}',${at - 3600000},${BASE});`);
      const captured = pstate === "captured" ? amount : 0;
      s.push(`INSERT OR IGNORE INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES ('PAY-${bid}','${bid}','uat_sandbox','sandbox',${amount},${captured},0,'INR','${pstate}','${pstate === "captured" ? "matched" : "pending"}',${amount - captured},'evt-${bid}',${BASE});`);
      if (svc === "grooming" && pstate === "captured" && b === 0 && subs < 25) { subs++; s.push(`INSERT OR IGNORE INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES ('SUB${subs}','${id}','care-plus','grooming-std',4,${i % 4},'active',${BASE - 20 * DAY},${BASE + 40 * DAY},'${bid}','v1',${BASE},${BASE});`); }
    }
  }
}
s.push(`-- customers=${N} bookings=${bseq} subscriptions=${subs}`);
writeFileSync("scripts/staging-seed.sql", s.join("\n") + "\n");
console.log(`Wrote scripts/staging-seed.sql — ${N} customers, ${bseq} bookings, ${subs} subscriptions, ${s.length} statements.`);
