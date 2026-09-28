import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertFixturePhoneAvailable, readFixtureOwnerInventory, fixtureRecipient, OWNER_INVENTORY_SQL, WHATSAPP_FIXTURE_ID } from '../scripts/uat-fixture-phone-guard.mjs';

// Disposable test values only. These tests do not access any provider or remote DB.
const phone = '+919876543210';
const row = (primary = null, secondary = null, id = 'LOCAL-TEST-REAL') => ({ id, primary_phone: primary, secondary_phone: secondary });
const inventory = rows => [{ success: true, results: [{ owner_count: rows.length }] }, { success: true, results: rows }];
const variants = ['9876543210', '09876543210', '919876543210', '+919876543210', '+91 98765 43210', '+91 (98765) 43210', '98765-43210', '98765.43210'];
for (const value of variants) {
  test(`canonical recipient accepts local/E164 formatting: ${variants.indexOf(value)}`, () => {
    assert.equal(fixtureRecipient(value), phone);
  });
  for (const field of ['primary', 'secondary']) {
    test(`refuses ${field} collision for formatting variant ${variants.indexOf(value)}`, () => {
      const data = inventory([field === 'primary' ? row(value) : row(null, value)]);
      const before = structuredClone(data);
      assert.throws(() => assertFixturePhoneAvailable(data, phone), /already belongs/);
      assert.deepEqual(data, before);
    });
  }
}
for (const value of ['', null, phone, '+919876543211']) {
  test(`existing/retired fixture cannot be reactivated (${String(value).slice(-1)})`, () => {
    assert.throws(() => assertFixturePhoneAvailable(inventory([row(value, null, WHATSAPP_FIXTURE_ID)]), phone), /reuse or reactivation/);
  });
}
test('two canonical owners are refused, not ranked by name or booking count', () => {
  assert.throws(() => assertFixturePhoneAvailable(inventory([row(phone), row(null, '9876543210', 'LOCAL-TEST-OTHER')]), phone), /already belongs/);
});
test('a distinct foreign country code does not claim the Indian recipient', () => {
  assert.equal(assertFixturePhoneAvailable(inventory([row('+449876543210')]), phone).checked, true);
});
test('an unused number and a complete empty inventory pass without mutations', () => {
  assert.deepEqual(assertFixturePhoneAvailable(inventory([]), phone), { checked: true, canonicalOwnersScanned: 0, changed: false, dialed: false });
});
for (const value of [null, '', 'abc9876543210', '+449876543210', '9876543210,9876543211', '+9198765432109']) {
  test(`malformed or multi-recipient input refuses (${String(value).length})`, () => {
    assert.throws(() => fixtureRecipient(value), /single valid India/);
  });
}
const badInventories = [null, {}, [], [{ success: true, results: [] }],
  [{ success: false, results: [{ owner_count: 0 }] }, { success: true, results: [] }],
  [{ success: true, results: [{ owner_count: 2 }] }, { success: true, results: [row(phone)] }],
  [{ success: true, results: [{ owner_count: 0 }] }, { success: true, results: [row(phone)] }],
  inventory([{}]), inventory([row(phone), row(null)]),
  [{ success: true, results: [{ owner_count: -1 }] }, { success: true, results: [] }]];
