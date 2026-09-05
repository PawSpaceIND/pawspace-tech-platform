import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const evidence = { generatedAt: new Date().toISOString(), providers: {}, failures: [] };
const runTag = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required sandbox configuration: ${name}`);
  return value;
}
function list(value) { return String(value || '').split(/[\n,]/).map(v => v.trim()).filter(Boolean); }
async function jsonResponse(response) {
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw: raw.slice(0, 400) }; }
  return { response, body };
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function razorSignature(body, secret) { return createHmac('sha256', secret).update(body).digest('hex'); }
function metaSignature(body, secret) { return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`; }

async function certifyRazorpay() {
  const key = required('RAZORPAY_KEY_ID_SANDBOX');
  const secret = required('RAZORPAY_KEY_SECRET_SANDBOX');
  const webhookSecret = required('RAZORPAY_WEBHOOK_SECRET_SANDBOX');
  const appBase = required('P0_STAGING_BASE_URL').replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
  const headers = { authorization: auth, 'content-type': 'application/json' };

  const created = await jsonResponse(await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST', headers,
    body: JSON.stringify({ amount: 100, currency: 'INR', receipt: `p0-${runTag}`.slice(0, 40), notes: { purpose: 'p0-pilot-certification' } }),
  }));
  assert(created.response.ok, `Razorpay sandbox order creation failed: ${created.response.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  assert(/^order_/.test(String(created.body?.id || '')), 'Razorpay sandbox did not return an order id');

  const fetched = await jsonResponse(await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(created.body.id)}`, { headers: { authorization: auth } }));
  assert(fetched.response.ok, `Razorpay sandbox order retrieval failed: ${fetched.response.status}`);
  assert(Number(fetched.body?.amount) === 100, 'Razorpay sandbox order amount drifted');

  const injected = await jsonResponse(await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST', headers,
    body: JSON.stringify({ amount: 0, currency: 'INVALID', receipt: `p0-bad-${runTag}`.slice(0, 40) }),
  }));
  assert(injected.response.status >= 400 && injected.response.status < 500, `Razorpay error injection was not rejected: ${injected.response.status}`);

  const eventId = `p0-event-${runTag}`;
  const payload = JSON.stringify({
    event: 'payment.failed', created_at: Math.floor(Date.now() / 1000),
    payload: { payment: { entity: { id: `pay_p0_${runTag.replace(/\W/g, '')}`, order_id: created.body.id, amount: 100, currency: 'INR', notes: {} } } },
  });
  const webhookHeaders = {
    'content-type': 'application/json',
    'x-razorpay-event-id': eventId,
    'x-razorpay-signature': razorSignature(payload, webhookSecret),
  };
  const first = await jsonResponse(await fetch(`${appBase}/api/razorpay-webhook`, { method: 'POST', headers: webhookHeaders, body: payload }));
  assert(first.response.status < 500, `PawSpace Razorpay webhook first delivery failed: ${first.response.status} ${JSON.stringify(first.body).slice(0, 300)}`);
  const replay = await jsonResponse(await fetch(`${appBase}/api/razorpay-webhook`, { method: 'POST', headers: webhookHeaders, body: payload }));
  assert(replay.response.ok, `PawSpace Razorpay webhook replay failed: ${replay.response.status} ${JSON.stringify(replay.body).slice(0, 300)}`);
  assert(replay.body?.duplicate === true, `Razorpay replay did not report duplicate=true: ${JSON.stringify(replay.body).slice(0, 300)}`);

  const altered = JSON.stringify({ ...JSON.parse(payload), created_at: Math.floor(Date.now() / 1000) + 1 });
  const mismatch = await jsonResponse(await fetch(`${appBase}/api/razorpay-webhook`, {
    method: 'POST',
    headers: { ...webhookHeaders, 'x-razorpay-signature': razorSignature(altered, webhookSecret) },
    body: altered,
  }));
  assert(mismatch.response.status === 409, `Razorpay same-event-id/different-payload replay was not rejected with 409: ${mismatch.response.status}`);

  evidence.providers.razorpay = {
    hostedOrderCreate: 'pass', hostedOrderRead: 'pass', providerErrorInjection: 'pass',
    webhookFirstStatus: first.response.status, replayIdempotency: 'pass', replayMutationRefusal: 'pass',
    orderIdPrefix: String(created.body.id).split('_')[0],
  };
}

