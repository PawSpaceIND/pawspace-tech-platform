// Deployment guard only: GET provider metadata; never dial, repair, import or change secrets.
import { pathToFileURL } from 'node:url';
import { readBoundedText } from '../lib/provider-response-bounds.ts';
import { handsetVerifierConfig } from './voice-handset-preflight.mjs';
import { indiaNumber, selectVoiceRepairConfig } from './repair-staging-voice-config.mjs';
const routingFields = ['ELEVENLABS_AGENT_PHONE_NUMBER_ID', 'EXOTEL_CALLER_ID', 'EXOTEL_VOICE_APP_ID'];
const text = value => typeof value === 'string' ? value.trim() : '';
export class StagingVoiceRoutingRefused extends Error {
  constructor(reason, fields = []) { super(`Staging voice routing refused: ${reason}${fields.length ? ' [' + fields.join(', ') + ']' : ''}`); this.name = 'StagingVoiceRoutingRefused'; }
}
export async function verifyStagingVoiceRouting(env, request = fetch) {
  if (env.PAWSPACE_DEPLOYMENT_ENV !== 'staging' || env.PAWSPACE_PAYMENT_ENV !== 'sandbox') throw new StagingVoiceRoutingRefused('isolated_staging_required');
  if (text(env.PAWSPACE_VOICE_RUNTIME).toLowerCase() !== 'elevenlabs') return { checked: false, reason: 'elevenlabs_not_selected', dialed: false, configurationChanged: false };
  const config = handsetVerifierConfig(env);
  const missing = routingFields.filter(field => !text(env[field]));
  if (missing.length) throw new StagingVoiceRoutingRefused('routing_settings_missing', missing);
  if (!/^phnum_[A-Za-z0-9]+$/.test(text(env.ELEVENLABS_AGENT_PHONE_NUMBER_ID)) || !/^\d+$/.test(text(env.EXOTEL_VOICE_APP_ID))) throw new StagingVoiceRoutingRefused('routing_identifiers_malformed');
  let caller;
  try { caller = indiaNumber(env.EXOTEL_CALLER_ID); } catch { throw new StagingVoiceRoutingRefused('caller_number_malformed'); }
  async function read(url, headers) {
    let response;
    try { response = await request(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
    catch { throw new StagingVoiceRoutingRefused('provider_read_failed'); }
    if (!response.ok) throw new StagingVoiceRoutingRefused(`provider_evidence_http_${response.status}`);
    try { return JSON.parse(await readBoundedText(response, 1048576)); }
    catch { throw new StagingVoiceRoutingRefused('provider_evidence_invalid_or_oversized'); }
  }
  const carrierHeaders = { authorization: 'Basic ' + Buffer.from(env.EXOTEL_API_KEY + ':' + env.EXOTEL_API_TOKEN).toString('base64') };
  const elevenHeaders = { 'xi-api-key': env.ELEVENLABS_API_KEY };
  const carrier = await read(`${config.carrierOrigin}/v2_beta/Accounts/${encodeURIComponent(config.accountId)}/IncomingPhoneNumbers`, carrierHeaders);
  const imported = await read(config.elevenOrigin + '/v1/convai/phone-numbers', elevenHeaders);
  const exophones = carrier?.incoming_phone_numbers;
  const imports = Array.isArray(imported) ? imported : imported?.phone_numbers;
  if (!Array.isArray(exophones) || !Array.isArray(imports)) throw new StagingVoiceRoutingRefused('provider_inventory_incomplete');
  let selected;
  try { selected = selectVoiceRepairConfig(exophones, imports); }
  catch { throw new StagingVoiceRoutingRefused('dedicated_route_missing_or_ambiguous'); }
  const actual = { ...env, EXOTEL_CALLER_ID: caller };
  const mismatched = routingFields.filter(field => text(actual[field]) !== selected[field]);
  if (mismatched.length) throw new StagingVoiceRoutingRefused('stale_routing_settings', mismatched);
  const detail = await read(config.elevenOrigin + '/v1/convai/phone-numbers/' + encodeURIComponent(selected.ELEVENLABS_AGENT_PHONE_NUMBER_ID), elevenHeaders);
  let detailCaller;
  try { detailCaller = indiaNumber(detail?.phone_number); } catch { throw new StagingVoiceRoutingRefused('import_identity_changed'); }
  if (detail?.provider !== 'exotel' || detail?.phone_number_id !== selected.ELEVENLABS_AGENT_PHONE_NUMBER_ID || detailCaller !== caller) throw new StagingVoiceRoutingRefused('import_identity_changed');
  return { checked: true, reason: 'existing_dedicated_staging_route_verified', dialed: false, configurationChanged: false, providerReadCount: 3 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyStagingVoiceRouting(process.env).then(result => console.log('STAGING_VOICE_ROUTING=' + JSON.stringify(result))).catch(error => {
    console.error(error instanceof StagingVoiceRoutingRefused ? error.message : 'Staging voice routing prerequisites refused');
    process.exitCode = 1;
  });
}