for (const [index, data] of badInventories.entries()) {
  test(`partial or malformed inventory ${index} fails closed`, () => assert.throws(() => readFixtureOwnerInventory(data), /inventory/));
}
for (const name of ['provision-whatsapp-uat-certification-fixture.yml', 'provision-whatsapp-uat-certification-fixture-v2.yml']) {
  test(`${name} checks complete canonical inventory before provisioning`, () => {
    const source = readFileSync(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
    assert.match(source, /uses: actions\/checkout@v4/);
    assert.ok(source.includes(OWNER_INVENTORY_SQL));
    const check = source.indexOf('node --experimental-strip-types scripts/uat-fixture-phone-guard.mjs');
    assert.ok(check > 0 && check < source.indexOf('- name: Provision'));
    assert.doesNotMatch(source, /WHERE id<>/);
    assert.doesNotMatch(source, /DO UPDATE SET/);
    assert.equal((source.match(/ON CONFLICT\((?:id|customer_id)\) DO NOTHING/g) || []).length, 4);
  });
}
test('CLI rejection never prints a phone or raw malformed inventory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pawspace-fixture-guard-'));
  try {
    const out = join(dir, 'inventory.json');
    for (const data of [JSON.stringify(inventory([row(phone)])), 'PRIVATE-BROKEN-' + phone]) {
      writeFileSync(out, data);
      const run = spawnSync(process.execPath, ['--experimental-strip-types', new URL('../scripts/uat-fixture-phone-guard.mjs', import.meta.url).pathname], {
        env: { ...process.env, OUT: out, UAT_RECIPIENT: phone }, encoding: 'utf8', timeout: 10000,
      });
      assert.notEqual(run.status, 0);
      const logs = run.stdout + run.stderr;
      assert.ok(!logs.includes(phone) && !logs.includes('PRIVATE-BROKEN'));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Exercise the real dispatch-boundary resolver, not only the script preflight.
// All records below live in a disposable in-memory SQLite database.
import { installAiHooks, freshAiDb, seedCustomer } from './helpers/ai-harness.mjs';
import { canonicalDialNumber } from '../lib/voice-call-gate.ts';
installAiHooks();
const { resolveCanonicalRecipientOwnership } = await import('../lib/canonical-recipient-ownership.ts');
for (const [index, value] of variants.entries()) {
  test(`actual recipient resolver agrees with guard normalization ${index}`, async t => {
    const { sqlite, db } = freshAiDb();
    t.after(() => sqlite.close());
    seedCustomer(sqlite, 'LOCAL-OWNER', 'Disposable owner', value);
    const before = sqlite.prepare('SELECT * FROM canonical_customers').all();
    assert.equal(canonicalDialNumber({}, value), phone);
    const resolved = await resolveCanonicalRecipientOwnership(db, {}, {
      customerId: 'LOCAL-OWNER', phone, requireSuppliedPhone: true,
    });
    assert.equal(resolved.customerId, 'LOCAL-OWNER');
    assert.equal(resolved.dialNumber, phone);
    assert.equal(resolved.phoneSource, 'primary');
    assert.throws(() => assertFixturePhoneAvailable(inventory(before), phone), /already belongs/);
    assert.deepEqual(sqlite.prepare('SELECT * FROM canonical_customers').all(), before);
  });
}
for (const [index, value] of variants.entries()) {
  for (const field of ['primary_phone', 'secondary_phone']) {
    test(`actual resolver rejects duplicate ${field} formatting ${index} without changing records`, async t => {
      const { sqlite, db } = freshAiDb();
      t.after(() => sqlite.close());
      seedCustomer(sqlite, 'LOCAL-OWNER', 'Disposable owner', phone);
      seedCustomer(sqlite, WHATSAPP_FIXTURE_ID, 'Disposable fixture', '+919876543211');
      sqlite.prepare(`UPDATE canonical_customers SET ${field}=? WHERE id=?`).run(value, WHATSAPP_FIXTURE_ID);
      const before = sqlite.prepare('SELECT * FROM canonical_customers ORDER BY id').all();
      await assert.rejects(() => resolveCanonicalRecipientOwnership(db, {}, {
        customerId: 'LOCAL-OWNER', phone, requireSuppliedPhone: true,
      }), /not uniquely owned/);
      assert.throws(() => assertFixturePhoneAvailable(inventory(before), phone), /reuse or reactivation/);
      assert.deepEqual(sqlite.prepare('SELECT * FROM canonical_customers ORDER BY id').all(), before);
    });
  }
}
test('actual resolver accepts the sole secondary owner without choosing another identity', async t => {
  const { sqlite, db } = freshAiDb();
  t.after(() => sqlite.close());
  seedCustomer(sqlite, 'LOCAL-SECONDARY', 'Disposable owner', '+919876543211');
  sqlite.prepare('UPDATE canonical_customers SET secondary_phone=? WHERE id=?').run('09876543210', 'LOCAL-SECONDARY');
  const result = await resolveCanonicalRecipientOwnership(db, {}, { customerId: 'LOCAL-SECONDARY', phone });
  assert.equal(result.phoneSource, 'secondary');
  assert.equal(result.customerId, 'LOCAL-SECONDARY');
  assert.equal(result.dialNumber, phone);
});
test('actual resolver refuses wrong identity, foreign-country and missing-phone requests', async t => {
  const { sqlite, db } = freshAiDb();
  t.after(() => sqlite.close());
  seedCustomer(sqlite, 'LOCAL-OWNER', 'Disposable owner', phone);
  seedCustomer(sqlite, 'LOCAL-OTHER', 'Other disposable owner', '+919876543211');
  const before = sqlite.prepare('SELECT * FROM canonical_customers ORDER BY id').all();
  for (const input of [
    { customerId: 'LOCAL-OTHER', phone },
    { customerId: 'LOCAL-MISSING', phone },
    { customerId: 'LOCAL-OWNER', phone: '+449876543210' },
    { customerId: 'LOCAL-OWNER', requireSuppliedPhone: true },
  ]) await assert.rejects(() => resolveCanonicalRecipientOwnership(db, {}, input), {
    name: 'CanonicalRecipientOwnershipError', code: 'canonical_recipient_ownership_refused',
  });
  assert.deepEqual(sqlite.prepare('SELECT * FROM canonical_customers ORDER BY id').all(), before);
});
test('actual resolver refuses a booking owned by a different customer', async t => {
  const { sqlite, db } = freshAiDb();
  t.after(() => sqlite.close());
  seedCustomer(sqlite, 'LOCAL-OWNER', 'Disposable owner', phone);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount) VALUES (?,?,?,'Test','confirmed','2030-01-01T09:00:00Z','2030-01-01T10:00:00Z',0)")
    .run('LOCAL-BOOKING', 'LOCAL-OTHER', 'grooming');
  await assert.rejects(() => resolveCanonicalRecipientOwnership(db, {}, {
    customerId: 'LOCAL-OWNER', phone, bookingId: 'LOCAL-BOOKING',
  }), /Booking\/customer ownership mismatch/);
  assert.equal(sqlite.prepare('SELECT customer_id FROM canonical_bookings WHERE id=?').get('LOCAL-BOOKING').customer_id, 'LOCAL-OTHER');
});
