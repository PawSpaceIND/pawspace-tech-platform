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

app.get('/v1/finance-uat-checkout', async (request, reply) => {
  if (!financeUatDeployment || !financeUat) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  if (financeUatBlockers.length) return reply.code(503).send({ error: { code: 'FINANCE_UAT_CONFIGURATION_REQUIRED', message: 'Finance UAT runtime configuration is incomplete' } });
  const mode = String(process.env.RAZORPAY_MODE ?? '').trim().toLowerCase();
  const keyId = String(process.env.RAZORPAY_KEY_ID ?? '').trim();
  if (mode !== 'test' || !keyId.startsWith('rzp_test_')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  const query = (request.query ?? {}) as Record<string, unknown>;
  const orderId = String(query.orderId ?? '').trim();
  if (!/^order_[A-Za-z0-9]+$/.test(orderId)) return reply.code(400).send({ error: { code: 'INVALID_ORDER_ID', message: 'A Razorpay Test order id is required' } });
  const escapedKey = JSON.stringify(keyId);
  const escapedOrder = JSON.stringify(orderId);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PawSpace Finance UAT Checkout</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f7f7f5;margin:0;display:grid;place-items:center;min-height:100vh}.card{background:white;border:1px solid #ddd;border-radius:18px;padding:28px;max-width:460px;box-shadow:0 12px 36px #0001}.badge{font-size:12px;font-weight:700;letter-spacing:.08em;color:#555}.title{font-size:26px;margin:10px 0}.note{color:#555;line-height:1.5}.button{width:100%;border:0;border-radius:12px;background:#111;color:#fff;padding:14px 18px;font-size:16px;font-weight:700;cursor:pointer}.button:disabled{opacity:.55}.result{margin-top:16px;padding:12px;border-radius:10px;background:#f3f3f3;word-break:break-word}.warn{font-size:13px;color:#7a4b00;margin-top:14px}</style></head>
<body><main class="card"><div class="badge">PAWSPACE · FINANCE UAT · RAZORPAY TEST MODE</div><h1 class="title">Provider-backed payment certification</h1><p class="note">This checkout is isolated to the Finance preview and Razorpay Test Mode. Completing it creates no real charge. PawSpace will accept capture only from the genuine Razorpay webhook.</p><button class="button" id="pay">Open Razorpay Test Checkout</button><div class="result" id="result">Order: ${orderId}</div><p class="warn">Use Razorpay's Test Mode success flow. Do not enter real card or bank credentials.</p></main>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script><script>
const key=${escapedKey}; const orderId=${escapedOrder}; const button=document.getElementById('pay'); const result=document.getElementById('result');
button.addEventListener('click',()=>{button.disabled=true; const checkout=new Razorpay({key,order_id:orderId,name:'PawSpace',description:'Finance UAT provider-backed certification',handler:(response)=>{result.textContent='Payment submitted successfully. Payment ID: '+response.razorpay_payment_id+' — PawSpace is waiting for the genuine Razorpay webhook.';button.disabled=false;},modal:{ondismiss:()=>{button.disabled=false;}}}); checkout.on('payment.failed',(response)=>{result.textContent='Test payment failed: '+(response.error?.description||'unknown error');button.disabled=false;}); checkout.open();});
</script></body></html>`;
  return reply.header('cache-control', 'no-store').header('content-security-policy', "default-src 'none'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'unsafe-inline'; frame-src https://api.razorpay.com https://*.razorpay.com; connect-src https://api.razorpay.com https://*.razorpay.com; img-src data: https://*.razorpay.com; base-uri 'none'; form-action https://*.razorpay.com").type('text/html; charset=utf-8').send(html);
});

await app.ready();

export default function handler(request: IncomingMessage, response: ServerResponse) {
  app.server.emit('request', request, response);
}
