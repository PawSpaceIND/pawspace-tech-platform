import { createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const BASE = String(process.env.STAGING_URL || '').replace(/\/$/, '');
const UAT_SIGNING_KEY = String(process.env.PAWSPACE_UAT_SIGNING_KEY || '');
const WEBHOOK_SECRET = String(process.env.RAZORPAY_WEBHOOK_SECRET_SANDBOX || '');
const RUN_ID = String(process.env.PERF_RUN_ID || `perf-${Date.now()}-${randomUUID().slice(0,8)}`);
const OUT = String(process.env.PERF_EVIDENCE_PATH || 'staging-performance.json');
const REQUEST_TIMEOUT_MS = Math.max(5000, Math.min(60000, Number(process.env.PERF_REQUEST_TIMEOUT_MS || 30000)));
if (process.env.PAWSPACE_PAYMENT_ENV !== 'sandbox' || process.env.FORBID_PRODUCTION !== 'true' || process.env.APP_ENV !== 'staging') throw new Error('Performance gate requires PAWSPACE_PAYMENT_ENV=sandbox, FORBID_PRODUCTION=true, APP_ENV=staging');
if (!BASE || UAT_SIGNING_KEY.length < 32 || !WEBHOOK_SECRET) throw new Error('STAGING_URL, PAWSPACE_UAT_SIGNING_KEY, and RAZORPAY_WEBHOOK_SECRET_SANDBOX are required');

const latencies = [];
const failures = [];
const timings = new Map();
const percentile = (xs, p) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*p)-1)];
};
function recordTiming(label, ms) {
  latencies.push(ms);
  const list = timings.get(label) || [];
  list.push(ms);
  timings.set(label, list);
}
async function measured(label, fn) {
  const start = performance.now();
  try {
    const value = await fn();
    recordTiming(label, performance.now() - start);
    return value;
  } catch (error) {
    const ms = performance.now() - start;
    recordTiming(label, ms);
    failures.push({ label, error: String(error?.message || error) });
    throw error;
  }
}
async function rawRequest(path, { method='GET', cookie='', body, headers={} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {'content-type':'application/json'}),
      origin: BASE,
      ...(cookie ? {cookie} : {}),
      ...headers,
    },
    ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload; try { payload = text ? JSON.parse(text) : {}; } catch { payload = {raw:text.slice(0,500)}; }
  return {response, payload, text};
}

async function rawRequestWithTransientRetry(path, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await rawRequest(path, options);
      if (![429,500,502,503,504].includes(result.response.status)) return result;
      lastError = new Error(`transient ${result.response.status} from ${path}`);
    } catch (error) {
      lastError = error;
      const transient = error?.name === 'TimeoutError' || /timeout|ECONNRESET|fetch failed/i.test(String(error?.message || error));
      if (!transient) throw error;
    }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
  }
  throw lastError || new Error(`Transient request retries exhausted for ${path}`);
}

