import assert from 'node:assert/strict';
export function apiOnlyConfig(existing, {expectedD1,expectedSha,jobId,origin}) {
 assert.equal(existing.name,'pawspace-staging');
 assert.match(expectedSha,/^[a-f0-9]{40}$/);
 assert.ok(typeof expectedD1==='string'&&expectedD1.length>0);
 assert.equal(existing.d1_databases?.length,1);
 assert.equal(existing.d1_databases[0].binding,'DB');
 assert.equal(existing.d1_databases[0].database_id,expectedD1);
 assert.match(jobId,/^Sentinel_[a-f0-9]{32}$/);
 assert.equal(new URL(origin).protocol,'https:');assert.equal(new URL(origin).origin,origin);
 const vars={...existing.vars,PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_ISOLATED_FINANCE_TEST:'true',PAWSPACE_FINANCE_TEST_DESCRIPTOR:'FINANCE-TEST-OPS-GROOMING-01',PAWSPACE_ATLAS_TEXT_TEST_JOB_ID:jobId,PAWSPACE_STAGING_BUILD_SHA:expectedSha,FINANCE_TEST_ORIGIN:origin};
 assert.ok(Object.values(vars).every(value=>['string','boolean','number'].includes(typeof value)));
 // Reconstruct from a finite configuration allowlist: no assets/services/AI/images/vectorize/R2/KV/queues/cron.
 return {name:existing.name,main:'atlas-api-review.js',compatibility_date:existing.compatibility_date,compatibility_flags:['nodejs_compat'],version_metadata:{binding:'PAWSPACE_VERSION_METADATA'},triggers:{crons:[]},d1_databases:[{...existing.d1_databases[0]}],vars};
}
