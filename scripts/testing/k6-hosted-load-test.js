import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = String(__ENV.BASE_URL || "").replace(/\/$/, "");
const BOOKING_PATH = __ENV.BOOKING_PATH || "/api/bookings";
const RUN_ID = __ENV.RUN_ID || `k6-${Date.now()}`;
const MAX_VUS = Number(__ENV.MAX_VUS || 2000);
const HEALTH_WEIGHT = Math.max(1, Number(__ENV.HEALTH_WEIGHT || 4));
const BOOKING_WEIGHT = Math.max(1, Number(__ENV.BOOKING_WEIGHT || 1));
const rawTemplate = __ENV.BOOKING_PAYLOAD_TEMPLATE || "";

const bookingFailures = new Rate("booking_failures");
const healthFailures = new Rate("health_failures");
const bookingLatency = new Trend("booking_latency", true);

export const options = {
  scenarios: {
    hosted_2000_concurrent_users: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: Math.min(250, MAX_VUS) },
        { duration: "3m", target: Math.min(1000, MAX_VUS) },
        { duration: "4m", target: MAX_VUS },
        { duration: "5m", target: MAX_VUS },
        { duration: "2m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000", "p(99)<2500"],
    health_failures: ["rate<0.005"],
    booking_failures: ["rate<0.01"],
    booking_latency: ["p(95)<1500", "p(99)<3000"],
  },
  discardResponseBodies: false,
};

function substitute(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{(RUN_ID|VU|ITER|SEQ)\}\}/g, (_, key) => String(vars[key]));
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, vars)]));
  }
  return value;
}

function headers() {
  const out = { "content-type": "application/json", "x-load-test-run": RUN_ID };
  if (__ENV.BOOKING_BEARER_TOKEN) out.authorization = `Bearer ${__ENV.BOOKING_BEARER_TOKEN}`;
  if (__ENV.BOOKING_COOKIE) out.cookie = __ENV.BOOKING_COOKIE;
  if (__ENV.ORIGIN) out.origin = __ENV.ORIGIN;
  return out;
}

export function setup() {
  if (!BASE_URL) fail("BASE_URL is required; never run a 2,000-user load test against an implicit target");
  if (!/^https:\/\//i.test(BASE_URL) && __ENV.ALLOW_HTTP !== "true") fail("BASE_URL must be HTTPS unless ALLOW_HTTP=true");
  if (!rawTemplate) fail("BOOKING_PAYLOAD_TEMPLATE is required so the booking write uses an explicit UAT fixture");
  try { JSON.parse(rawTemplate); } catch { fail("BOOKING_PAYLOAD_TEMPLATE must be valid JSON"); }
  const health = http.get(`${BASE_URL}/healthz`, { tags: { endpoint: "healthz", phase: "setup" } });
  if (health.status !== 200) fail(`healthz preflight failed with HTTP ${health.status}`);
  return { template: JSON.parse(rawTemplate) };
}

export default function hostedLoadScenario(data) {
  const sequence = (__VU * 10_000_000) + __ITER;
  for (let i = 0; i < HEALTH_WEIGHT; i += 1) {
    const res = http.get(`${BASE_URL}/healthz`, { tags: { endpoint: "healthz" } });
    const ok = check(res, { "healthz returns 200": (r) => r.status === 200 });
    healthFailures.add(!ok);
  }

  for (let i = 0; i < BOOKING_WEIGHT; i += 1) {
    const payload = substitute(data.template, { RUN_ID, VU: __VU, ITER: __ITER, SEQ: `${sequence}-${i}` });
    if (!payload.idempotencyKey) payload.idempotencyKey = `${RUN_ID}-${__VU}-${__ITER}-${i}`;
    const res = http.post(`${BASE_URL}${BOOKING_PATH}`, JSON.stringify(payload), {
      headers: headers(),
      tags: { endpoint: "booking_create" },
      timeout: __ENV.REQUEST_TIMEOUT || "15s",
    });
    bookingLatency.add(res.timings.duration);
    const ok = check(res, {
      "booking is accepted": (r) => r.status >= 200 && r.status < 300,
      "booking response is JSON": (r) => String(r.headers["Content-Type"] || "").includes("application/json"),
    });
    bookingFailures.add(!ok);
  }
  sleep(Number(__ENV.ITERATION_SLEEP_SECONDS || 0.25));
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({ runId: RUN_ID, baseUrl: BASE_URL, bookingPath: BOOKING_PATH, maxVUs: MAX_VUS, metrics: data.metrics }, null, 2),
    [__ENV.SUMMARY_FILE || "k6-hosted-load-summary.json"]: JSON.stringify({ runId: RUN_ID, baseUrl: BASE_URL, bookingPath: BOOKING_PATH, maxVUs: MAX_VUS, generatedAt: new Date().toISOString(), metrics: data.metrics }, null, 2),
  };
}