async function certifyMeta() {
  const token = required('META_WHATSAPP_UAT_ACCESS_TOKEN');
  const phoneId = required('META_WHATSAPP_PHONE_NUMBER_ID');
  const wabaId = required('META_WHATSAPP_WABA_ID');
  const appSecret = required('META_WHATSAPP_APP_SECRET');
  const recipient = list(required('META_WHATSAPP_UAT_ALLOWLIST'))[0];
  const permittedTemplates = new Set(list(required('META_WHATSAPP_TEMPLATE_ALLOWLIST')));
  const appBase = required('P0_STAGING_BASE_URL').replace(/\/$/, '');
  const version = String(process.env.META_WHATSAPP_GRAPH_VERSION || 'v23.0').trim();
  const graph = `https://graph.facebook.com/${version}`;
  const authHeaders = { authorization: `Bearer ${token}` };

  const templateRes = await jsonResponse(await fetch(`${graph}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,language,components&limit=100`, { headers: authHeaders }));
  assert(templateRes.response.ok, `Meta template inventory failed: ${templateRes.response.status} ${JSON.stringify(templateRes.body).slice(0, 300)}`);
  const approved = (templateRes.body?.data || []).filter(t => t.status === 'APPROVED' && permittedTemplates.has(t.name));
  assert(approved.length > 0, 'No approved Meta template matches META_WHATSAPP_TEMPLATE_ALLOWLIST');
  const sendable = approved.find(t => !JSON.stringify(t.components || []).includes('{{'));
  assert(sendable, 'No parameterless approved allowlisted Meta template is available for automated delivery proof');

  const send = await jsonResponse(await fetch(`${graph}/${encodeURIComponent(phoneId)}/messages`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient.replace(/\D/g, ''), type: 'template', template: { name: sendable.name, language: { code: sendable.language } } }),
  }));
  assert(send.response.ok, `Meta allowlisted template delivery failed: ${send.response.status} ${JSON.stringify(send.body).slice(0, 300)}`);
  const messageId = String(send.body?.messages?.[0]?.id || '');
  assert(messageId.startsWith('wamid.'), 'Meta send did not return a WhatsApp message id');

  const statusPayload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phoneId },
      statuses: [{ id: messageId, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: recipient.replace(/\D/g, '') }],
    } }] }],
  });
  const signature = metaSignature(statusPayload, appSecret);
  const invalid = await jsonResponse(await fetch(`${appBase}/api/whatsapp/meta-webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=invalid' }, body: statusPayload,
  }));
  assert([401, 403].includes(invalid.response.status), `Meta invalid webhook signature was not rejected: ${invalid.response.status}`);
  const validHeaders = { 'content-type': 'application/json', 'x-hub-signature-256': signature };
  const first = await jsonResponse(await fetch(`${appBase}/api/whatsapp/meta-webhook`, { method: 'POST', headers: validHeaders, body: statusPayload }));
  assert(first.response.ok, `Meta signed webhook failed: ${first.response.status} ${JSON.stringify(first.body).slice(0, 300)}`);
  const replay = await jsonResponse(await fetch(`${appBase}/api/whatsapp/meta-webhook`, { method: 'POST', headers: validHeaders, body: statusPayload }));
  assert(replay.response.ok, `Meta signed webhook replay failed: ${replay.response.status} ${JSON.stringify(replay.body).slice(0, 300)}`);

  evidence.providers.metaWhatsapp = {
    hostedTemplateInventory: 'pass', allowlistedTemplateDelivery: 'pass', invalidSignatureRefusal: 'pass',
    signedStatusWebhook: 'pass', signedStatusReplay: 'pass', template: sendable.name,
  };
}

async function certifyMaps() {
  const key = required('GOOGLE_MAPS_SERVER_API_KEY_UAT');
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', 'Koramangala, Bengaluru, Karnataka, India');
  url.searchParams.set('key', key);
  const result = await jsonResponse(await fetch(url));
  assert(result.response.ok, `Google Maps transport failed: ${result.response.status}`);
  assert(result.body?.status === 'OK', `Google Maps geocode failed: ${result.body?.status} ${result.body?.error_message || ''}`);
  const location = result.body?.results?.[0]?.geometry?.location;
  assert(Number.isFinite(Number(location?.lat)) && Number.isFinite(Number(location?.lng)), 'Google Maps returned no coordinates');
  evidence.providers.mapsGps = { hostedGeocode: 'pass', resultCount: result.body.results.length };
}

for (const [name, fn] of [['razorpay', certifyRazorpay], ['metaWhatsapp', certifyMeta], ['mapsGps', certifyMaps]]) {
  try { await fn(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    evidence.failures.push({ provider: name, message });
    console.error(`[P0 provider ${name}] ${message}`);
  }
}

await writeFile(process.env.P0_PROVIDER_EVIDENCE || 'p0-provider-evidence.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
if (evidence.failures.length) process.exit(1);
