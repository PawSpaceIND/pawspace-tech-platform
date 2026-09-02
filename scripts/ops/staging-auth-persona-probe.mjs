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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function loginPersona(email) {
  let last = null;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const response = await fetch(`${base}/api/staging-login`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({action: 'login', code, email}),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) return {response, body, attempt};
    last = {status: response.status, error: String(body?.error || '')};
    if (![403, 503].includes(response.status)) break;
    await sleep(1500);
  }
  throw new Error(`${email} login failed after bounded retries: HTTP ${last?.status ?? 'unknown'} ${last?.error || ''}`.trim());
}

async function verifySession(email, expectedRole, cookieValue) {
  let lastRole = 'none';
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await fetch(`${base}/api/staging-login`, {
      headers: {cookie: `pawspace_uat=${cookieValue}`},
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 503) { await sleep(1000); continue; }
      throw new Error(`${email} session verification failed: HTTP ${response.status}`);
    }
    const signedIn = body?.signedInAs;
    lastRole = signedIn?.role || 'none';
    if (signedIn?.email === email && signedIn?.role === expectedRole) return attempt;
    await sleep(1000);
  }
  throw new Error(`${email} session role mismatch after bounded retries: expected ${expectedRole}, got ${lastRole}`);
}

for (const [email, expectedRole] of personas) {
  const {response, attempt: loginAttempt} = await loginPersona(email);
  const setCookie = response.headers.get('set-cookie') || '';
  const match = setCookie.match(/(?:^|,\s*)pawspace_uat=([^;]+)/i);
  if (!match?.[1]) throw new Error(`${email} login succeeded without pawspace_uat session cookie`);
  const sessionAttempt = await verifySession(email, expectedRole, match[1]);
  console.log(JSON.stringify({email, role: expectedRole, sessionCookieIssued: true, sessionVerified: true, loginAttempt, sessionAttempt}));
}
