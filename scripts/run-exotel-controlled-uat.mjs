import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const text = (value) => String(value ?? '').trim();
const fail = (message) => { throw new Error(message); };
const required = (name) => {
  const value = text(process.env[name]);
  if (!value) fail(`${name} is required`);
  return value;
};

if (text(process.env.PAWSPACE_PAYMENT_ENV) !== 'sandbox') {
  fail('Refusing carrier UAT unless PAWSPACE_PAYMENT_ENV=sandbox');
}
if (text(process.env.PAWSPACE_COMMUNICATION_ENV) !== 'sandbox') {
  fail('Refusing carrier UAT unless PAWSPACE_COMMUNICATION_ENV=sandbox');
}
if (text(process.env.PAWSPACE_UAT_CALL_CONFIRM) !== 'voice-uat') {
  fail('Set PAWSPACE_UAT_CALL_CONFIRM=voice-uat for one explicit operator-controlled call');
}

const base = new URL(required('UAT_STAGING_URL'));
if (base.protocol !== 'https:') fail('UAT_STAGING_URL must be https');
base.pathname = base.pathname.replace(/\/$/, '');
const operatorEmail = required('PAWSPACE_UAT_OPERATOR_EMAIL');
const accessCode = required('PAWSPACE_UAT_ACCESS_CODE');
const phone = required('PAWSPACE_VOICE_UAT_PHONE');
if (!/^\+[1-9]\d{7,14}$/.test(phone)) fail('PAWSPACE_VOICE_UAT_PHONE must be one E.164 number');
const customerId = text(process.env.UAT_CUSTOMER_ID);
const leadId = text(process.env.UAT_LEAD_ID);
if (!customerId && !leadId) fail('UAT_CUSTOMER_ID or UAT_LEAD_ID is required');
const bookingId = text(process.env.UAT_BOOKING_ID);
const cityId = text(process.env.UAT_CITY_ID) || 'blr';
const useCase = text(process.env.UAT_USE_CASE) || 'booking_confirmation';
const expectedSha = required('PAWSPACE_UAT_EXPECTED_SHA');
if (!/^[0-9a-f]{40}$/.test(expectedSha)) fail('PAWSPACE_UAT_EXPECTED_SHA must be exactly 40 lowercase hex characters');

const url = (path) => new URL(path, `${base.origin}/`).toString();
const origin = base.origin;
let cookie = '';

