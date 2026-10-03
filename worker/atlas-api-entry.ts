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
// Temporary API-only mode of the EXISTING staging target: no assets, cron or other event exports.
export default { async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
 if (env.PAWSPACE_DEPLOYMENT_ENV !== 'staging' || env.PAWSPACE_PAYMENT_ENV !== 'sandbox' || env.PAWSPACE_ISOLATED_FINANCE_TEST !== 'true' || !String(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID ?? '').trim()) return new Response('Atlas job disabled', {status:503});
 const url = new URL(request.url);
 if (url.origin !== env.FINANCE_TEST_ORIGIN || (request.headers.has('origin') && request.headers.get('origin') !== url.origin)) return new Response('Atlas origin denied', {status:403});
 if (request.method !== 'POST' || url.pathname !== '/api/ai-web-chat') {
  const statusRead=url.pathname==='/api/ai-business-configuration'&&url.searchParams.getAll('mode').length===1&&url.searchParams.get('mode')==='atlas_text_admission_status'&&[...url.searchParams.keys()].every(key=>key==='mode');
  if(request.method==='GET'&&(url.pathname==='/healthz'||url.pathname==='/__staging/fixture-isolation'||statusRead)) return withAtlasNativeScope('atlas',async()=>{
   assertBindings(env);const {env:actualEnv}=await import('cloudflare:workers');assertBindings(actualEnv as RuntimeEnv);
   if(url.pathname==='/healthz'){const {GET}=await import('../app/healthz/route');return GET();}
   if(statusRead){const {GET}=await import('../app/api/ai-business-configuration/route');return GET(request);}
   const {handleStagingFixtureIsolation}=await import('../lib/staging-fixture-isolation');return await handleStagingFixtureIsolation(request,env.DB as D1Database,env)??new Response('Not found',{status:404});
  });
  return new Response('Atlas route denied', {status:403});
 }
 return withAtlasNativeScope('atlas', async () => {
  try {
   assertBindings(env);
   const {env: actualEnv} = await import('cloudflare:workers');
   assertBindings(actualEnv as RuntimeEnv); // Check ambient capabilities, not merely a sanitized argument.
   const {resolvePlatformSession} = await import('../lib/platform-session');
   const session = await resolvePlatformSession(env.DB as D1Database,request);
   if (!session || session.roleCode !== 'customer' || session.subjectType !== 'customer' || session.subjectId !== 'CUS0000') return new Response('Atlas customer session required',{status:403});
   const body = await request.clone().json() as Record<string,unknown>;
   const {isSalesInformationQuestion} = await import('../lib/ai-sales-information');
   if (Object.keys(body).some(key=>!['mode','message','idempotencyKey'].includes(key)) || body.mode !== 'authenticated' || typeof body.message !== 'string' || !isSalesInformationQuestion(body.message)) return new Response('Atlas information-only request required',{status:403});
   const {APPROVAL} = await import('../lib/atlas-text-test-admission');
   if (Date.now() >= APPROVAL.expiresAt) return Response.json({error:'approval_expired'},{status:403});
   const {requestForAuthorization} = await import('../lib/trusted-workspace-identity');
   const trusted = requestForAuthorization(request,env);
   const {authorizePlatformSessionRequest} = await import('../lib/session-api-gateway');
   const {authorizeApiRequest} = await import('../lib/api-gateway');
   const refusal = await authorizePlatformSessionRequest(trusted,env.DB as D1Database) ?? await authorizeApiRequest(trusted,env as never);
   if (refusal instanceof Response) return refusal;
   const {POST} = await import('../app/api/ai-web-chat/route');
   return POST(trusted);
  } catch { return new Response('Atlas qualification refused',{status:503}); }
 });
}};
