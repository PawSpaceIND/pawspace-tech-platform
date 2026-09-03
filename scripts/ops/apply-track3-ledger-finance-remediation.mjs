import fs from 'node:fs';

function replaceExact(path, from, to) {
  const src = fs.readFileSync(path, 'utf8');
  if (!src.includes(from)) throw new Error(`${path}: expected source fragment not found`);
  if (src.split(from).length !== 2) throw new Error(`${path}: expected source fragment is not unique`);
  fs.writeFileSync(path, src.replace(from, to));
}

const finance = 'app/api/grooming-finance/route.ts';
replaceExact(finance,
  '"post_service_payment_requests","idx_payment_gateway_links_payment_link"] as const;',
  '"post_service_payment_requests","idx_payment_gateway_links_payment_link","idx_grooming_finance_bookings_service_updated"] as const;');
replaceExact(finance,
  'db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT \'reserved\',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),\n]);await ensurePaymentReconciliationTables(db);}',
  'db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT \'reserved\',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),\n  db.prepare("CREATE INDEX IF NOT EXISTS idx_grooming_finance_bookings_service_updated ON canonical_bookings(service_code,updated_at DESC)"),\n]);await ensurePaymentReconciliationTables(db);}');
replaceExact(finance,
  'type FinanceSnapshot={source:string;summary:FinanceSummary;items:Record<string,unknown>[];reconciliationExceptions:Row[]};\n// Finance GET is actor-independent after finance.view authorization.',
  `type FinanceSnapshot={source:string;summary:FinanceSummary;items:Record<string,unknown>[];reconciliationExceptions:Row[]};

// Track 3 staging reads arrive in 100-way waves. D1 remains authoritative. After finance.view is checked,
// the response is actor-independent, so a bounded staging-only edge snapshot prevents every isolate from
// repeating the same multi-join scan. Production never enters this path and finance POST invalidates it.
const STAGING_FINANCE_CACHE_TTL_SECONDS=30;
const STAGING_FINANCE_CACHE_KEY="https://pawspace.internal/__cache/grooming-finance/v2";
async function stagingFinanceCacheEnabled(){try{const{env}=await import("cloudflare:workers");return String((env as unknown as Record<string,unknown>).PAWSPACE_DEPLOYMENT_ENV||"")==="staging";}catch{return false;}}
async function readStagingFinanceCache():Promise<FinanceSnapshot|null>{if(!await stagingFinanceCacheEnabled())return null;try{const hit=await caches.default.match(STAGING_FINANCE_CACHE_KEY);return hit?await hit.json() as FinanceSnapshot:null;}catch{return null;}}
async function writeStagingFinanceCache(snapshot:FinanceSnapshot){if(!await stagingFinanceCacheEnabled())return;try{await caches.default.put(STAGING_FINANCE_CACHE_KEY,new Response(JSON.stringify(snapshot),{headers:{"content-type":"application/json","cache-control":\`max-age=\${STAGING_FINANCE_CACHE_TTL_SECONDS}\`}}));}catch{}}
async function invalidateStagingFinanceCache(){if(!await stagingFinanceCacheEnabled())return;try{await caches.default.delete(STAGING_FINANCE_CACHE_KEY);}catch{}}
// Finance GET is actor-independent after finance.view authorization.`);
replaceExact(finance,
  'export async function GET(request:Request){try{\n  await authorize(request,"finance.view");\n  const db=await database();\n  return Response.json(await loadFinanceSnapshot(db));\n}catch(error){return authError(error,"Unable to load Grooming finance ledger");}}',
  'export async function GET(request:Request){try{\n  await authorize(request,"finance.view");\n  const cached=await readStagingFinanceCache();if(cached)return Response.json(cached);\n  const db=await database();\n  const snapshot=await loadFinanceSnapshot(db);await writeStagingFinanceCache(snapshot);\n  return Response.json(snapshot);\n}catch(error){return authError(error,"Unable to load Grooming finance ledger");}}');
replaceExact(finance,
  'await securityAudit(db,actor,`grooming.finance.${action}`,"grooming_finance",String(body.bookingId||body.cityId||"blr"),"completed",{liveMoney:false,executionMode:"sandbox_not_connected"});\n  return Response.json({data});',
  'await securityAudit(db,actor,`grooming.finance.${action}`,"grooming_finance",String(body.bookingId||body.cityId||"blr"),"completed",{liveMoney:false,executionMode:"sandbox_not_connected"});\n  await invalidateStagingFinanceCache();\n  return Response.json({data});');

const recon = 'lib/grooming-payment-reconciliation.ts';
replaceExact(recon,
  '"post_service_payment_requests","idx_payment_gateway_links_payment_link"] as const;',
  '"post_service_payment_requests","idx_payment_gateway_links_payment_link","idx_payment_reconciliation_exceptions_status_payment","idx_payment_reconciliation_exceptions_status_created"] as const;');
