// Publish the user-approved Maya pack through the existing authenticated configuration lifecycle.
// This action is staging-only; it does not change rollout, customers, bookings, offers or calling.
import {pathToFileURL} from 'node:url';

const origin = 'https://pawspace-staging.karthik-fce.workers.dev';
export const requiredPetCareSources = [
  'maya_pet_health_questions', 'maya_pet_hygiene_questions',
  'maya_vet_service_handoff', 'maya_pet_health_online_sources',
];

export async function activateMayaKnowledgeStaging(env = process.env, request = fetch) {
  if (env.CONFIRM !== 'activate-approved-maya-staging' || !/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA || '')) {
    throw Error('Explicit staging activation and certified revision are required');
  }
  for (const key of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'STAGING_D1_ID', 'PAWSPACE_UAT_ACCESS_CODE']) {
    if (!String(env[key] || '').trim()) throw Error('Staging activation credentials are incomplete');
  }
  const dbUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.STAGING_D1_ID)}`;
  const cloudHeaders = {authorization: 'Bearer ' + env.CLOUDFLARE_API_TOKEN, 'content-type': 'application/json'};
  async function cloud(url, init = {}) {
    const response = await request(url, {...init, headers: cloudHeaders, redirect: 'error', signal: AbortSignal.timeout(30000)});
    const body = await response.json();
    if (!response.ok || body.success !== true) throw Error('Isolated staging knowledge evidence unavailable');
    return body.result;
  }
  const metadata = await cloud(dbUrl);
  if (metadata?.name !== 'pawspace-staging') throw Error('Refusing activation outside the isolated staging database');

  const login = await request(origin + '/api/staging-login', {
    method: 'POST', headers: {origin, 'content-type': 'application/json'},
    body: JSON.stringify({email: 'founder@pawspace.in', code: env.PAWSPACE_UAT_ACCESS_CODE}),
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  const cookie = String(login.headers.get('set-cookie') || '').split(';', 1)[0];
  if (!login.ok || !cookie.startsWith('pawspace_uat=')) throw Error('Authenticated staging staff session required');
  const bootstrap = await request(origin + '/api/ai-bootstrap', {
    method: 'POST', headers: {cookie, origin, 'content-type': 'application/json'},
    // Approval attribution stays with the authenticated actor; never invent a checker identity.
    body: JSON.stringify({pack: 'maya'}), redirect: 'error', signal: AbortSignal.timeout(120000),
  });
  const body = await bootstrap.json();
  const counts = body.data?.serviceKnowledge;
  if (!bootstrap.ok || !counts || ![counts.activated, counts.unchanged, counts.total].every(Number.isInteger)
      || counts.activated < 0 || counts.unchanged < 0 || counts.total < requiredPetCareSources.length
      || counts.activated + counts.unchanged !== counts.total) throw Error('Maya knowledge activation did not complete');
  const result = await cloud(dbUrl + '/query', {
    method: 'POST', body: JSON.stringify({
      sql: `SELECT source_key,title,version,immutable_hash FROM ai_knowledge_source_versions WHERE status='active' AND source_key IN (${requiredPetCareSources.map(() => '?').join(',')})`,
      params: requiredPetCareSources,
    }),
  });
  if (!Array.isArray(result) || result.some(row => row.success === false)) throw Error('Active knowledge readback failed');
  const rows = result.flatMap(row => row.results || []);
  for (const key of requiredPetCareSources) {
    const matches = rows.filter(row => row.source_key === key);
    if (matches.length !== 1 || !String(matches[0].title || '').trim() || !Number.isInteger(matches[0].version)
        || matches[0].version < 1 || !/^[a-f0-9]{64}$/i.test(matches[0].immutable_hash || '')) {
      throw Error('Required pet-care knowledge is not uniquely active');
    }
  }
  return {revision: env.EXPECTED_SHA, ...counts, petCareSourcesVerified: rows.length,
    staffLifecycle: true, rolloutChanged: false, dialed: false, productionActivated: false};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  activateMayaKnowledgeStaging().then(result => console.log('MAYA_KNOWLEDGE_ACTIVATION=' + JSON.stringify(result)))
    .catch(error => {console.error(error.message); process.exitCode = 1;});
}
