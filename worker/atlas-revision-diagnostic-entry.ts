/**
 * Fixture-isolation-only API entry for the temporary Atlas revision diagnostic.
 *
 * This is the SOURCE for the compiled artifact a publisher may upload to the existing staging Worker. The historical
 * artifact fc38f8546f78b2177826fdf4c6a8f681ae8842b3626341fea9f01221ddda27fe was compiled from an uncommitted working
 * tree, so no committed source corresponded to it. This file plus lib/staging-fixture-isolation.ts are now that source.
 * Build: node scripts/ops/atlas-session/build-diagnostic-bundle.mjs <out-dir>  (prints the artifact SHA-256).
 * It serves exactly one GET route, has no cron/queue/assets exports and admits no model request.
 */
import { installAtlasNativeBoundary, withAtlasNativeScope } from '../lib/atlas-native-boundary.mjs';
installAtlasNativeBoundary();
type RuntimeEnv = Record<string, unknown>;
function assertBindings(env: RuntimeEnv) {
 for (const [name, value] of Object.entries(env)) {
  if (name === 'DB') { if (!value || typeof value !== 'object' || !('prepare' in value) || 'fetch' in value) throw Error('Atlas D1 binding invalid'); continue; }
  if (name === 'PAWSPACE_VERSION_METADATA') { if (!value || typeof value !== 'object' || Object.values(value).some(v => typeof v !== 'string')) throw Error('Atlas metadata invalid'); continue; }
  if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw Error('Atlas alternate binding denied');
 }
}
const atlasRevisionDiagnosticEntry = { async fetch(request: Request, env: RuntimeEnv) {
 if (env.PAWSPACE_DEPLOYMENT_ENV !== 'staging' || env.PAWSPACE_PAYMENT_ENV !== 'sandbox' || env.PAWSPACE_ISOLATED_FINANCE_TEST !== 'true' || !String(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID ?? '').trim()) return new Response('Atlas job disabled', {status:503});
 const url = new URL(request.url);
 if (url.origin !== env.FINANCE_TEST_ORIGIN || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) return new Response('Atlas origin denied', {status:403});
 if (request.method !== 'GET' || url.pathname !== '/__staging/fixture-isolation') return new Response('Atlas diagnostic route denied', {status:403});
 return withAtlasNativeScope('atlas', async () => {
  assertBindings(env);
  const {env: actualEnv} = await import('cloudflare:workers');
  assertBindings(actualEnv as RuntimeEnv);
  const {handleStagingFixtureIsolation} = await import('../lib/staging-fixture-isolation');
  return await handleStagingFixtureIsolation(request, env.DB as D1Database, env) ?? new Response('Not found', {status:404});
 });
}};
export default atlasRevisionDiagnosticEntry;
