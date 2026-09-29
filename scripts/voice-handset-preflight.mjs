// Pure local validation. This module has no network, database or dial operation.
import { canonicalDialNumber, normalisedDialKey, voiceAllowlist } from '../lib/voice-call-gate.ts';
const text = value => typeof value === 'string' ? value.trim() : '';
const identifier = value => /^[A-Za-z0-9_-]{1,160}$/.test(text(value));
const credential = value => !!text(value) && !/[\r\n]/.test(value);
export function handsetVerifierConfig(env) {
 const host = text(env.EXOTEL_SUBDOMAIN) || 'api.exotel.com';
 const elevenOrigin = (text(env.ELEVENLABS_API_BASE) || 'https://api.in.residency.elevenlabs.io').replace(/\/$/, '');
 if ((host !== 'api.exotel.com' && host !== 'api.in.exotel.com') || !identifier(env.EXOTEL_SID)) throw Error('Approved carrier region/account required');
 if ((elevenOrigin !== 'https://api.elevenlabs.io' && elevenOrigin !== 'https://api.in.residency.elevenlabs.io')) throw Error('Approved ElevenLabs region required');
 if (![env.EXOTEL_API_KEY,env.EXOTEL_API_TOKEN,env.ELEVENLABS_API_KEY].every(credential)) throw Error('Read-only provider credentials missing or malformed');
 return { carrierOrigin:'https://'+host, elevenOrigin, accountId:text(env.EXOTEL_SID) };
}
export function singleHandsetTester(env) {
 // Use the app's separator and canonical number rules; formatting spaces are not delimiters.
 const entries = text(env.PAWSPACE_VOICE_UAT_ALLOWLIST).split(/[,;\n]+/).map(text).filter(Boolean);
 const allowed = voiceAllowlist(env);
 const phone = entries.length===1 ? canonicalDialNumber(env,entries[0]) : null;
 if (entries.length!==1 || allowed.length!==1 || !/^\+91[6-9]\d{9}$/.test(phone || '') || allowed[0]!==normalisedDialKey(phone)) throw Error('Exactly one canonical Indian mobile tester is required');
 return phone;
}
export function specialistDemoPreflight(env) {
 const config = handsetVerifierConfig(env);
 const useCase = text(env.SPECIALIST_USE_CASE);
 if (!['grooming_sales','training_sales'].includes(useCase)) throw Error('Specialist use case is required');
 const agentId = text(useCase==='grooming_sales' ? env.GROOMING_AGENT_ID : env.TRAINING_AGENT_ID);
 if (!identifier(agentId)) throw Error('Exact specialist agent ID required');
 const customerId = text(env.SPECIALIST_CUSTOMER_ID);
 if (!identifier(customerId)) throw Error('Exact existing canonical customer required; no hard-coded or inferred identity');
 if (!credential(env.PAWSPACE_UAT_ACCESS_CODE)) throw Error('Staging access prerequisite missing');
 const runId = text(env.GITHUB_RUN_ID);
 if (!/^[1-9]\d{0,24}$/.test(runId)) throw Error('Stable workflow run ID required before dialing');
 const phone = singleHandsetTester(env);
 return { ...config,useCase,agentId,customerId,phone,idempotencyKey:'voice-specialist-uat:'+useCase+':'+runId };
}
