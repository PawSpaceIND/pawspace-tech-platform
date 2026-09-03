import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const finance=fs.readFileSync('app/api/grooming-finance/route.ts','utf8');
const auth=fs.readFileSync('lib/uat-staging-auth.ts','utf8');
const recon=fs.readFileSync('lib/grooming-payment-reconciliation.ts','utf8');
const seed=fs.readFileSync('scripts/uat-demo-seed-gen.mjs','utf8');
const seedSql=fs.readFileSync('scripts/uat-demo-seed.sql','utf8');
test('finance edge snapshot is staging-only and downstream of authorization',()=>{
  assert.match(finance,/PAWSPACE_DEPLOYMENT_ENV\|\|""\)==="staging"/);
  assert.match(finance,/STAGING_FINANCE_CACHE_TTL_SECONDS=30/);
  assert.match(finance,/caches\.open\("pawspace-track3-finance-v2"\)/);
  assert.match(finance,/STAGING_FINANCE_CACHE_KEY/);
  assert.match(finance,/export async function GET[\s\S]*?authorize\(request,"finance\.view"\)[\s\S]*?readStagingFinanceCache\(\)/);
});
test('finance cache misses use hot-path indexes',()=>{
  assert.match(finance,/idx_grooming_finance_bookings_service_updated ON canonical_bookings\(service_code,updated_at DESC\)/);
  assert.match(recon,/idx_payment_reconciliation_exceptions_status_payment ON payment_reconciliation_exceptions\(status,payment_id\)/);
  assert.match(recon,/idx_payment_reconciliation_exceptions_status_created ON payment_reconciliation_exceptions\(status,created_at DESC\)/);
});
test('UAT actor cache remains downstream of signed-cookie verification',()=>{
  assert.match(auth,/UAT_ACTOR_EDGE_CACHE_TTL_SECONDS=30/);
  assert.match(auth,/caches\.open\("pawspace-uat-actor-v1"\)/);
  assert.match(auth,/resolveUatStaffActor[\s\S]*?verifyUatToken\(env,token\)[\s\S]*?readUatActorRow\(db,email\)/);
  assert.match(auth,/if\(!uatLoginEnabled\(env\)\)return null/);
});
test('UAT demo seed remains globally balanced',()=>{
  assert.doesNotMatch(seed,/deliberately UNBALANCED journal/);
  assert.doesNotMatch(seedSql,/deliberately unbalanced journal \(anomaly demo\)/);
  assert.match(seed,/UATD-JRN-BAD-2[\s\S]*?credit: 5000/);
  assert.match(seedSql,/UATD-JRN-BAD-2[^\n]*,0,5000,'Demo seed: balanced manual control journal'/);
});
