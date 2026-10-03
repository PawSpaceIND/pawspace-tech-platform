import {mkdir,writeFile} from 'node:fs/promises';
// Read-only verification after an explicit app-governed call. This module never dials or repairs data.
import { inspectHandsetEvidence, inspectAttendedHandsetEvidence, partialHandsetCarrier } from '../lib/voice-handset-evidence.ts';
import { readBoundedText } from '../lib/provider-response-bounds.ts';
import { handsetVerifierConfig } from './voice-handset-preflight.mjs';
const origin = 'https://pawspace-staging.karthik-fce.workers.dev';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const terminalCarrier = new Set(['completed', 'no-answer', 'no_answer', 'busy', 'failed', 'canceled', 'cancelled', 'from_leg_unanswered', 'to_leg_unanswered', 'from_leg_no_dial', 'to_leg_no_dial']);

export async function verifyHandsetAttempt(context, env, options = {}) {
  const { appCallId, agentId, phone, cookie } = context;
  const config = handsetVerifierConfig(env);
  if (!id(appCallId) || !id(agentId) || !/^\+91[6-9]\d{9}$/.test(phone || '') || !/^pawspace_uat=[^\r\n;]+$/.test(cookie || '')) throw Error('Exact authenticated handset context required');
  const request = options.fetchImpl || fetch;
  const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, Math.min(Number(options.maxAttempts) || 120, 120));
  async function read(url, headers) {
    const response = await request(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw Error(`Handset evidence read refused (${response.status}); no retry or alternate region`);
    const raw = await readBoundedText(response, 1048576);
    try { return JSON.parse(raw); } catch { throw Error('Handset evidence response was not valid JSON'); }
  }
  const auditBody = await read(origin + '/api/voice-outbound?scope=audit&callId=' + encodeURIComponent(appCallId), { cookie });
  const appAudit = auditBody?.data;
  const correlation = appAudit?.providerCorrelation;
  const partial = correlation?.carrierCallId === null && id(correlation?.conversationId) && appAudit?.call?.providerCallId === correlation.conversationId;
  if (appAudit?.call?.callId !== appCallId || appAudit?.call?.provider !== 'elevenlabs_exotel' || appAudit?.call?.dialed !== true || !id(correlation?.conversationId) || correlation?.agentId !== agentId || (!partial && (!id(correlation?.carrierCallId) || appAudit?.call?.providerCallId !== correlation.carrierCallId))) throw Error('Exact provider correlation unavailable; do not guess a latest call');
  await mkdir('artifacts/attended-seven-minute',{recursive:true});
  await writeFile('artifacts/attended-seven-minute/app-audit.json',JSON.stringify(appAudit,null,2));
  const elevenUrl = config.elevenOrigin + '/v1/convai/conversations/' + encodeURIComponent(correlation.conversationId);
  const carrierHeaders = { authorization: 'Basic ' + Buffer.from(env.EXOTEL_API_KEY + ':' + env.EXOTEL_API_TOKEN).toString('base64') };
  const deadline = Date.now() + 510000;
  let last;
  for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
    let conversation = null, carrierId = correlation.carrierCallId;
    if (partial) {
      conversation = await read(elevenUrl, { 'xi-api-key': env.ELEVENLABS_API_KEY });
      carrierId = partialHandsetCarrier({appCallId, agentId, phone, appAudit, conversation});
      if (!carrierId) {
        last = { reason: 'partial_acceptance_unresolved' };
        if (!['initiated', 'in-progress', 'processing'].includes(conversation?.status)) break;
        if (attempt + 1 < maxAttempts) await delay(4000);
        continue;
      }
    }
    const carrierUrl = `${config.carrierOrigin}/v1/Accounts/${encodeURIComponent(config.accountId)}/Calls/${encodeURIComponent(carrierId)}.json?details=true`;
    const carrier = await read(carrierUrl, carrierHeaders);
    const carrierRecord = carrier?.Call ?? carrier?.call ?? carrier;
    const carrierStatus = String(carrierRecord?.Status ?? carrierRecord?.status ?? '').toLowerCase();
    last = inspectHandsetEvidence({ appCallId, agentId, phone, appAudit, carrier, conversation });
    if (terminalCarrier.has(carrierStatus) && carrierStatus !== 'completed') throw Error('Handset conversation not verified: ' + last.reason);
    conversation ??= await read(elevenUrl, { 'xi-api-key': env.ELEVENLABS_API_KEY });
    await writeFile('artifacts/attended-seven-minute/conversation.json',JSON.stringify(conversation,null,2));
    await writeFile('artifacts/attended-seven-minute/carrier.json',JSON.stringify(carrier,null,2));
    last = inspectHandsetEvidence({ appCallId, agentId, phone, appAudit, carrier, conversation });
    if (typeof options.log === 'function') options.log(last);
    if (options.attendedReport && terminalCarrier.has(carrierStatus) && ['done', 'failed'].includes(conversation?.status)) {
      const attended = inspectAttendedHandsetEvidence({ appCallId, agentId, phone, appAudit, carrier, conversation }, options.attendedReport);
      if (typeof options.log === 'function') options.log(attended);
      if (attended.attendedPassed) return attended;
      throw Error('Attended handset confirmation not verified: ' + attended.attendanceReason);
    }
    if (last.passed) return last;
    if (['done', 'failed'].includes(conversation?.status) && terminalCarrier.has(carrierStatus)) break;
    if (attempt + 1 < maxAttempts) await delay(4000);
  }
  throw Error('Handset conversation not verified: ' + (last?.reason || 'evidence_deadline_exceeded'));
}
