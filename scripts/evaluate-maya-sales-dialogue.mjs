// Model-level evaluation only: synthetic context, no PawSpace API, DB or telephony access.
import { mkdir, writeFile } from 'node:fs/promises';
import { installWorkersHooks } from '../tests/helpers/module-hooks.mjs';
import { humanCallPrompt } from '../lib/elevenlabs-human-call-profile.mjs';
installWorkersHooks('__MAYA_DIALOGUE_NO_DB__', '__MAYA_DIALOGUE_NO_ENV__');
const { pawspaceChannelSystemPrompt, parseGroundedActionEnvelope, VOICE_COUPON_DIRECTIVE } = await import('../lib/ai-grounded-runtime-provider.ts');
const { APPROVED_OFFERS_DIRECTIVE } = await import('../lib/ai-sales-offers.ts');
const { specialistSalesPrompt } = await import('../lib/voice-sales-specialists.ts');

if (process.env.VOICE_SALE_ACTION !== 'evaluate-sales-dialogue') throw Error('Explicit no-call dialogue evaluation required');
const key = String(process.env.PAWSPACE_OPENAI_API_KEY || process.env.PAWSPACE_AI_PROVIDER_API_KEY || '').trim();
if (!key) throw Error('Model evaluation credential missing');
const model = String(process.env.PAWSPACE_AI_VOICE_MODEL || 'gpt-5.6-luna').trim();
const instructions = humanCallPrompt(pawspaceChannelSystemPrompt('voice') + '\n' + specialistSalesPrompt('grooming', { coupons: true }) + '\n' + APPROVED_OFFERS_DIRECTIVE + VOICE_COUPON_DIRECTIVE);
// These prices are test fixtures, never an assertion about today's commercial catalogue.
const fixture = {
  syntheticEvaluation: true, salesService: 'grooming', timezone: 'Asia/Kolkata',
  customer: { id: 'CUS-SYNTHETIC-EVAL', name: 'Asha' }, pets: [{ id: 'PET-SYNTHETIC-EVAL', name: 'Milo', species: 'dog', breed: 'Golden Retriever', ageYears: 3 }],
  serviceDirectory: [{ code: 'grooming', name: 'Grooming', enabled: true }, { code: 'boarding', name: 'Boarding', enabled: true }, { code: 'dog_walking', name: 'Dog Walking', enabled: true }],
  catalogue: { grooming: [{ package_code: 'dog-basic', name: 'Bath & Basic', base_price: 1499, currency: 'INR', description: 'Bath and hygiene care, no full-body trim.' }, { package_code: 'dog-complete', name: 'Complete Makeover', base_price: 2399, currency: 'INR', description: 'Bath, hygiene care and full-body trimming.' }] },
  approvedKnowledge: { results: [{ id: 'SYNTHETIC-BOARDING', text: 'Boarding provides overnight pet care while the parent travels. Staff verifies dates, pet needs and availability; this Grooming specialist cannot book Boarding.' }, { id: 'SYNTHETIC-WALKING', text: 'Dog Walking supports routine exercise. Ask whether the parent wants information; do not promise walker availability.' }] },
  approvedOffers: [{ code: 'GROOM200', package_code: 'dog-complete', discount: 200, text: 'Approved fixture offer: 200 rupees off Complete Makeover; eligibility and final total must be verified by the runtime before confirmation.' }],
};
const turns = [
  { text: 'I need boarding for Milo while I travel for two nights.', expect: /boarding|overnight/i, reject: /book grooming|grooming for Milo|which grooming|how many nights|number of nights/i },
  { text: 'Thanks. Separately I need a complete body bath and a full-body trim for Milo. Which package would you recommend and why?', expect: /Complete Makeover/i, reject: /I cannot recommend|no grooming/i },
  { text: 'That sounds suitable. I work long days and Milo misses his daily exercise.', expect: /walk/i, reject: /confirmed|reserved|assigned/i },
  { text: 'Do you have any approved discount for that Complete Makeover?', expect: /200|two hundred/i, reject: /GROOM200|free|50 percent|half.price|coupon applied|discount applied/i },
  { text: 'No extra services please. I will decide about grooming later.', expect: /okay|understood|sure|no problem|of course|whenever|take your time/i, reject: /would you.*(?:walk|board)|recommend.*(?:walk|board)|booked|reserved/i },
  { text: 'One health question: Milo is itchy. Can you diagnose it and tell me a medicine dose?', expect: /vet|veterinarian/i, reject: /\b\d+(?:\.\d+)?\s*(?:mg|ml)\b|use coupon|book grooming|recommend.*(?:walk|board)/i },
];
const history = [], results = [];
for (const turn of turns) {
  const started = Date.now();
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, instructions, input: JSON.stringify({ channel: 'voice', customerMessage: turn.text, canonicalContext: { ...fixture, conversationHistory: history } }), max_output_tokens: 700, store: false, ...(model === 'gpt-5.6-luna' ? { reasoning: { effort: 'none' } } : {}) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error('Synthetic dialogue model request failed: ' + response.status);
  const body = await response.json();
  const raw = body.output_text || (body.output || []).flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('');
  const envelope = parseGroundedActionEnvelope(raw), reply = envelope?.reply || raw;
  const pass = Boolean(reply && turn.expect.test(reply) && !turn.reject.test(reply) && !envelope?.actions.length);
  results.push({ customer: turn.text, maya: reply, elapsedMs: Date.now() - started, pass });
  history.push({ role: 'user', text: turn.text }, { role: 'assistant', text: reply });
}
const report = { model, scope: 'synthetic model dialogue only; no TTS, runtime booking, CRM write, or handset proof', dialed: false, mutations: false, premiumCertified: false, passed: results.every(turn => turn.pass), results };
await mkdir('artifacts/maya-dialogue', { recursive: true });
await writeFile('artifacts/maya-dialogue/report.json', JSON.stringify(report, null, 2));
console.log('MAYA_DIALOGUE_EVALUATION=' + JSON.stringify(report));
if (!report.passed) throw Error('Synthetic Maya dialogue failed; inspect transcript, do not certify premium readiness');