async function request(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('accept', 'application/json');
  if (init.method && init.method !== 'GET') {
    headers.set('content-type', 'application/json');
    headers.set('origin', origin);
  }
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(url(path), { ...init, headers, redirect: 'manual' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(`${path} failed (${response.status}): ${payload.error || 'request refused'}`);
  return { response, payload };
}

const login = await request('/api/staging-login', {
  method: 'POST',
  body: JSON.stringify({ action: 'login', code: accessCode, email: operatorEmail }),
});
const setCookies = typeof login.response.headers.getSetCookie === 'function'
  ? login.response.headers.getSetCookie()
  : [login.response.headers.get('set-cookie')].filter(Boolean);
if (!setCookies.length) fail('Staging login did not issue an operator session cookie');
cookie = setCookies.map(value => value.split(';', 1)[0]).join('; ');

const readinessResult = await request('/api/voice-outbound');
const readiness = readinessResult.payload.data;
if (!readiness?.gate?.enabled) fail(`Voice gate is disabled: ${readiness?.gate?.blockedReason || 'unknown reason'}`);
if (!readiness?.gate?.uatApproved) fail('Voice UAT is not approved on this staging deployment');
if (readiness?.gate?.mode === 'live') fail('Refusing controlled UAT against live voice mode');
if (!readiness?.transport?.configured) fail('Telephony transport is not configured');

const callInput = { useCase, phone, cityId, customerId: customerId || null, leadId: leadId || null, bookingId: bookingId || null };
const previewResult = await request('/api/voice-outbound', {
  method: 'POST',
  body: JSON.stringify({ action: 'policy_preview', ...callInput }),
});
const preview = previewResult.payload.data;
if (!preview?.allowed) fail(`Policy preview blocked the call: ${preview?.blockedBy || 'unknown'} ${preview?.blockedDetail || ''}`.trim());

const idempotencyKey = `operator-carrier-uat:${expectedSha}:${randomUUID()}`;
const callResult = await request('/api/voice-outbound', {
  method: 'POST',
  body: JSON.stringify({ action: 'request_call', idempotencyKey, ...callInput }),
});
const call = callResult.payload.data;
if (!call?.callId || !call?.dialled) fail(`Carrier call was not dialled; state=${call?.state || 'unknown'}`);

const terminal = new Set(['ended', 'completed', 'failed', 'provider_error', 'provider_unavailable', 'cancelled']);
let audit;
let aiAudit = null;
const deadline = Date.now() + Number(text(process.env.PAWSPACE_UAT_POLL_MS) || 240000);
while (Date.now() < deadline) {
  audit = (await request(`/api/voice-outbound?scope=audit&callId=${encodeURIComponent(call.callId)}`)).payload.data;
  if (audit?.call?.transcriptRef) {
    try { aiAudit = (await request(`/api/ai-voice-uat?callId=${encodeURIComponent(audit.call.transcriptRef)}`)).payload.data; }
    catch { aiAudit = null; }
  }
  if (terminal.has(text(audit?.call?.state))) break;
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (!audit) fail('No carrier audit was returned');

const providerEvents = Array.isArray(audit.providerEvents) ? audit.providerEvents : [];
const segments = Array.isArray(aiAudit?.segments) ? aiAudit.segments : [];
const aiEvents = Array.isArray(aiAudit?.events) ? aiAudit.events : [];
const providerCallId = text(audit?.call?.providerCallId);
const customerSpeech = segments.some(segment => text(segment?.speaker) === 'customer' && text(segment?.transcriptText ?? segment?.transcript_text));
const assistantSpeech = segments.some(segment => text(segment?.speaker) === 'assistant' && text(segment?.transcriptText ?? segment?.transcript_text));
const eventText = JSON.stringify(aiEvents).toLowerCase();
const evidence = {
  exactSha: expectedSha,
  callId: text(call.callId),
  providerCallId,
  finalState: text(audit?.call?.state),
  providerEvents: providerEvents.length,
  transcriptSegments: segments.length,
  aiEvents: aiEvents.length,
  customerSpeech,
  assistantSpeech,
  hasBargeInTelemetry: /barge|interrupt/.test(eventText),
  hasSttTelemetry: /stt|transcri|whisper/.test(eventText) || customerSpeech,
  hasTtsTelemetry: /tts|audio|melotts|deepgram/.test(eventText) || assistantSpeech,
  disposition: text(aiAudit?.call?.disposition),
  outcome: text(aiAudit?.call?.outcome),
  rawAudioStored: Boolean(aiAudit?.truth?.rawAudioStored),
  productionTelephony: Boolean(aiAudit?.truth?.productionTelephony),
};

if (!providerCallId) fail('Missing Exotel provider call id / CallSid evidence');
if (!providerEvents.length) fail('Missing provider callback telemetry');
if (!customerSpeech || !assistantSpeech) fail('Missing two-way STT/assistant transcript evidence');
if (!evidence.hasSttTelemetry || !evidence.hasTtsTelemetry) fail('Missing STT/TTS telemetry evidence');
if (evidence.productionTelephony) fail('UAT audit unexpectedly reports production telephony');
if (evidence.rawAudioStored) fail('UAT audit unexpectedly reports raw-audio persistence');
if (!evidence.disposition) fail('Missing idempotent CRM disposition evidence');

await mkdir('artifacts', { recursive: true });
const safeCall = text(call.callId).replace(/[^A-Za-z0-9_.-]/g, '_');
const artifactPath = `artifacts/exotel-carrier-uat-${safeCall}.json`;
await writeFile(artifactPath, `${JSON.stringify({ evidence, audit, aiAudit }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, artifactPath, evidence }, null, 2));
