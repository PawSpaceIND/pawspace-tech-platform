import { createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const BASE = String(process.env.STAGING_URL || '').replace(/\/$/, '');
const ACCESS = String(process.env.PAWSPACE_UAT_ACCESS_CODE || '');
const WEBHOOK_SECRET = String(process.env.RAZORPAY_WEBHOOK_SECRET_SANDBOX || '');
const RUN_ID = String(process.env.PERF_RUN_ID || `perf-${Date.now()}-${randomUUID().slice(0,8)}`);
const OUT = String(process.env.PERF_EVIDENCE_PATH || 'staging-performance.json');
if (!BASE || !ACCESS || !WEBHOOK_SECRET) throw new Error('STAGING_URL, PAWSPACE_UAT_ACCESS_CODE, and RAZORPAY_WEBHOOK_SECRET_SANDBOX are required');

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
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let payload; try { payload = text ? JSON.parse(text) : {}; } catch { payload = {raw:text.slice(0,500)}; }
  return {response, payload, text};
}
async function request(path, options = {}) {
  const {response,payload,text} = await rawRequest(path, options);
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} -> ${response.status}: ${payload?.error || text.slice(0,200)}`);
  return {response, payload};
}

const login = await request('/api/staging-login', {method:'POST', body:{action:'login', code:ACCESS, email:'founder@pawspace.in'}});
const setCookie = login.response.headers.get('set-cookie') || '';
const cookie = setCookie.split(';')[0];
if (!cookie) throw new Error('Founder staging login returned no session cookie');

// The scheduling GET day board is an operations view, not a capacity oracle: providers with no
// reservation rows are absent, and expired failed-load reservations can remain visible until a write
// path performs lease cleanup. Discover capacity through the authoritative scheduling POST instead.
// Every candidate is unique, remains inside the 180-day horizon, and the POST itself applies roster,
// provider eligibility, buffers, lease cleanup and atomic slot claiming.
const GROOMING_DURATION_MS = 120 * 60 * 1000;
const SLOT_HOURS_UTC = [5, 9];
const ASSIGNMENT_CONCURRENCY = 10;
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
    const {response,payload,text} = await rawRequest('/api/uat-scheduling', {method:'POST', cookie, body:schedulingBody});
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

// Provider assignment is a preparation dependency, not the 100-simultaneous-booking gate itself.
// Exercise successful assignments concurrently in bounded groups. Capacity misses are discovery setup
// and are not performance failures; every successful assignment is measured under the Track 3 gate.
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
console.log(JSON.stringify({
  runId:RUN_ID,
  assignmentDiscovery:{required:100,successful:prepared.length,candidatesAttempted:candidateCursor,expectedCapacityMisses:skippedCapacityCandidates,firstDayOffset:prepared[0]?.dayOffset,lastDayOffset:prepared.at(-1)?.dayOffset,slotHoursUtc:[...new Set(prepared.map(item=>item.slotHourUtc))]}
},null,2));

// Required gate: 100 simultaneous canonical bookings.
const bookingResults = await Promise.all(prepared.map(item => measured('booking', async () => {
  const {payload} = await request('/api/canonical-bookings', {method:'POST',cookie,body:item.body});
  if (!payload?.data?.bookingId) throw new Error(`No bookingId for ${item.body.idempotencyKey}`);
  return {bookingId:String(payload.data.bookingId), item};
})));

// Required gate: 100 simultaneous duplicate/idempotency payment attempts against the same bookings.
const replayResults = await Promise.all(bookingResults.map(({item}) => measured('duplicate-payment-booking-replay', async () => {
  const {payload} = await request('/api/canonical-bookings', {method:'POST',cookie,body:item.body});
  if (payload?.data?.duplicatePrevented !== true) throw new Error(`Replay was not marked duplicatePrevented for ${item.body.idempotencyKey}`);
  return payload.data;
})));

// Prime one real, fully processable Razorpay capture against the first canonical booking. The required
// 500 calls below are then genuine byte-identical replays of an already accepted event, not 500 retries
// of an intentionally unmatched/FAILED synthetic event.
const webhookBookingId = bookingResults[0]?.bookingId;
if (!webhookBookingId) throw new Error('Track 3 webhook seed requires at least one canonical booking');
const rawWebhook = JSON.stringify({
  event:'payment.captured', created_at:Math.floor(Date.now()/1000),
  payload:{payment:{entity:{id:`pay_${RUN_ID.replace(/[^A-Za-z0-9]/g,'').slice(-24)}`,order_id:`order_${RUN_ID.replace(/[^A-Za-z0-9]/g,'').slice(-20)}`,amount:134900,currency:'INR',notes:{booking_id:webhookBookingId}}}}
});
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
for (let offset=0; offset<500; offset+=50) {
  const chunk = await Promise.all(Array.from({length:Math.min(50,500-offset)}, () => measured('webhook-replay', async () => {
    const {payload} = await request('/api/razorpay-webhook', {method:'POST',body:rawWebhook,headers:{'x-razorpay-signature':signature,'x-razorpay-event-id':eventId}});
    if (payload?.duplicate !== true) throw new Error('Webhook replay was not classified as duplicate');
    return payload;
  })));
  webhookResults.push(...chunk);
}

let ledgerOk = 0;
for (let offset=0; offset<10000; offset+=100) {
  const chunk = await Promise.all(Array.from({length:100}, () => measured('ledger-query', async () => {
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
  setup:{assignmentCandidatesAttempted:candidateCursor,expectedCapacityMisses:skippedCapacityCandidates},
  counts:{assignments:prepared.length,bookings:bookingResults.length,duplicatePaymentAttempts:replayResults.length,webhookReplays:webhookResults.length,ledgerQueries:ledgerOk},
  metrics:{totalRequests,p95Ms:Number(p95.toFixed(2)),errorRate:Number(errorRate.toFixed(6)),byOperation:metric},
  thresholds:{p95Under750:p95<750,errorRateUnder1Percent:errorRate<0.01}, failures
};
await writeFile(OUT, JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if (prepared.length!==100 || bookingResults.length!==100 || replayResults.length!==100 || webhookResults.length!==500 || ledgerOk!==10000 || p95>=750 || errorRate>=0.01 || failures.length) process.exit(1);
