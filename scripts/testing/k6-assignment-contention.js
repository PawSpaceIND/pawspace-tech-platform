import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';
import { check, fail } from 'k6';

const BASE_URL = (__ENV.BASE_URL || 'https://staging.pawspace.in').replace(/\/$/, '');
const CUSTOMER_ID = __ENV.CUSTOMER_ID;
const PET_ID = __ENV.PET_ID;
const PROVIDER_ID = __ENV.PROVIDER_ID;
const CITY_ID = __ENV.CITY_ID || 'blr';
const ZONE_ID = __ENV.ZONE_ID || 'blr-south';
const SERVICE_CODE = __ENV.SERVICE_CODE || 'grooming';
const SCHEDULED_START = __ENV.SCHEDULED_START;
const SCHEDULED_END = __ENV.SCHEDULED_END;
const SERVICE_ADDRESS = __ENV.SERVICE_ADDRESS;
const SERVICE_PINCODE = __ENV.SERVICE_PINCODE;
const AUTH_HEADER = __ENV.AUTH_HEADER || 'oai-authenticated-user-email';
const AUTH_VALUE = __ENV.AUTH_VALUE || '';
const EXPECTED_CAPACITY = Number(__ENV.EXPECTED_CAPACITY || '1');
const VUS = Number(__ENV.VUS || '2000');

const targetAssignments = new Counter('target_provider_assignments');
const contentionResponses = new Counter('contention_responses');
const unexpectedResponses = new Counter('unexpected_responses');
const schedulingLatency = new Trend('scheduling_contention_latency', true);
const requestSuccess = new Rate('scheduling_request_success');

export const options = {
  scenarios: {
    assignment_contention: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '90s',
      gracefulStop: '0s',
    },
  },
  thresholds: {
    // This is the core double-booking proof. For a capacity-1 appointment window,
    // at most one of the 2,000 contenders may obtain the chosen provider.
    target_provider_assignments: [`count<=${EXPECTED_CAPACITY}`],
    unexpected_responses: ['count==0'],
    http_req_failed: ['rate<0.05'],
    scheduling_contention_latency: ['p(95)<5000'],
  },
};

function required(name, value) {
  if (!value) fail(`Missing required environment variable: ${name}`);
  return value;
}

function headers() {
  const out = { 'content-type': 'application/json' };
  if (AUTH_VALUE) out[AUTH_HEADER] = AUTH_VALUE;
  if (__ENV.AUTHORIZATION) out.Authorization = __ENV.AUTHORIZATION;
  if (__ENV.COOKIE) out.Cookie = __ENV.COOKIE;
  return out;
}

function payload() {
  const unique = `${Date.now()}-${__VU}-${__ITER}`;
  return {
    action: 'reserve',
    assignmentStrategy: 'auto',
    clientRequestId: `k6-contention-${unique}`,
    customerId: required('CUSTOMER_ID', CUSTOMER_ID),
    petIds: [required('PET_ID', PET_ID)],
    serviceCode: SERVICE_CODE,
    cityId: CITY_ID,
    zoneId: ZONE_ID,
    serviceAddress: required('SERVICE_ADDRESS', SERVICE_ADDRESS),
    servicePincode: required('SERVICE_PINCODE', SERVICE_PINCODE),
    scheduledStart: required('SCHEDULED_START', SCHEDULED_START),
    scheduledEnd: required('SCHEDULED_END', SCHEDULED_END),
    preferredProviderId: required('PROVIDER_ID', PROVIDER_ID),
  };
}

function isExpectedContention(body, status) {
  if (status === 409) {
    const code = String(body?.error || body?.code || '');
    return [
      'SLOT_TAKEN',
      'SCHEDULING_CONFLICT',
      'NO_SCHEDULE_AVAILABLE',
      'SELECTED_PROVIDER_UNAVAILABLE',
      'SELECTED_SITTER_UNAVAILABLE',
    ].includes(code);
  }
  // D1 busy after bounded retries is an operational-pressure signal, not a
  // double-booking. It remains visible through http_req_failed/latency thresholds.
  return status === 503 && String(body?.error || '') === 'SCHEDULING_BUSY';
}

export default function () {
  const started = Date.now();
  const response = http.post(`${BASE_URL}/api/uat-scheduling`, JSON.stringify(payload()), {
    headers: headers(),
    tags: { test: 'assignment-contention', service: SERVICE_CODE },
    timeout: '30s',
  });
  schedulingLatency.add(Date.now() - started);

  let body = {};
  try { body = response.json(); } catch (_) { body = {}; }

  const assignedProvider = String(body?.data?.provider?.id || '');
  if (response.status === 200 && assignedProvider === PROVIDER_ID) {
    targetAssignments.add(1);
    requestSuccess.add(true);
  } else if (isExpectedContention(body, response.status)) {
    contentionResponses.add(1);
    requestSuccess.add(false);
  } else {
    unexpectedResponses.add(1);
    requestSuccess.add(false);
  }

  check(response, {
    'no server-side 5xx except bounded busy': (r) => r.status < 500 || (r.status === 503 && String(body?.error || '') === 'SCHEDULING_BUSY'),
    'assigned response names the targeted provider': (r) => r.status !== 200 || assignedProvider === PROVIDER_ID,
  });
}

export function teardown() {
  // Post-load API proof: the day board must show no more active overlapping
  // reservations on the target provider than the governed capacity allows.
  const day = required('SCHEDULED_START', SCHEDULED_START).slice(0, 10);
  const response = http.get(`${BASE_URL}/api/uat-scheduling?date=${encodeURIComponent(day)}`, {
    headers: headers(),
    tags: { test: 'assignment-contention-postcheck' },
  });
  if (response.status !== 200) fail(`Post-load scheduling board verification failed: HTTP ${response.status}`);

  const board = response.json('data');
  const provider = (board?.providers || []).find((item) => String(item.providerId) === PROVIDER_ID);
  const start = Date.parse(SCHEDULED_START);
  const end = Date.parse(SCHEDULED_END);
  const activeOverlaps = (provider?.reservations || []).filter((reservation) => {
    if (String(reservation.status) === 'cancelled') return false;
    return Date.parse(reservation.scheduledStart) < end && Date.parse(reservation.scheduledEnd) > start;
  });
  if (activeOverlaps.length > EXPECTED_CAPACITY) {
    fail(`DOUBLE BOOKING: ${activeOverlaps.length} active overlaps on ${PROVIDER_ID}; capacity=${EXPECTED_CAPACITY}`);
  }
}
