/**
 * Checking availability used to add every typed doorstep to the customer's saved places ("3 saved places"
 * after two checks), and V2 Account then showed those places with the PIN twice. Owner decision: a doorstep
 * is saved only when the customer ticks "Save this address"; availability checks resolve it without saving.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { world } from './helpers/execution-harness.mjs';
installWorkersHooks('__V2_ADDRESS_CONSENT_DB__', '__V2_ADDRESS_CONSENT_ENV__');
const { resolveGovernedServiceAddress } = await import('../lib/service-discovery-address.ts');
const { serviceAddressText } = await import('../lib/service-address-text.ts');
const env = { PAWSPACE_PAYMENT_ENV: 'sandbox', PAWSPACE_PAYMENT_LIVE_APPROVED: 'false', PAWSPACE_SCHEDULING_ENV: 'uat', PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: 'on' };
const fresh = () => world('__V2_ADDRESS_CONSENT_DB__', '__V2_ADDRESS_CONSENT_ENV__', env);
const address = '18th Main Road, BTM Layout, Bengaluru 560076, QA Tower, Flat 402';

test('an availability check resolves and geocodes a typed doorstep without saving it to the account', async () => {
  const w = fresh();
  const result = await resolveGovernedServiceAddress(w.db, { customerId: 'CONSENT-C', serviceCode: 'grooming', serviceAddress: address, servicePincode: '560076', saveToAccount: false });
  assert.equal(result.zoneId, 'blr-south');
  assert.ok(Number.isFinite(result.latitude));
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM customer_addresses').get().n, 0);
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM customer_service_address_geocodes').get().n, 1);
  // Checking the same doorstep again reuses the geocode and still saves nothing.
  await resolveGovernedServiceAddress(w.db, { customerId: 'CONSENT-C', serviceCode: 'grooming', serviceAddress: address, servicePincode: '560076', saveToAccount: false });
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM customer_addresses').get().n, 0);
  w.sqlite.close();
});

test('a doorstep the customer chose to save is saved once, and lists with its PIN only once', async () => {
  const w = fresh();
  await resolveGovernedServiceAddress(w.db, { customerId: 'CONSENT-C', serviceCode: 'grooming', serviceAddress: address, servicePincode: '560076', saveToAccount: true });
  const saved = w.sqlite.prepare('SELECT line1,area,city,postal_code FROM customer_addresses').all();
  assert.equal(saved.length, 1);
  const listed = serviceAddressText({ line1: saved[0].line1, area: saved[0].area, city: saved[0].city, postalCode: saved[0].postal_code });
  assert.equal(listed.match(/560076/g).length, 1, listed);
  w.sqlite.close();
});

test('a doorstep first checked without saving is still saved when the customer later ticks save at booking', async () => {
  const w = fresh();
  await resolveGovernedServiceAddress(w.db, { customerId: 'CONSENT-C', serviceCode: 'grooming', serviceAddress: address, servicePincode: '560076', saveToAccount: false });
  await resolveGovernedServiceAddress(w.db, { customerId: 'CONSENT-C', serviceCode: 'grooming', serviceAddress: address, servicePincode: '560076', saveToAccount: true });
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM customer_addresses').get().n, 1);
  w.sqlite.close();
});
