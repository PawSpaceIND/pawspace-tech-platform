import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './src/app.js';
import { issueSession } from './src/auth.js';
import { deriveFinanceUatSessionSecret, financeUatConfigurationBlockers, financeUatDeploymentMatches, financeUatEnabled, verifyFinanceUatProof } from './src/finance-uat-auth.js';
import { createRepository } from './src/repository.js';

const financeUatDeployment = financeUatDeploymentMatches();
const financeUatBlockers = financeUatDeployment ? financeUatConfigurationBlockers() : [];
const financeUat = financeUatEnabled();
if (financeUatDeployment) {
  process.env.AUTH_MODE = 'token';
  if (financeUat && (!process.env.API_SECRET || process.env.API_SECRET.length < 32)) process.env.API_SECRET = deriveFinanceUatSessionSecret();
}

const app = buildApp(await createRepository());

app.post('/v1/auth/finance-uat-session', async (request, reply) => {
  if (!financeUatDeployment) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  if (financeUatBlockers.length) {
    return reply.header('cache-control', 'no-store').code(503).send({ error: { code: 'FINANCE_UAT_CONFIGURATION_REQUIRED', message: 'Finance UAT runtime configuration is incomplete', required: financeUatBlockers } });
  }
  const body = (request.body ?? {}) as Record<string, unknown>;
  const proof = { timestamp: Number(body.timestamp), nonce: String(body.nonce ?? ''), sha: String(body.sha ?? ''), signature: String(body.signature ?? '').toLowerCase() };
  if (!verifyFinanceUatProof(process.env, proof)) return reply.header('cache-control', 'no-store').code(401).send({ error: { code: 'INVALID_UAT_PROOF', message: 'Invalid Finance UAT proof' } });
  const session = issueSession({ id: 'finance_uat_certifier', role: 'super_admin', cityId: 'blr' }, 15 * 60);
  return reply.header('cache-control', 'no-store').code(201).send({ data: session, meta: { scope: 'finance_uat_preview', commitSha: proof.sha } });
});

await app.ready();

export default function handler(request: IncomingMessage, response: ServerResponse) {
  app.server.emit('request', request, response);
}
