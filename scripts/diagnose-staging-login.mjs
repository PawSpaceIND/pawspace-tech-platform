// Temporary trace of a single synthetic request. Never prints request headers,
// bodies, OTPs, cookies, websocket URLs or provider credentials.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!/^[a-f0-9]{32}$/i.test(account || '') || !token) throw new Error('Cloudflare diagnostic credentials unavailable');
const origin = 'https://pawspace-staging.karthik-fce.workers.dev';
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/pawspace-staging/tails`;
const probe = crypto.randomUUID();
const clean = value => String(value || '').replaceAll(token, '[redacted]').replaceAll(account, '[account]').replace(/\b\d{10,}\b/g, '[number]').slice(0, 600);
async function api(url, method, body) {
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Trace API denied or unavailable (${response.status})`);
  const data = await response.json();
  if (!data.success) throw new Error('Trace API did not confirm success');
  return data.result;
}
let tail;
let socket;
try {
  tail = await api(base, 'POST', JSON.stringify({}));
  if (!tail?.id || !tail?.url) throw new Error('Trace session unavailable');
  socket = new WebSocket(tail.url, 'trace-v1');
  socket.addEventListener('message', async event => {
    try {
      const raw = typeof event.data === 'string' ? event.data : await event.data.text();
      const entry = JSON.parse(raw);
      if (!entry.event?.request?.url?.includes(probe)) return;
      console.log(JSON.stringify({ outcome: entry.outcome, exceptions: (entry.exceptions || []).map(error => ({ name: clean(error.name), message: clean(error.message) })) }));
    } catch { console.log('Trace message could not be decoded; raw data withheld'); }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Trace connection timed out')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timer); socket.send(JSON.stringify({ debug: false })); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Trace connection failed')); }, { once: true });
  });
  const response = await fetch(`${origin}/api/customer-otp?uat_diagnostic=${probe}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ action: 'request', phone: '9999999998' }), signal: AbortSignal.timeout(15000),
  });
  console.log(JSON.stringify({ syntheticRequestStatus: response.status, contentType: response.headers.get('content-type') }));
  await new Promise(resolve => setTimeout(resolve, 10000));
} finally {
  socket?.close();
  if (tail?.id) {
    await api(`${base}/${encodeURIComponent(tail.id)}`, 'DELETE');
    console.log('Temporary staging trace removed');
  }
}
// Node's WebSocket transport can keep its closing handle alive after the tail
// has been deleted. Exit only after the awaited cleanup above has succeeded.
process.exit(0);
