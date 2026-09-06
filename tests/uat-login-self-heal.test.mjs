import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source=fs.readFileSync(new URL('../app/api/staging-login/route.ts',import.meta.url),'utf8');

test('fixed UAT identities repair stale role/status on email conflict',()=>{
  assert.match(source,/ON CONFLICT\(email\) DO UPDATE SET name=excluded\.name,role_code=excluded\.role_code,status='active',updated_at=excluded\.updated_at/);
});

test('unknown UAT identities remain gated',()=>{
  assert.match(source,/uatStaffIdentityAllowed\(db,email\)/);
  assert.match(source,/unknown email, a suspended account, or a role nobody has defined are all refused/);
});
