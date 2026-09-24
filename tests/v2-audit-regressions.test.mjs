import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { world, seedActors, asActor } from './helpers/execution-harness.mjs';
installWorkersHooks('__V2_AUDIT_REGRESSION_DB__', '__V2_AUDIT_REGRESSION_ENV__');
const { serviceAddressConflict } = await import('../lib/service-address-consistency.ts');
const { resolveGovernedServiceAddress } = await import('../lib/service-discovery-address.ts');
const { validateCrmLead } = await import('../lib/crm-lead-validation.ts');
const crm = await import('../app/api/crm/route.ts');
const contact = await import('../app/api/public-contact/route.ts');
const env = { PAWSPACE_PAYMENT_ENV: 'sandbox', PAWSPACE_PAYMENT_LIVE_APPROVED: 'false', PAWSPACE_SCHEDULING_ENV: 'uat', PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: 'on', PAWSPACE_WORKSPACE_IDENTITY_TRUST: 'openai-dispatch' };
const fresh = () => world('__V2_AUDIT_REGRESSION_DB__', '__V2_AUDIT_REGRESSION_ENV__', env);
for (const address of [
 '24 QA Test Road, Andheri West, Mumbai, Maharashtra 560076',
 '24 QA Test Road, New Delhi, 560076',
 '24 QA Test Road, Chennai, Tamil Nadu 560076',
 '24 QA Test Road, Bengaluru 560076, PIN 560038',
 '24 QA Test Road, Bengaluru, Maharashtra 560076',
]) test(`contradictory service address is refused: ${address}`, () => {
 assert.ok(serviceAddressConflict(address, 'Bengaluru', '560076'));
});
for (const address of [
 '18th Main Road, BTM Layout, Bengaluru 560076',
 '18th Main Road, BTM Layout, Bangalore 560076, QA Tower Flat 402',
 'Mumbai Road, Bengaluru 560076',
 'Near Mumbai Cafe, BTM Layout, Bengaluru 560076',
 'Near Bank of Maharashtra, BTM Layout, Bengaluru 560076',
]) test(`consistent address remains valid: ${address}`, () => {
 assert.equal(serviceAddressConflict(address, 'Bengaluru', '560076'), null);
});
test('server address authority refuses contradictory city before saving a customer address', async () => {
 const w = fresh();
 await assert.rejects(() => resolveGovernedServiceAddress(w.db, { customerId: 'AUDIT-CUSTOMER', serviceCode: 'grooming', serviceAddress: '24 QA Test Road, Mumbai, Maharashtra 560076', servicePincode: '560076' }), error => error instanceof Response && error.status === 400);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM customer_addresses').get().n, 0);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM customer_service_address_geocodes').get().n, 0);
 w.sqlite.close();
});
test('consistent server address persists the street and apartment without losing locality', async () => {
 const w = fresh();
 const address = '18th Main Road, BTM Layout, Bengaluru 560076, QA Tower, Flat 402';
 const result = await resolveGovernedServiceAddress(w.db, { customerId: 'AUDIT-CUSTOMER', serviceCode: 'grooming', serviceAddress: address, servicePincode: '560076' });
 assert.equal(result.cityId, 'blr'); assert.equal(result.zoneId, 'blr-south');
 assert.match(result.address, /18th Main Road/); assert.match(result.address, /Flat 402/);
 const saved = w.sqlite.prepare('SELECT line1 FROM customer_addresses').get();
 assert.match(saved.line1, /18th Main Road/); assert.match(saved.line1, /Flat 402/);
 w.sqlite.close();
});
for (const phone of ['12', '', '0000000000', '1234567890', '9000000801999', 'abc9000000801']) test(`CRM validation rejects invalid mobile ${JSON.stringify(phone)}`, () => {
 assert.equal(validateCrmLead({ name: 'QA Audit Lead', primaryPhone: phone }).ok, false);
});
for (const phone of ['9000000801', '+91 90000 00801', '919000000801']) test(`CRM validation accepts a complete mobile ${phone}`, () => {
 assert.deepEqual(validateCrmLead({ name: '  QA Audit Lead  ', primaryPhone: phone }), { ok: true, name: 'QA Audit Lead', phone: '9000000801' });
});
async function staffWorld() {
 const w = fresh();
 await seedActors(w.sqlite, w.db, [{ id: 'AUDIT-ASSOCIATE', email: 'audit.associate@pawspace.test', role: 'founder' }]);
 return w;
}
const staffPost = body => crm.POST(asActor('audit.associate@pawspace.test', '/api/crm', { method: 'POST', body: JSON.stringify(body) }));
test('real CRM route rejects the audited two-digit number without creating a contact', async () => {
 const w = await staffWorld();
 const response = await staffPost({ name: 'QA Audit Invalid Phone', primaryPhone: '12', petNames: 'QA Pet', service: 'Grooming', whatsappConsent: false });
 assert.equal(response.status, 400, await response.clone().text());
 const exists = w.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_contacts'").get();
 assert.equal(exists ? w.sqlite.prepare('SELECT COUNT(*) n FROM crm_contacts').get().n : 0, 0);
 w.sqlite.close();
});
test('Relocation manual lead creates a real CRM contact and matching lead work item', async () => {
 const w = await staffWorld();
 const response = await staffPost({ name: 'QA Audit Relocation', primaryPhone: '9000000801', petNames: 'QA Pet', service: 'Relocation', whatsappConsent: false });
 const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body));
 assert.equal(w.sqlite.prepare('SELECT opportunity FROM crm_contacts WHERE id=?').get(body.id).opportunity, 'Relocation');
 assert.equal(w.sqlite.prepare('SELECT service FROM lead_work_items WHERE id=?').get(body.leadId).service, 'Relocation');
 assert.notEqual(body.whatsappAi?.status, 'delivered');
 w.sqlite.close();
});
test('five-pet enquiry follows the existing idempotent CRM intake without sending WhatsApp', async () => {
 const w = fresh();
 const body = { name: 'QA Large Family', phone: '9000000803', service: 'Grooming', petNames: 'Bruno, Milo, Rex, Coco, Pip',
   message: 'Please plan grooming for five pets', whatsappConsent: false, requestId: 'audit-large-family-20260924-001' };
 const submit = () => contact.POST(new Request('https://app.pawspace.in/api/public-contact', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.79' }, body: JSON.stringify(body) }));
 const first = await submit(), firstBody = await first.json(); assert.equal(first.status, 201, JSON.stringify(firstBody));
 const retry = await submit(), retryBody = await retry.json(); assert.equal(retry.status, 200, JSON.stringify(retryBody));
 assert.equal(firstBody.leadId, retryBody.leadId);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM crm_contacts').get().n, 1);
 assert.equal(w.sqlite.prepare('SELECT pet_names FROM crm_contacts').get().pet_names, body.petNames);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM lead_work_items').get().n, 1);
 w.sqlite.close();
});
test('manual CRM still rejects an unprivileged associate; audit fixes do not relax permissions', async () => {
 const w = fresh();
 await seedActors(w.sqlite, w.db, [{ id: 'AUDIT-LOW-ROLE', email: 'audit.associate@pawspace.test', role: 'associate' }]);
 const response = await staffPost({ name: 'QA Limited Role', primaryPhone: '9000000801', service: 'Relocation' });
 assert.equal(response.status, 403);
 w.sqlite.close();
});
test('shared API deadline aborts a stalled JSON body after headers, not just the connection', { timeout: 3000 }, async t => {
 const { createServer } = await import('node:http');
 const { apiRequest, ApiError } = await import('../lib/api-fetch.ts');
 let headersSent = false;
 const server = createServer((_request, response) => {
   response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders();
   response.write('{"data":'); headersSent = true;
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => { server.closeAllConnections(); server.close(); });
 await assert.rejects(() => apiRequest(`http://127.0.0.1:${server.address().port}/body`, {}, { timeoutMs: 250 }), error => error instanceof ApiError && error.kind === 'timeout');
 assert.equal(headersSent, true, 'the deadline must cover the body after successful headers');
});
test('caller cancellation is preserved when the shared helper adds its own deadline', { timeout: 3000 }, async t => {
 const { createServer } = await import('node:http');
 const { apiRequest } = await import('../lib/api-fetch.ts');
 const server = createServer((_request, response) => { response.writeHead(200); response.flushHeaders(); });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 t.after(() => { server.closeAllConnections(); server.close(); });
 const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 100);
 try { await assert.rejects(() => apiRequest(`http://127.0.0.1:${server.address().port}/body`, { signal: controller.signal }, { timeoutMs: 2000 }), error => error instanceof DOMException && error.name === 'AbortError'); }
 finally { clearTimeout(timer); }
});
test('address validation bounds oversized inputs and handles repeated separators without backtracking', () => {
 assert.match(serviceAddressConflict('x'.repeat(2001), 'Bengaluru', '560076'), /2,000 characters/);
 assert.match(serviceAddressConflict('\n'.repeat(1900) + 'Maharashtra', 'Bengaluru', '560076'), /state does not match/);
 assert.equal(serviceAddressConflict('\n'.repeat(1900) + 'Karnataka', 'Bengaluru', '560076'), null);
 assert.match(serviceAddressConflict('Road,  Maharashtra  560076  India', 'Bengaluru', '560076'), /state does not match/);
});
test('postal parsing distinguishes legitimate six-digit property numbers from explicit postal conflicts', async () => {
 const { serviceAddressPincodes } = await import('../lib/service-address-pincode.ts');
 for (const address of [
   'Flat 123456, 18th Main Road, Bengaluru 560076',
   'Building No 123456, BTM Layout, Bengaluru 560076',
   'BTM Layout, Bengaluru 560076, Reference number 123456',
   '123456, 18th Main Road, Bengaluru 560076',
   'PIN 560076, landmark reference 123456',
 ]) {
   assert.deepEqual(serviceAddressPincodes(address), ['560076'], address);
   assert.equal(serviceAddressConflict(address, 'Bengaluru', '560076'), null, address);
 }
 const conflicting = 'Flat 123456, Bengaluru, PIN 560076, postal code 560038';
 assert.deepEqual(serviceAddressPincodes(conflicting), ['560076', '560038']);
 assert.match(serviceAddressConflict(conflicting, 'Bengaluru', '560076'), /PIN code do not match/);
});
