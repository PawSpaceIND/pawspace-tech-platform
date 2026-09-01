const base = String(process.env.STAGING_URL || '').replace(/\/$/, '');
const code = String(process.env.PAWSPACE_UAT_ACCESS_CODE || '');
if (!base || !code) throw new Error('STAGING_URL and PAWSPACE_UAT_ACCESS_CODE are required');

const personas = [
  ['founder@pawspace.in', 'founder'],
  ['anjali.finance33@tkpetcare.in', 'finance'],
  ['jyoti.manager39@tkpetcare.in', 'manager'],
  ['asha.groomer1@tkpetcare.in', 'service_provider'],
  ['anita.associate17@tkpetcare.in', 'associate'],
];

for (const [email, expectedRole] of personas) {
  const login = await fetch(`${base}/api/staging-login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({action: 'login', code, email}),
  });
  const body = await login.json().catch(() => ({}));
  if (!login.ok) throw new Error(`${email} login failed: HTTP ${login.status} ${body?.error || ''}`.trim());
  const setCookie = login.headers.get('set-cookie') || '';
  const match = setCookie.match(/(?:^|,\s*)pawspace_uat=([^;]+)/i);
  if (!match?.[1]) throw new Error(`${email} login succeeded without pawspace_uat session cookie`);

  const session = await fetch(`${base}/api/staging-login`, {
    headers: {cookie: `pawspace_uat=${match[1]}`},
  });
  const sessionBody = await session.json().catch(() => ({}));
  if (!session.ok) throw new Error(`${email} session verification failed: HTTP ${session.status}`);
  const signedIn = sessionBody?.signedInAs;
  if (signedIn?.email !== email || signedIn?.role !== expectedRole) {
    throw new Error(`${email} session role mismatch: expected ${expectedRole}, got ${signedIn?.role || 'none'}`);
  }
  console.log(JSON.stringify({email, role: expectedRole, sessionCookieIssued: true, sessionVerified: true}));
}
