import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CANCELLABLE_STATUSES, CLEANUP_ACTION, CLEANUP_REASON, CleanupRefused, REPORT_ONLY_STATUSES, STAGING_HOST, STALE_AFTER_MS,
  assertStagingTarget, bookingIndex, classifySession, cleanupIdempotencyKey, redact, resolveRunMode, runCleanup,
  selectCandidates, selectStaleUnpaidBookings, trainerProviderIds, uatSessionCookie,
} from "../scripts/uat-staging-training-cleanup.mjs";

const STAGING = `https://${STAGING_HOST}`;
const NOW = Date.parse("2026-09-26T06:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const CODE = "access-code-canary-7731";
const TOKEN = "cookie-token-canary-5520";

test("the host guard accepts only the staging worker over https", () => {
  for (const ok of [STAGING, `${STAGING}/`, `${STAGING}/team/operations/training`, "https://PAWSPACE-STAGING.karthik-fce.workers.dev"]) {
    assert.equal(assertStagingTarget(ok), STAGING, ok);
  }
  for (const bad of [
    undefined, "", "not a url", `http://${STAGING_HOST}`, `${STAGING}:8443`, `https://user:pw@${STAGING_HOST}`,
    `https://${STAGING_HOST}.evil.example`, `https://evil.example/?next=${STAGING}`, `https://${STAGING_HOST}@evil.example`,
    "https://pawspace.in", "https://app.pawspace.in", "https://pawspace-production.karthik-fce.workers.dev", "https://karthik-fce.workers.dev",
  ]) {
    assert.throws(() => assertStagingTarget(bad), CleanupRefused, String(bad));
  }
});

test("the run is a dry run unless DRY_RUN is exactly \"false\"", () => {
  for (const value of [undefined, "", "true", "1", "0", "no", "False", "FALSE", " false", "false ", "dry-run", "apply"]) {
    assert.equal(resolveRunMode({ DRY_RUN: value }).dryRun, true, `DRY_RUN=${JSON.stringify(value)}`);
  }
  assert.equal(resolveRunMode({}).dryRun, true);
  assert.equal(resolveRunMode().dryRun, true);
  assert.equal(resolveRunMode({ DRY_RUN: "false" }).dryRun, false);
});

test("the idempotency key is deterministic and unique per session", () => {
  assert.equal(cleanupIdempotencyKey("TS-1"), cleanupIdempotencyKey("TS-1"));
  assert.notEqual(cleanupIdempotencyKey("TS-1"), cleanupIdempotencyKey("TS-2"));
  assert.match(cleanupIdempotencyKey("TS-1"), /:cancel_session:TS-1$/);
  assert.throws(() => cleanupIdempotencyKey(""));
});

test("only stale (>24h past) pre-start sessions are in scope, and only cancellable ones are acted on", () => {
  const at = (ms) => new Date(ms).toISOString();
  const stale = at(NOW - STALE_AFTER_MS - 60_000);
  for (const status of CANCELLABLE_STATUSES) assert.deepEqual(classifySession({ status, scheduled_start: stale }, { now: NOW }), { plan: CLEANUP_ACTION, note: "" }, status);
  for (const status of REPORT_ONLY_STATUSES) assert.equal(classifySession({ status, scheduled_start: stale }, { now: NOW }).plan, "none", status);
  for (const status of ["in_session", "completed", "no_show", "cancelled", ""]) assert.equal(classifySession({ status, scheduled_start: stale }, { now: NOW }), null, status);
  assert.equal(classifySession({ status: "scheduled", scheduled_start: at(NOW - STALE_AFTER_MS + 60_000) }, { now: NOW }), null, "within 24 hours");
  assert.equal(classifySession({ status: "scheduled", scheduled_start: at(NOW + DAY) }, { now: NOW }), null, "future");
  assert.equal(classifySession({ status: "scheduled", scheduled_start: "not a date" }, { now: NOW }), null, "unparseable start");
  for (const booking of ["cancelled", "refunded", "failed", "expired", "completed"]) {
    assert.equal(classifySession({ status: "scheduled", scheduled_start: stale }, { now: NOW, bookingStatus: booking }).plan, "none", booking);
  }
  assert.equal(classifySession({ status: "accepted", scheduled_start: stale }, { now: NOW, bookingStatus: "payment_pending" }).plan, CLEANUP_ACTION);
});

test("candidates are de-duplicated and ordered by booking then sequence", () => {
  const start = new Date(NOW - 5 * DAY).toISOString();
  const rows = selectCandidates([
    { id: "S2", booking_id: "B1", sequence_no: 2, status: "locked", scheduled_start: start },
    { id: "S9", booking_id: "B0", sequence_no: 1, status: "scheduled", scheduled_start: start },
    { id: "S1", booking_id: "B1", sequence_no: 1, status: "scheduled", scheduled_start: start },
    { id: "S1", booking_id: "B1", sequence_no: 1, status: "scheduled", scheduled_start: start },
  ], { now: NOW, bookings: bookingIndex([{ booking_id: "B1", booking_status: "confirmed", payment_status: "captured" }]) });
  assert.deepEqual(rows.map(row => row.sessionId), ["S9", "S1", "S2"]);
  assert.equal(rows[1].bookingStatus, "confirmed");
  assert.equal(rows[0].bookingStatus, "unknown");
});

test("unpaid Training bookings older than 7 days are reported, newer ones are not", () => {
  const unpaid = selectStaleUnpaidBookings([
    { id: "P1", booking_id: "B1", booking_status: "payment_pending", created_at: NOW - 8 * DAY },
    { id: "P2", booking_id: "B2", booking_status: "payment_pending", created_at: NOW - 6 * DAY },
    { id: "P3", booking_id: "B3", booking_status: "confirmed", created_at: NOW - 30 * DAY },
  ], { now: NOW });
  assert.deepEqual(unpaid.map(row => row.bookingId), ["B1"]);
});

test("trainer discovery always includes the seeded UAT trainers plus the ops roster and session owners", () => {
  const ids = trainerProviderIds({ trainers: [{ id: "train_demo" }], programmes: [{ sessions: [{ provider_id: "train_other" }] }] });
  for (const id of ["uatcap_train_ft", "train_demo", "train_other"]) assert.ok(ids.includes(id), id);
});

test("cookie extraction and redaction never keep a secret", () => {
  const headers = new Headers();
  headers.append("set-cookie", `pawspace_uat=${TOKEN}; Path=/; HttpOnly; Secure`);
  assert.equal(uatSessionCookie(headers), `pawspace_uat=${TOKEN}`);
  assert.equal(uatSessionCookie(new Headers()), "");
  assert.equal(redact(`code ${CODE} cookie ${TOKEN}`, [CODE, TOKEN]), "code [redacted] cookie [redacted]");
});

/** In-memory stand-in for the staging worker: staff login, ops read, per-trainer listing and cancel_session. */
function fakeStaging() {
  const at = (days) => new Date(NOW - days * DAY).toISOString();
  const sessions = [
    { id: "S1", programme_id: "P1", booking_id: "B1", sequence_no: 1, provider_id: "uatcap_train_ft", scheduled_start: at(11), status: "scheduled" },
    { id: "S2", programme_id: "P1", booking_id: "B1", sequence_no: 2, provider_id: "uatcap_train_ft", scheduled_start: at(8), status: "locked" },
    { id: "S3", programme_id: "P1", booking_id: "B1", sequence_no: 3, provider_id: "uatcap_train_ft", scheduled_start: at(-6), status: "locked" },
    { id: "S4", programme_id: "P2", booking_id: "B2", sequence_no: 1, provider_id: "uatcap_train_ft", scheduled_start: at(6), status: "accepted" },
    { id: "S5", programme_id: "P3", booking_id: "B3", sequence_no: 1, provider_id: "uatcap_train_ft", scheduled_start: at(5), status: "on_the_way" },
    { id: "S6", programme_id: "P4", booking_id: "B4", sequence_no: 1, provider_id: "uatcap_train_ft", scheduled_start: at(16), status: "scheduled" },
    { id: "S7", programme_id: "P5", booking_id: "B5", sequence_no: 1, provider_id: "uatcap_train_ft", scheduled_start: at(0.75), status: "scheduled" },
    { id: "S8", programme_id: "P6", booking_id: "B6", sequence_no: 1, provider_id: "uatcap_train_ft", scheduled_start: at(25), status: "completed" },
    { id: "S9", programme_id: "P7", booking_id: "B7", sequence_no: 1, provider_id: "uatcap_train_ft", scheduled_start: at(24), status: "in_session" },
    { id: "S10", programme_id: "P8", booking_id: "B8", sequence_no: 1, provider_id: "train_demo", scheduled_start: at(14), status: "reschedule_requested" },
  ];
  const programmes = [
    ["P1", "B1", "confirmed", "captured", 20], ["P2", "B2", "payment_pending", "created", 3], ["P3", "B3", "confirmed", "captured", 9],
    ["P4", "B4", "cancelled", "refunded", 30], ["P5", "B5", "confirmed", "captured", 2], ["P6", "B6", "completed", "captured", 40],
    ["P7", "B7", "confirmed", "captured", 40], ["P8", "B8", "payment_pending", "created", 10],
  ].map(([id, booking_id, booking_status, payment_status, ageDays]) => ({ id, booking_id, booking_status, payment_status, created_at: NOW - ageDays * DAY }));
  const calls = [];
  const keys = new Map();
  const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  async function fetcher(href, init = {}) {
    const url = new URL(href);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ origin: url.origin, method, path: url.pathname, query: url.search, headers: init.headers, body });
    const signedIn = init.headers?.cookie === `pawspace_uat=${TOKEN}`;
    if (url.pathname === "/api/staging-login" && method === "POST") return body?.code === CODE && body?.email === "founder@pawspace.in" ? reply({ ok: true }, 200, { "set-cookie": `pawspace_uat=${TOKEN}; Path=/; HttpOnly; Secure` }) : reply({ error: "Invalid access code" }, 401);
    if (url.pathname === "/api/staging-login") return reply({ enabled: true, signedInAs: signedIn ? { email: "founder@pawspace.in", role: "founder" } : null });
    if (!signedIn) return reply({ error: "Authentication required" }, 401);
    if (url.pathname === "/api/training-ops") return reply({ data: { programmes: programmes.map(p => ({ ...p, sessions: sessions.filter(s => s.programme_id === p.id).map(s => ({ ...s })) })), trainers: [{ id: "uatcap_train_ft" }] } });
    if (url.pathname === "/api/training-sessions" && method === "GET") return reply({ data: sessions.filter(s => s.provider_id === url.searchParams.get("providerId")).map(s => ({ ...s })) });
    if (url.pathname === "/api/training-sessions" && method === "POST") {
      if (keys.has(body.idempotencyKey)) return reply({ data: { duplicatePrevented: true, sessionId: body.sessionId, eventType: body.action } });
      const session = sessions.find(s => s.id === body.sessionId);
      if (!["scheduled", "accepted", "reschedule_requested", "locked"].includes(session.status)) return reply({ error: "Training session cannot cancel_session", code: "training_session_state_conflict" }, 409);
      session.status = "cancelled";
      keys.set(body.idempotencyKey, session.id);
      const next = sessions.find(s => s.programme_id === session.programme_id && s.sequence_no === session.sequence_no + 1 && s.status === "locked");
      if (next) next.status = "scheduled";
      return reply({ data: { duplicatePrevented: false, status: "cancelled", caseId: `TSR-${session.id}`, nextSession: next ? { sessionId: next.id, sequenceNo: next.sequence_no, status: "scheduled" } : null } });
    }
    return reply({ error: "not found" }, 404);
  }
  return { fetcher, calls, sessions, keys };
}