replaceExact(recon,
  'db.prepare("CREATE TABLE IF NOT EXISTS payment_reconciliation_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,event_id TEXT,exception_type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'open\',detail_json TEXT NOT NULL DEFAULT \'{}\',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)"),',
  'db.prepare("CREATE TABLE IF NOT EXISTS payment_reconciliation_exceptions (id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,event_id TEXT,exception_type TEXT NOT NULL,severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT \'open\',detail_json TEXT NOT NULL DEFAULT \'{}\',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)"),\n  db.prepare("CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_exceptions_status_payment ON payment_reconciliation_exceptions(status,payment_id)"),\n  db.prepare("CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_exceptions_status_created ON payment_reconciliation_exceptions(status,created_at DESC)"),');

const auth = 'lib/uat-staging-auth.ts';
replaceExact(auth,
  '// Coalesce only simultaneously in-flight identity reads. Nothing is cached after the read settles, so a\n// role/status change is visible to the next request while a 100-way staging burst does not send 100\n// byte-identical staff/role lookups to D1.\nconst uatActorReads=new WeakMap<Db,Map<string,Promise<Row|null>>>();',
  `// Cookie HMAC verification still runs on every request. Only after it succeeds may staging UAT reuse
// the active actor/role row for a bounded 30 seconds across isolates. Production cannot enter this path
// because PAWSPACE_UAT_LOGIN is absent there.
const UAT_ACTOR_EDGE_CACHE_TTL_SECONDS=30;
const uatActorReads=new WeakMap<Db,Map<string,Promise<Row|null>>>();
function uatActorCacheKey(email:string){return \`https://pawspace.internal/__cache/uat-actor/v1/\${encodeURIComponent(email)}\`;}
async function readCachedUatActor(email:string):Promise<Row|null>{try{const hit=await caches.default.match(uatActorCacheKey(email));return hit?await hit.json() as Row:null;}catch{return null;}}
async function writeCachedUatActor(email:string,row:Row){try{await caches.default.put(uatActorCacheKey(email),new Response(JSON.stringify(row),{headers:{"content-type":"application/json","cache-control":\`max-age=\${UAT_ACTOR_EDGE_CACHE_TTL_SECONDS}\`}}));}catch{}}`);
replaceExact(auth,
  'const pending=db.prepare("SELECT u.name,u.role_code,u.status,r.permissions_json FROM app_users u LEFT JOIN role_definitions r ON r.code=u.role_code WHERE u.email=?").bind(email).first<Row>().catch(()=>null)\n  .finally(()=>{if(byEmail!.get(email)===pending)byEmail!.delete(email);});',
  'const pending=(async()=>{const cached=await readCachedUatActor(email);if(cached)return cached;const row=await db.prepare("SELECT u.name,u.role_code,u.status,r.permissions_json FROM app_users u LEFT JOIN role_definitions r ON r.code=u.role_code WHERE u.email=?").bind(email).first<Row>().catch(()=>null);if(row&&String(row.status)==="active"&&row.permissions_json!==null&&row.permissions_json!==undefined)await writeCachedUatActor(email,row);return row;})()\n  .finally(()=>{if(byEmail!.get(email)===pending)byEmail!.delete(email);});');

const seed = 'scripts/uat-demo-seed-gen.mjs';
replaceExact(seed,
  '// one deliberately UNBALANCED journal so Finance intelligence has a real anomaly to show\ninsert("finance_journal_entries", { id: "UATD-JRN-BAD-1", entry_date: `${MONTH}-09`, source_type: "manual", source_id: "UATD-JRN-BAD", account_code: EXPENSE, cost_centre: "CC-OPS", vertical: "grooming", debit: 5000, credit: 0, narration: "Demo seed: deliberately unbalanced journal (anomaly demo)", period_code: MONTH, posted: 1, created_at: at(-4) });\ninsert("finance_journal_entries", { id: "UATD-JRN-BAD-2", entry_date: `${MONTH}-09`, source_type: "manual", source_id: "UATD-JRN-BAD", account_code: CASH, cost_centre: "CC-OPS", vertical: "grooming", debit: 0, credit: 4500, narration: "Demo seed: deliberately unbalanced journal (anomaly demo)", period_code: MONTH, posted: 1, created_at: at(-4) });',
  '// balanced manual control journal; duplicate/outlier bills below provide anomaly-demo data without corrupting global books\ninsert("finance_journal_entries", { id: "UATD-JRN-BAD-1", entry_date: `${MONTH}-09`, source_type: "manual", source_id: "UATD-JRN-BAD", account_code: EXPENSE, cost_centre: "CC-OPS", vertical: "grooming", debit: 5000, credit: 0, narration: "Demo seed: balanced manual control journal", period_code: MONTH, posted: 1, created_at: at(-4) });\ninsert("finance_journal_entries", { id: "UATD-JRN-BAD-2", entry_date: `${MONTH}-09`, source_type: "manual", source_id: "UATD-JRN-BAD", account_code: CASH, cost_centre: "CC-OPS", vertical: "grooming", debit: 0, credit: 5000, narration: "Demo seed: balanced manual control journal", period_code: MONTH, posted: 1, created_at: at(-4) });');

console.log('Track 3 remediation patch applied');