async function request(path, options = {}) {
  const {response,payload,text} = await rawRequest(path, options);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${payload?.error || text.slice(0,200)}`);
  return {response, payload};
}

// Synthetic staging-only token lifetime exceeds the 90-minute workflow ceiling. Normal application sign-in
// behavior is unchanged because only this isolated load harness mints the token directly.
const uatPayload = Buffer.from(JSON.stringify({email:'founder@pawspace.in',exp:Date.now()+2*60*60*1000})).toString('base64url');
const uatSignature = createHmac('sha256', UAT_SIGNING_KEY).update(uatPayload).digest('base64url');
const cookie = `pawspace_uat=${encodeURIComponent(`${uatPayload}.${uatSignature}`)}`;

const GROOMING_DURATION_MS = 120 * 60 * 1000;
const SLOT_HOURS_UTC = [5, 9];
const ASSIGNMENT_CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.PERF_ASSIGNMENT_CONCURRENCY || 1)));
const WEBHOOK_REPLAY_CONCURRENCY = Math.max(1, Math.min(50, Number(process.env.PERF_WEBHOOK_REPLAY_CONCURRENCY || 10)));
const LEDGER_QUERY_CONCURRENCY = Math.max(1, Math.min(100, Number(process.env.PERF_LEDGER_QUERY_CONCURRENCY || 20)));
function dayAtOffset(dayOffset) {
  const d = new Date(Date.now() + dayOffset * 86400000);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function candidateWindows() {
  const candidates = [];
  for (let dayOffset=12; dayOffset<=179; dayOffset++) {
    const day = dayAtOffset(dayOffset);
    for (const hour of SLOT_HOURS_UTC) {
      const start = new Date(day); start.setUTCHours(hour, 0, 0, 0);
      const end = new Date(start.getTime() + GROOMING_DURATION_MS);
      candidates.push({start:start.toISOString(),end:end.toISOString(),slotHourUtc:hour,dayOffset});
    }
  }
  return candidates;
}
const candidates = candidateWindows();
let candidateCursor = 0;
let skippedCapacityCandidates = 0;

async function tryPrepareAssignment(window, candidateNumber) {
  const n = candidateNumber + 1;
  const groupId = `${RUN_ID}:grp:${String(n).padStart(3,'0')}`;
  const customerId = `${RUN_ID}:cust:${String(n).padStart(3,'0')}`;
  const petId = `${RUN_ID}:pet:${String(n).padStart(3,'0')}`;
  const schedulingBody = {
    clientRequestId:groupId, customerId, petIds:[petId], serviceCode:'grooming', cityId:'blr', zoneId:'blr-east',
    scheduledStart:window.start, scheduledEnd:window.end, occurrences:1, assignmentStrategy:'auto'
  };
  const startAt = performance.now();
  try {
    const {response,payload,text} = await rawRequestWithTransientRetry('/api/uat-scheduling', {method:'POST', cookie, body:schedulingBody});
    const elapsed = performance.now() - startAt;
    if (!response.ok) {
      const code = String(payload?.code || payload?.error || '');
      const expectedCapacityMiss = response.status === 409 && (code === 'SLOT_TAKEN' || code === 'NO_SCHEDULE_AVAILABLE');
      if (expectedCapacityMiss) {
        skippedCapacityCandidates += 1;
        return null;
      }
      recordTiming('assignment', elapsed);
      const error = new Error(`POST /api/uat-scheduling -> ${response.status}: ${payload?.error || text.slice(0,200)}`);
      failures.push({label:'assignment',error:error.message});
      throw error;
    }
    const data = payload?.data || {};
    if (!data.provider?.id) {
      recordTiming('assignment', elapsed);
      const error = new Error(`No provider returned for ${groupId}`);
      failures.push({label:'assignment',error:error.message});
      throw error;
    }
    recordTiming('assignment', elapsed);
    const provider = {id:String(data.provider.id), name:String(data.provider.name || data.provider.id), model:data.provider.model === 'commission' ? 'commission' : 'full_time'};
    return {
      groupId, customerId, petId, start:window.start, end:window.end, provider,
      candidateNumber:n, dayOffset:window.dayOffset, slotHourUtc:window.slotHourUtc,
      body:{
        idempotencyKey:`${RUN_ID}:booking:${String(n).padStart(3,'0')}`, scheduleGroupId:groupId,
        customer:{id:customerId,name:`Perf Customer ${n}`,primaryPhone:`+9198${String(10000000+n).slice(-8)}`,email:`${RUN_ID}-${n}@example.invalid`},
        pets:[{sourceId:petId,name:`Perf Pet ${n}`,species:'dog',breed:'UAT',vaccinationStatus:'verified'}],
        cityId:'blr',zoneId:'blr-east',serviceCode:'grooming',packageCode:'dog-bath',packageName:'Essential Bath',
        scheduledStart:window.start,scheduledEnd:window.end,provider,totalAmount:1349,amountDueNow:1349,
        payment:{method:'uat_sandbox',mode:'prepaid',status:'captured',detail:'Hosted performance gate; isolated staging only'},
        pricing:{discount:0}
      }
    };
  } catch (error) {
    if (failures.at(-1)?.error === String(error?.message || error)) throw error;
    const elapsed = performance.now() - startAt;
    recordTiming('assignment', elapsed);
    failures.push({label:'assignment',error:String(error?.message || error)});
    throw error;
  }
}

const prepared = [];
while (prepared.length < 100 && candidateCursor < candidates.length) {
  const remaining = 100 - prepared.length;
  const width = Math.min(ASSIGNMENT_CONCURRENCY, remaining, candidates.length - candidateCursor);
  const batch = Array.from({length:width}, (_,j) => {
    const index = candidateCursor + j;
    return tryPrepareAssignment(candidates[index], index);
  });
  candidateCursor += width;
  const results = await Promise.all(batch);
  prepared.push(...results.filter(Boolean));
}
if (prepared.length !== 100) throw new Error(`Authoritative scheduler produced ${prepared.length}/100 assignments after ${candidateCursor} unique candidates (${skippedCapacityCandidates} expected capacity misses)`);
console.log(JSON.stringify({runId:RUN_ID,assignmentDiscovery:{required:100,successful:prepared.length,candidatesAttempted:candidateCursor,expectedCapacityMisses:skippedCapacityCandidates,firstDayOffset:prepared[0]?.dayOffset,lastDayOffset:prepared.at(-1)?.dayOffset,slotHoursUtc:[...new Set(prepared.map(item=>item.slotHourUtc))]}},null,2));

const bookingResults = await Promise.all(prepared.map(item => measured('booking', async () => {
  const {payload} = await request('/api/canonical-bookings', {method:'POST',cookie,body:item.body});
  if (!payload?.data?.bookingId) throw new Error(`No bookingId for ${item.body.idempotencyKey}`);
  return {bookingId:String(payload.data.bookingId), item};
})));

const replayResults = await Promise.all(bookingResults.map(({item}) => measured('duplicate-payment-booking-replay', async () => {
  const {payload} = await request('/api/canonical-bookings', {method:'POST',cookie,body:item.body});
  if (payload?.data?.duplicatePrevented !== true) throw new Error(`Replay was not marked duplicatePrevented for ${item.body.idempotencyKey}`);
  return payload.data;
})));

const webhookBookingId = bookingResults[0]?.bookingId;
if (!webhookBookingId) throw new Error('Track 3 webhook seed requires at least one canonical booking');
const rawWebhook = JSON.stringify({event:'payment.captured',created_at:Math.floor(Date.now()/1000),payload:{payment:{entity:{id:`pay_${RUN_ID.replace(/[^A-Za-z0-9]/g,'').slice(-24)}`,order_id:`order_${RUN_ID.replace(/[^A-Za-z0-9]/g,'').slice(-20)}`,amount:134900,currency:'INR',notes:{booking_id:webhookBookingId}}}}});
const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawWebhook).digest('hex');
const eventId = `${RUN_ID}:evt:replay`;
const firstWebhook = await measured('webhook-first-delivery', async () => {
  const {payload} = await request('/api/razorpay-webhook', {method:'POST',body:rawWebhook,headers:{'x-razorpay-signature':signature,'x-razorpay-event-id':eventId}});
  if (payload?.duplicate === true) throw new Error('First webhook delivery was unexpectedly classified as duplicate');
  if (String(payload?.status || '') === 'exception') throw new Error(`First webhook delivery did not reconcile: ${payload?.reason || 'exception'}`);
  return payload;
});
if (!firstWebhook?.ok) throw new Error('First webhook delivery was not acknowledged');

const webhookResults = [];
for (let offset=0; offset<500; offset+=WEBHOOK_REPLAY_CONCURRENCY) {
  const chunk = await Promise.all(Array.from({length:Math.min(WEBHOOK_REPLAY_CONCURRENCY,500-offset)}, () => measured('webhook-replay', async () => {
    const {payload} = await request('/api/razorpay-webhook', {method:'POST',body:rawWebhook,headers:{'x-razorpay-signature':signature,'x-razorpay-event-id':eventId}});
    if (payload?.duplicate !== true) throw new Error('Webhook replay was not classified as duplicate');
    return payload;
  })));
  webhookResults.push(...chunk);
}

let ledgerOk = 0;
for (let offset=0; offset<10000; offset+=LEDGER_QUERY_CONCURRENCY) {
  const chunk = await Promise.all(Array.from({length:Math.min(LEDGER_QUERY_CONCURRENCY,10000-offset)}, () => measured('ledger-query', async () => {
    const {payload} = await request('/api/grooming-finance', {cookie});
    if (!payload || payload.source !== 'canonical Grooming booking/payment/invoice/reconciliation ledger') throw new Error('Unexpected grooming-finance payload');
    return true;
  })));
  ledgerOk += chunk.length;
}

const totalRequests = latencies.length;
const p95 = percentile(latencies,0.95);
const errorRate = totalRequests ? failures.length/totalRequests : 1;
const metric = Object.fromEntries([...timings.entries()].map(([name,xs]) => [name,{count:xs.length,p95Ms:Number(percentile(xs,0.95).toFixed(2)),maxMs:Number(Math.max(...xs).toFixed(2))}]));
const report = {
  runId:RUN_ID, stagingUrl:BASE,
  setup:{assignmentCandidatesAttempted:candidateCursor,expectedCapacityMisses:skippedCapacityCandidates,assignmentConcurrency:ASSIGNMENT_CONCURRENCY,webhookReplayConcurrency:WEBHOOK_REPLAY_CONCURRENCY,ledgerQueryConcurrency:LEDGER_QUERY_CONCURRENCY},
  counts:{assignments:prepared.length,bookings:bookingResults.length,duplicatePaymentAttempts:replayResults.length,webhookReplays:webhookResults.length,ledgerQueries:ledgerOk},
  metrics:{totalRequests,p95Ms:Number(p95.toFixed(2)),errorRate:Number(errorRate.toFixed(6)),byOperation:metric},
  thresholds:{p95Under750:p95<750,errorRateUnder1Percent:errorRate<0.01}, failures
};
await writeFile(OUT, JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if (prepared.length!==100 || bookingResults.length!==100 || replayResults.length!==100 || webhookResults.length!==500 || ledgerOk!==10000 || p95>=750 || errorRate>=0.01 || failures.length) process.exit(1);