test("a non-staging BASE_URL is refused before any network request", async () => {
  const staging = fakeStaging();
  for (const BASE_URL of ["https://app.pawspace.in", `http://${STAGING_HOST}`, undefined]) {
    await assert.rejects(runCleanup({ env: { BASE_URL, PAWSPACE_UAT_ACCESS_CODE: CODE, DRY_RUN: "false" }, fetcher: staging.fetcher, log: () => {}, now: NOW }), CleanupRefused);
  }
  await assert.rejects(runCleanup({ env: { BASE_URL: STAGING, DRY_RUN: "false" }, fetcher: staging.fetcher, log: () => {}, now: NOW }), /PAWSPACE_UAT_ACCESS_CODE/);
  assert.equal(staging.calls.length, 0);
});

test("the default dry run only reads, lists the plan and never prints the code or cookie", async () => {
  const staging = fakeStaging();
  const logs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uat-cleanup-"));
  const reportPath = path.join(dir, "nested", "report.md");
  const report = await runCleanup({ env: { BASE_URL: `${STAGING}/`, PAWSPACE_UAT_ACCESS_CODE: CODE, CLEANUP_REPORT: reportPath }, fetcher: staging.fetcher, log: line => logs.push(line), now: NOW });
  assert.equal(report.dryRun, true);
  assert.deepEqual(staging.calls.filter(call => call.method !== "GET").map(call => call.path), ["/api/staging-login"], "the only write is the staff sign-in");
  assert.ok(staging.calls.every(call => call.origin === STAGING), "every request stays on the staging origin");
  assert.ok(staging.sessions.every(s => s.status !== "cancelled"), "nothing changed");
  const byId = Object.fromEntries(report.rows.map(row => [row.sessionId, row]));
  assert.deepEqual(Object.keys(byId).sort(), ["S1", "S10", "S2", "S4", "S5", "S6"]);
  for (const id of ["S1", "S2", "S4", "S10"]) { assert.equal(byId[id].action, CLEANUP_ACTION, id); assert.equal(byId[id].result, "would cancel (dry run)", id); }
  for (const id of ["S5", "S6"]) { assert.equal(byId[id].action, "none", id); assert.match(byId[id].result, /^left unchanged/, id); }
  assert.deepEqual(report.unpaid.map(row => row.bookingId), ["B8"]);
  const output = `${logs.join("\n")}\n${fs.readFileSync(reportPath, "utf8")}`;
  assert.match(output, /DRY RUN - nothing changed/);
  assert.match(output, /session id\s+\| booking id\s+\| provider\s+\| scheduled start\s+\| old status\s+\| action\s+\| result/);
  assert.doesNotMatch(output, new RegExp(`${CODE}|${TOKEN}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DRY_RUN=false cancels through the governed staff API with the reason and deterministic keys, and a re-run is safe", async () => {
  const staging = fakeStaging();
  const logs = [];
  const report = await runCleanup({ env: { BASE_URL: STAGING, PAWSPACE_UAT_ACCESS_CODE: CODE, DRY_RUN: "false" }, fetcher: staging.fetcher, log: line => logs.push(line), now: NOW });
  const posts = staging.calls.filter(call => call.method === "POST" && call.path === "/api/training-sessions");
  assert.deepEqual(posts.map(call => call.body.sessionId), ["S1", "S2", "S4", "S10"]);
  for (const call of posts) {
    assert.deepEqual(call.body, { sessionId: call.body.sessionId, action: "cancel_session", idempotencyKey: cleanupIdempotencyKey(call.body.sessionId), reason: CLEANUP_REASON });
    assert.equal(call.headers.origin, STAGING);
  }
  assert.equal(CLEANUP_REASON, "UAT stale test data cleanup (founder-approved 26 Sep 2026)");
  assert.deepEqual(Object.fromEntries(staging.sessions.map(s => [s.id, s.status])), {
    S1: "cancelled", S2: "cancelled", S3: "scheduled", S4: "cancelled", S5: "on_the_way", S6: "scheduled", S7: "scheduled", S8: "completed", S9: "in_session", S10: "cancelled",
  });
  assert.equal(report.counts.cancelled, 4);
  assert.equal(report.counts.failed, 0);
  assert.equal(report.counts.remaining, 0);
  assert.match(report.rows.find(row => row.sessionId === "S2").result, /unlocked by the previous cancellation/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(`${CODE}|${TOKEN}`));

  const again = await runCleanup({ env: { BASE_URL: STAGING, PAWSPACE_UAT_ACCESS_CODE: CODE, DRY_RUN: "false" }, fetcher: staging.fetcher, log: () => {}, now: NOW });
  assert.equal(again.counts.eligible, 0, "cancelled sessions are no longer selected");
  assert.equal(staging.calls.filter(call => call.method === "POST" && call.path === "/api/training-sessions").length, 4);
});

test("a replayed key reports an idempotent replay and a refused cancel is reported as a failure", async () => {
  const staging = fakeStaging();
  staging.keys.set(cleanupIdempotencyKey("S1"), "S1");
  const refusing = async (href, init) => {
    const target = init?.method === "POST" && new URL(href).pathname === "/api/training-sessions" ? JSON.parse(init.body).sessionId : "";
    if (target === "S4") return new Response(JSON.stringify({ error: "Unable to update Training session" }), { status: 409 });
    if (target === "S10") throw new TypeError("fetch failed");
    return staging.fetcher(href, init);
  };
  const report = await runCleanup({ env: { BASE_URL: STAGING, PAWSPACE_UAT_ACCESS_CODE: CODE, DRY_RUN: "false" }, fetcher: refusing, log: () => {}, now: NOW });
  assert.match(report.rows.find(row => row.sessionId === "S1").result, /idempotent replay/);
  assert.match(report.rows.find(row => row.sessionId === "S4").result, /^FAILED HTTP 409: Unable to update Training session/);
  assert.match(report.rows.find(row => row.sessionId === "S10").result, /^FAILED request error: TypeError/);
  assert.equal(report.counts.replayed, 1);
  assert.equal(report.counts.failed, 2);
  assert.ok(report.counts.remaining > 0, "the verification re-read still sees the sessions that were not cancelled");
});

test("the workflow runs the cleanup only for suite=cleanup, dry-run by default, on the staging origin", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/uat-training-deployed.yml", import.meta.url), "utf8");
  assert.match(workflow, /options:\n\s+- training-deployed\n\s+- master\n\s+- cleanup\n/);
  assert.match(workflow, /apply:\n\s+description: .*\n\s+required: false\n\s+default: 'dry-run'\n\s+type: choice\n\s+options:\n\s+- dry-run\n\s+- apply\n/);
  const step = workflow.slice(workflow.indexOf("- name: Clean up stale UAT Training sessions"), workflow.indexOf("- name: Print report"));
  assert.match(step, /if: github\.event\.inputs\.suite == 'cleanup'\n/);
  assert.match(step, /BASE_URL: \$\{\{ github\.event\.inputs\.base_url \}\}/);
  assert.match(step, /PAWSPACE_UAT_ACCESS_CODE: \$\{\{ secrets\.PAWSPACE_UAT_ACCESS_CODE \}\}/);
  assert.match(step, /DRY_RUN: \$\{\{ github\.event\.inputs\.apply == 'apply' && 'false' \|\| 'true' \}\}/);
  assert.match(step, /run: node scripts\/uat-staging-training-cleanup\.mjs/);
  assert.match(workflow, /- name: Run deployed Training acceptance\n\s+if: github\.event\.inputs\.suite != 'master' && github\.event\.inputs\.suite != 'cleanup'\n/);
  assert.match(workflow, /default: 'https:\/\/pawspace-staging\.karthik-fce\.workers\.dev'/);
});
