import test from 'node:test';
import assert from 'node:assert/strict';
import { installAiHooks, freshAiDb, seedCustomer, inboundMessage } from './helpers/ai-harness.mjs';
installAiHooks(); process.env.PAWSPACE_LOCAL_PREVIEW = 'off';
const { ensureCustomer360Tables } = await import('../lib/customer-360.ts');
const api = await import('../app/api/conversations/route.ts');
const { ensureSecurityTables } = await import('../lib/server-auth.ts');
const { ensureConversationAccessTables } = await import('../lib/conversation-access.ts');
const { ensureWhatsAppInboxProductivity } = await import('../lib/whatsapp-inbox-productivity.ts');
const { ensureWhatsAppTemplateLifecycle } = await import('../lib/whatsapp-template-lifecycle.ts');
const { ensureLeadIntakeAdAttribution } = await import('../lib/lead-intake-ad-attribution.ts');
const { requiredPermission } = await import('../lib/api-gateway.ts');
const origin = 'https://app.pawspace.in';
const owner = 'inbox.owner@pawspace.test', peer = 'inbox.peer@pawspace.test', restricted = 'inbox.restricted@pawspace.test';
function request(path = '', body, email = owner, requestOrigin = origin) {
  return new Request(origin + '/api/conversations' + path, { method: body ? 'POST' : 'GET', headers: { 'oai-authenticated-user-email': email, ...(body ? { origin: requestOrigin, 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function call(path, body, email) { const response = await api[body ? 'POST' : 'GET'](request(path, body, email)); return { status: response.status, body: await response.json() }; }
async function world(t) {
  const { sqlite, db } = freshAiDb(); t.after(() => sqlite.close());
  await ensureSecurityTables(db); await ensureCustomer360Tables(db); await ensureConversationAccessTables(db); await ensureWhatsAppInboxProductivity(db); await ensureWhatsAppTemplateLifecycle(db);
  const now = Date.now();
  for (const [email, role] of [[owner, 'admin'], [peer, 'admin'], [restricted, 'associate']]) sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,? ,?,'active',?,?)").run(email, email, 'Synthetic staff', role, now, now);
  for (const suffix of ['A', 'B', 'C']) {
    seedCustomer(sqlite, 'CUS-' + suffix, 'Synthetic customer ' + suffix, '+91990000000' + suffix);
    await inboundMessage(sqlite, db, { threadId: 'THREAD-' + suffix, customerId: 'CUS-' + suffix, text: 'Synthetic enquiry', channel: 'whatsapp', idempotencyKey: 'inbox-in-' + suffix });
    sqlite.prepare('UPDATE communication_threads SET assigned_to=?,updated_at=? WHERE id=?').run(suffix === 'B' ? peer : owner, now, 'THREAD-' + suffix);
    sqlite.prepare("UPDATE communication_messages SET provider='sandbox_simulator',created_at=? WHERE thread_id=?").run(now - 25 * 60 * 60_000, 'THREAD-' + suffix);
    sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at) VALUES (?,'sandbox_simulator',?)").run('CUS-' + suffix, now - 25 * 60 * 60_000);
    sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,1,0,0,0,'synthetic','test',?)").run('CUS-' + suffix, now);
  }
  const template = (key, { language = 'en_US', category = 'utility', status = 'approved', variables = [], body = 'PawSpace has a service update. Reply here for help.', reconciled = 'approved' } = {}) => {
    sqlite.prepare('INSERT INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?,?,?,?,?,?)').run(key, status, category, language, 'test', now);
    sqlite.prepare("INSERT INTO whatsapp_template_lifecycle (template_key,display_name,body,variables_json,meta_reconciliation_status,meta_reference,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,'META-SYNTHETIC','test',?,'test',?)").run(key, key, body, JSON.stringify(variables), reconciled, now, now);
  };
  template('service_update'); template('with_variable', { variables: ['{{1}}'], body: 'Hi {{1}}' }); template('marketing_offer', { category: 'marketing' }); template('local_only', { reconciled: 'not_submitted' }); template('draft_only', { status: 'draft' });
  return { sqlite, db, now };
}

test('triage filters intersect actor ownership, unread, channel, search and stable pagination', async t => {
  const { sqlite } = await world(t);
  let result = await call('?ownership=me&channel=whatsapp&priority=unread&q=Synthetic&limit=1');
  assert.equal(result.status, 200); assert.equal(result.body.data.threads[0].id, 'THREAD-C');
  const cursor = encodeURIComponent(JSON.stringify(result.body.data.nextCursor));
  result = await call('?ownership=me&channel=whatsapp&priority=unread&q=Synthetic&limit=1&cursor=' + cursor);
  assert.equal(result.body.data.threads[0].id, 'THREAD-A'); assert.equal(result.body.data.nextCursor, null);
  await call('', { action: 'priority', threadId: 'THREAD-A', unread: false });
  assert.equal((await call('?threadId=THREAD-A')).body.data.operatorState.unread, 0);
  assert.equal((await call('?threadId=THREAD-A', undefined, peer)).body.data.operatorState.unread, 1);
  await inboundMessage(sqlite, globalThis.__AI_DB__, { threadId: 'THREAD-A', customerId: 'CUS-A', text: 'A new message', idempotencyKey: 'inbox-new' });
  sqlite.prepare("UPDATE communication_messages SET created_at=? WHERE idempotency_key='inbox-new'").run(Date.now() + 2);
  assert.equal((await call('?threadId=THREAD-A')).body.data.operatorState.unread, 1);
  await call('', { action: 'priority', threadId: 'THREAD-A', favourite: true, actorEmail: peer });
  assert.deepEqual((await call('?priority=favourite')).body.data.threads.map(row => row.id), ['THREAD-A']);
  assert.equal((await call('?priority=favourite', undefined, peer)).body.data.threads.length, 0);
  assert.equal((await call('', { action: 'priority', threadId: 'THREAD-A', unread: 'yes' })).status, 400);
  assert.equal((await call('?priority=guessed')).status, 400);
});

test('saved views persist per actor, validate allowlisted filters and cannot delete a peer view', async t => {
  const { sqlite } = await world(t);
  const view = { channel: 'whatsapp', ownership: 'me', priority: 'unread', status: 'open', query: 'Synthetic' };
  for (let i = 0; i < 2; i++) assert.equal((await call('', { action: 'save_view', name: 'My WhatsApp', view, actorEmail: peer })).status, 200);
  assert.deepEqual((await call('?view=saved_views')).body.data.views[0].view, view);
  assert.equal((await call('?view=saved_views', undefined, peer)).body.data.views.length, 0);
  await call('', { action: 'delete_view', name: 'My WhatsApp' }, peer);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM conversation_operator_views').get().n, 1);
  assert.equal((await call('', { action: 'save_view', name: 'Bad', view: { ...view, actorEmail: peer } })).status, 400);
  assert.equal((await call('', { action: 'save_view', name: 'Bad', view: { ...view, query: 1 } })).status, 400);
  await call('', { action: 'delete_view', name: 'My WhatsApp' });
  assert.equal((await call('?view=saved_views')).body.data.views.length, 0);
});

test('new views and actions use the existing staff gateway and never admit cross-origin writes', async t => {
  await world(t);
  for (const req of [request('?view=saved_views'), request('?view=template_catalog'), request('', { action: 'template_reply' }), request('', { action: 'priority' })]) assert.equal(await requiredPermission(req), 'communications.manage');
  assert.equal((await api.POST(request('', { action: 'save_view', name: 'test', view: {} }, owner, 'https://evil.invalid'))).status, 403);
  for (const action of [{ action: 'priority', threadId: 'THREAD-A', favourite: true }, { action: 'template_reply', threadId: 'THREAD-A', templateKey: 'service_update', language: 'en_US', clientRequestId: 'restricted-1' }]) assert.equal((await call('', action, restricted)).status, 403);
  assert.equal((await call('?threadId=THREAD-A', undefined, restricted)).status, 403);
});

test('inspector source follows exact canonical provenance; only saved locality is returned', async t => {
  const { sqlite, db, now } = await world(t); await ensureLeadIntakeAdAttribution(db);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LEAD-A','CUS-A','website','grooming','Unassigned','Unassigned','active','day_1',1,?,?,?,?,?)").run(now, now, now, now, now);
  sqlite.prepare("UPDATE communication_threads SET lead_id='LEAD-A' WHERE id IN ('THREAD-A','THREAD-B')").run();
  sqlite.prepare("INSERT INTO lead_intake_ad_attribution (id,contact_id,lead_id,source_platform,utm_source,utm_medium,utm_campaign,campaign_id,ad_id,gclid,landing_url,created_at,updated_at) VALUES ('ATTR-A','CUS-A','LEAD-A','google','google','cpc','summer','CAMP-1','AD-1','SECRET-CLICK','https://private.invalid/?email=secret',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,area,city,is_default,created_at,updated_at) VALUES ('ADDR-A','CUS-A','Home','SECRET-STREET','Indiranagar','Bengaluru',1,?,?)").run(now, now);
  const context = (await call('?threadId=THREAD-A')).body.data.context;
  assert.equal(context.acquisition.origin, 'website'); assert.equal(context.acquisition.platform, 'google'); assert.equal(context.acquisition.utmCampaign, 'summer');
  assert.equal(context.savedLocality.area, 'Indiranagar'); assert.equal(context.savedLocality.kind, 'saved_contact_locality');
  for (const secret of ['SECRET-STREET', 'SECRET-CLICK', 'private.invalid']) assert.ok(!JSON.stringify(context).includes(secret));
  assert.equal((await call('?threadId=THREAD-B')).body.data.context.acquisition.platform, null, 'a mismatched lead ID cannot inherit another customer source');
  assert.equal((await call('?threadId=THREAD-C')).body.data.context.acquisition.origin, null, 'missing acquisition stays unknown');
});

test('closed-window template action queues the recorded body and exact language once after response loss', async t => {
  const { sqlite } = await world(t);
  const body = { action: 'template_reply', threadId: 'THREAD-A', templateKey: 'service_update', language: 'en_US', clientRequestId: 'template-retry-01', text: 'attacker supplied text', customerId: 'CUS-B', provider: 'meta_whatsapp' };
  const first = await call('', body); assert.equal(first.status, 201); assert.equal(first.body.data.queued, true);
  const queued = sqlite.prepare('SELECT payload_json,provider,status FROM communication_messages WHERE id=?').get(first.body.data.messageId);
  assert.equal(JSON.parse(queued.payload_json).text, 'PawSpace has a service update. Reply here for help.'); assert.equal(JSON.parse(queued.payload_json).language, 'en_US'); assert.equal(queued.provider, 'sandbox_simulator'); assert.equal(queued.status, 'queued');
  sqlite.prepare("UPDATE whatsapp_uat_templates SET status='paused' WHERE template_key='service_update'").run();
  const replay = await call('', body); assert.equal(replay.status, 200); assert.equal(replay.body.data.messageId, first.body.data.messageId); assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_outbox").get().n, 1);
  assert.equal((await call('', { ...body, language: 'en' })).status, 409);
  assert.equal((await call('?threadId=THREAD-A')).body.data.whatsappWindow.withinWindow, false, 'an outbound template does not reopen the reply window');
});

test('template selection refuses unverified, variable, marketing, wrong-language and open-window sends', async t => {
  const { sqlite } = await world(t);
  const catalogue = (await call('?view=template_catalog')).body.data.templates;
  assert.deepEqual(catalogue.filter(row => row.eligible).map(row => row.key), ['service_update']);
  for (const key of ['with_variable', 'marketing_offer', 'local_only', 'draft_only', 'missing']) assert.equal((await call('', { action: 'template_reply', threadId: 'THREAD-A', templateKey: key, language: 'en_US', clientRequestId: 'blocked-' + key })).status, 409);
  assert.equal((await call('', { action: 'template_reply', threadId: 'THREAD-A', templateKey: 'service_update', language: 'en', clientRequestId: 'blocked-language' })).status, 409);
  sqlite.prepare("UPDATE whatsapp_uat_sessions SET last_inbound_at=? WHERE customer_id='CUS-A'").run(Date.now());
  assert.equal((await call('?threadId=THREAD-A')).body.data.whatsappWindow.withinWindow, true);
  assert.equal((await call('', { action: 'template_reply', threadId: 'THREAD-A', templateKey: 'service_update', language: 'en_US', clientRequestId: 'blocked-window' })).status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n, 0);
});

test('template action preserves opt-out, AI ownership and open-thread requirements', async t => {
  const { sqlite, now } = await world(t);
  const body = { action: 'template_reply', threadId: 'THREAD-A', templateKey: 'service_update', language: 'en_US', clientRequestId: 'policy-refusal-1' };
  sqlite.prepare("UPDATE customer_contact_preferences SET opt_out=1 WHERE customer_id='CUS-A'").run(); assert.equal((await call('', body)).status, 409);
  sqlite.prepare("UPDATE customer_contact_preferences SET opt_out=0 WHERE customer_id='CUS-A'").run();
  sqlite.prepare("INSERT INTO whatsapp_conversation_routing_modes (thread_id,mode,updated_by,reason,updated_at) VALUES ('THREAD-A','ai_assistant','test','Synthetic AI ownership',?)").run(now); assert.equal((await call('', body)).status, 409);
  sqlite.prepare("UPDATE whatsapp_conversation_routing_modes SET mode='human_only' WHERE thread_id='THREAD-A'").run();
  sqlite.prepare("UPDATE communication_threads SET status='resolved' WHERE id='THREAD-A'").run(); assert.equal((await call('', body)).status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n, 0);
});


test('concurrent template retries share one durable message and outbox; a relink refuses replay', async t => {
  const { sqlite } = await world(t);
  const body = { action: 'template_reply', threadId: 'THREAD-A', templateKey: 'service_update', language: 'en_US', clientRequestId: 'concurrent-retry-1' };
  const results = await Promise.all([call('', body), call('', body)]);
  assert.ok(results.every(result => [200, 201].includes(result.status)));
  assert.equal(results[0].body.data.messageId, results[1].body.data.messageId);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n, 1);
  sqlite.prepare("UPDATE communication_threads SET customer_id='CUS-B' WHERE id='THREAD-A'").run();
  assert.equal((await call('', body)).status, 409, 'a receipt cannot transfer to a different canonical customer');
});

test('exactly 24 hours closes the reply window and permits only the approved template action', async t => {
  const { sqlite } = await world(t), clock = Date.now, now = clock();
  Date.now = () => now;
  try {
    sqlite.prepare("UPDATE whatsapp_uat_sessions SET last_inbound_at=? WHERE customer_id='CUS-A'").run(now - 24 * 60 * 60_000 + 1);
    assert.equal((await call('?threadId=THREAD-A')).body.data.whatsappWindow.withinWindow, true);
    const body = { action: 'template_reply', threadId: 'THREAD-A', templateKey: 'service_update', language: 'en_US', clientRequestId: 'exact-boundary-1' };
    assert.equal((await call('', body)).status, 409);
    sqlite.prepare("UPDATE whatsapp_uat_sessions SET last_inbound_at=? WHERE customer_id='CUS-A'").run(now - 24 * 60 * 60_000);
    assert.equal((await call('?threadId=THREAD-A')).body.data.whatsappWindow.withinWindow, false);
    assert.equal((await call('', body)).status, 201);
  } finally { Date.now = clock; }
});

test('central opt-out and provider kill switch create no template message', async t => {
  const { sqlite, db } = await world(t);
  const { recordGlobalOptOut } = await import('../lib/communication-governance.ts');
  await recordGlobalOptOut(db, { customerId: 'CUS-A', source: 'synthetic', actorId: owner });
  const body = { action: 'template_reply', threadId: 'THREAD-A', templateKey: 'service_update', language: 'en_US', clientRequestId: 'central-opt-out-1' };
  assert.equal((await call('', body)).status, 409);
  sqlite.prepare("UPDATE communication_consent SET global_opt_out=0,whatsapp_allowed=1 WHERE customer_id='CUS-A'").run();
  sqlite.prepare("UPDATE whatsapp_uat_provider_controls SET disabled=1 WHERE provider='sandbox_simulator'").run();
  assert.equal((await call('', body)).status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_outbox').get().n, 0);
});
