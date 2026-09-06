import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";

const BASE_URL = process.env.P04_BASE_URL || "http://127.0.0.1:8794";
const ACCESS_CODE = process.env.P04_UAT_ACCESS_CODE || "p04-local-proof-access-code";
const ARTIFACT_DIR = process.env.P04_ARTIFACT_DIR || "artifacts/p04-concurrency";

function pickHeaders(headers) {
  const names = ["content-type", "cache-control", "x-request-id", "cf-ray", "server"];
  return Object.fromEntries(names.map((name) => [name, headers.get(name)]).filter(([, value]) => value));
}

async function readResponse(response, started) {
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return {
    status: response.status,
    ok: response.ok,
    headers: pickHeaders(response.headers),
    body,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
  };
}

async function post(path, body, cookie = "") {
  const started = performance.now();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return readResponse(response, started);
}

async function get(path, cookie = "") {
  const started = performance.now();
  const response = await fetch(`${BASE_URL}${path}`, { headers: cookie ? { cookie } : {} });
  return readResponse(response, started);
}

async function login() {
  const started = performance.now();
  const response = await fetch(`${BASE_URL}/api/staging-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "login", email: "founder@pawspace.in", code: ACCESS_CODE }),
  });
  const result = await readResponse(response, started);
  assert.equal(result.status, 200, `founder UAT login failed: ${JSON.stringify(result.body)}`);
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";", 1)[0];
  assert.match(cookie, /^pawspace_uat=/, "signed UAT session cookie was not issued");
  return { cookie, result: { ...result, headers: { ...result.headers, "set-cookie": "[redacted signed session cookie]" } } };
}

async function directLifecycleRace(cookie, round) {
  const bookingId = `P04-DIRECT-${Date.now()}-${round}`;
  const setup = await post("/setup", { bookingId, status: "confirmed" });
  assert.equal(setup.status, 200);
  const raceStartedAt = new Date().toISOString();
  const raceStart = performance.now();
  const [accept, noShow] = await Promise.all([
    post("/api/sitting-lifecycle", { bookingId, action: "accept", idempotencyKey: `${bookingId}:accept` }, cookie),
    post("/api/sitting-lifecycle", { bookingId, action: "no_show", idempotencyKey: `${bookingId}:no-show`, reason: "Adversarial simultaneous no-show" }, cookie),
  ]);
  const raceDurationMs = Number((performance.now() - raceStart).toFixed(3));
  const final = await get(`/state?bookingId=${encodeURIComponent(bookingId)}`, cookie);
  const statuses = [accept.status, noShow.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], `expected one 200 and one 409, got ${JSON.stringify({ accept, noShow })}`);
  const winner = accept.status === 200 ? "accept" : "no_show";
  const expectedFinal = winner === "accept" ? "assigned" : "reassignment_needed";
  assert.equal(final.body?.data?.booking?.status, expectedFinal, "final canonical booking state must match exactly the winning mutation");
  assert.equal(final.body?.data?.actionKeyCount, 1, "only the winning mutation may persist an idempotency result");
  return { bookingId, round, raceStartedAt, raceDurationMs, winner, responses: { accept, noShow }, finalState: final.body?.data };
}

async function controlledDatabaseClaimRace(cookie) {
  const bookingId = `P04-CONTROLLED-${Date.now()}`;
  const result = await post("/controlled-race", { bookingId }, cookie);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const outcomes = result.body?.outcomes || [];
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes.map((x) => x.httpStatus).sort((a, b) => a - b), [200, 409]);
  assert.deepEqual(outcomes.map((x) => x.metaChanges).sort((a, b) => a - b), [0, 1]);
  assert.equal(result.body?.finalState?.booking?.status, "assigned");
  return result.body;
}

test("P0-4 adversarial lifecycle concurrency: exactly one winner and stale loser 409", async () => {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const health = await get("/health");
  assert.equal(health.status, 200);
  const { cookie, result: loginEvidence } = await login();

  const directRounds = [];
  for (let round = 1; round <= 10; round += 1) directRounds.push(await directLifecycleRace(cookie, round));
  const controlled = await controlledDatabaseClaimRace(cookie);

  const distribution = directRounds.reduce((acc, item) => {
    const key = `${item.responses.accept.status}/${item.responses.noShow.status}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const evidence = {
    generatedAt: new Date().toISOString(),
    target: BASE_URL,
    auth: { mode: "signed staging UAT founder session", login: loginEvidence },
    invariant: "exactly one success and exactly one HTTP 409 for competing expected-state mutations on one canonical booking",
    directHttpRace: { rounds: directRounds.length, statusDistribution: distribution, results: directRounds },
    controlledSameReadClaimRace: controlled,
    verdict: "P0-4 CONCURRENCY GUARD PROVED",
  };
  await writeFile(`${ARTIFACT_DIR}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(`${ARTIFACT_DIR}/report.md`, [
    "# PawSpace P0-4 Adversarial Lifecycle Concurrency Proof",
    "",
    `- Generated: ${evidence.generatedAt}`,
    `- Target: ${BASE_URL}`,
    "- Auth: signed UAT founder session (cookie value redacted)",
    `- Direct HTTP races: ${directRounds.length}/${directRounds.length} produced exactly one success and one 409`,
    `- Status distribution: ${JSON.stringify(distribution)}`,
    `- Controlled stale-read claim: meta.changes distribution ${JSON.stringify(controlled.outcomes.map((x) => x.metaChanges).sort((a,b)=>a-b))}`,
    `- Controlled HTTP mapping: ${JSON.stringify(controlled.outcomes.map((x) => x.httpStatus).sort((a,b)=>a-b))}`,
    `- Final controlled DB state: ${controlled.finalState?.booking?.status}`,
    "- Verdict: **P0-4 CONCURRENCY GUARD PROVED**",
    "",
    "Each direct race fires `accept` and `no_show` concurrently with `Promise.all` against the exact same confirmed Sitting booking. The winner changes the row; the loser is rejected as stale with HTTP 409. The controlled barrier race independently proves the D1 expected-status claim returns meta.changes 1 for one actor and 0 for the stale actor.",
  ].join("\n"));

  console.log(JSON.stringify({ verdict: evidence.verdict, directRounds: directRounds.length, distribution, controlled: controlled.outcomes, finalState: controlled.finalState }, null, 2));
});
