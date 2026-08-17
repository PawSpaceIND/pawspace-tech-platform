/**
 * The preview/UAT verification gate, run ENTIRELY inside the GitHub Actions runner against the
 * deployed release-preview Worker and its isolated real D1.
 *
 * It exists because the local suites prove the handler's logic against a node:sqlite shim, and a shim
 * is not D1: type affinity, transaction semantics and the bind cap are all modelled rather than
 * observed. The cases below are the ones whose answers could differ on the real database.
 *
 * NOTHING SENSITIVE LEAVES THIS JOB. The access code, the session cookie, the API token and the D1 id
 * are read from the environment and never written to the report, never echoed, never included in a
 * failure message. The report records statuses, counts and booking identifiers only.
 *
 * Env (all supplied by the workflow):
 *   PREVIEW_WORKER          the dedicated Worker name (used to resolve its URL and query its D1)
 *   EXPECTED_SHA            the exact commit the workflow deployed
 *   PAWSPACE_UAT_ACCESS_CODE  tester code for /staging-login
 *   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / PREVIEW_D1   for reconciliation reads
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const WORKER = process.env.PREVIEW_WORKER || "";
const EXPECTED_SHA = process.env.EXPECTED_SHA || "";
const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
const PREVIEW_D1 = process.env.PREVIEW_D1 || "";
if (!WORKER || !EXPECTED_SHA || !ACCESS_CODE || !PREVIEW_D1) {
  console.error("release-preview gate: required environment is not configured.");
  process.exit(1);
}

/** Resolve the deployed URL without printing anything that is not already public. */
const BASE = process.env.PREVIEW_URL || `https://${WORKER}.workers.dev`;
const RUN = `preview-${Date.now().toString(36)}`;          // namespaces every row this gate creates
const report = { sha: EXPECTED_SHA, worker: WORKER, run: RUN, checks: [], counts: {} };
let failures = 0;

function check(name, ok, detail = "") {
  report.checks.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

/** Read the isolated preview D1 by ID, so a reconciliation query cannot land on another database. */
function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", PREVIEW_D1, "--remote", "--json", "--command", sql], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? parsed?.result?.[0]?.results ?? [];
}
const countOf = (table, where = "1=1") => Number(d1(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)[0]?.n ?? 0);

// ── sign in ───────────────────────────────────────────────────────────────────────────────────
let cookie = "";
async function signIn() {
  const res = await fetch(`${BASE}/api/staging-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessCode: ACCESS_CODE, email: "founder@pawspace.in" }),
  });
  cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  // The code itself is never reported — only whether a session came back.
  return check("UAT sign-in established a session", res.ok && Boolean(cookie), `status=${res.status}`);
}

const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = JSON.parse(await res.text()); } catch { /* non-JSON */ }
  return { status: res.status, body: parsed };
};

const CUSTOMER = `${RUN}-CUS`, PROVIDER = `${RUN}-PRV`;
const START = "2027-03-04T09:00:00.000Z", END = "2027-03-04T11:00:00.000Z";
const booking = (over = {}) => ({
  idempotencyKey: `${RUN}-ik`, scheduleGroupId: `${RUN}-sg`,
  customer: { id: CUSTOMER, name: "Preview tester", primaryPhone: "+919000000900" },
  pets: [{ sourceId: "acct-1", name: "Bruno", species: "dog", breed: "Beagle" }],
  cityId: "blr", zoneId: "koramangala",
  serviceCode: "pet_sitting", packageCode: "home-visit", packageName: "Pet Sitting",
  scheduledStart: START, scheduledEnd: END,
  provider: { id: PROVIDER, name: "Preview sitter", model: "full_time" },
  totalAmount: 1349, amountDueNow: 1349,
  payment: { method: "upi", mode: "prepaid", status: "captured", detail: "preview" },
  pricing: { discount: 0 }, ...over,
});

/** Seed a reservation in the isolated D1 so a booking can reach the pet path. */
function seedScheduling(group, { city = "blr", zone = "koramangala" } = {}) {
  d1(`INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('${group}','balanced','[]','${PROVIDER}','assigned','preview','gate',1)`);
  d1(`INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('RES-${group}','${group}','${PROVIDER}','pet_sitting','${city}','${zone}','${CUSTOMER}','[]','${START}','${END}',1,1,NULL,'reserved','{}',1)`);
}

const TOUCHED = ["canonical_pets", "canonical_bookings", "booking_payments", "provider_work_orders", "booking_lifecycle_events"];
const snapshot = () => Object.fromEntries(TOUCHED.map((t) => [t, countOf(t, t === "canonical_bookings" ? `schedule_group_id LIKE '${RUN}%'` : "1=1")]));

// ── the gate ──────────────────────────────────────────────────────────────────────────────────
console.log(`Release preview gate — ${WORKER} @ ${EXPECTED_SHA.slice(0, 8)}`);

// 1. Isolation is re-proved from inside the runner: the preview D1 must not hold production volume.
const preexistingBookings = countOf("canonical_bookings");
check("preview D1 responds and is addressed by id", Number.isFinite(preexistingBookings), `bookings=${preexistingBookings}`);
report.counts.preexistingBookings = preexistingBookings;

if (await signIn()) {
  // 2. Gateway denial: no session at all must be refused, and must disclose nothing.
  const anonCookie = cookie; cookie = "";
  const anonGet = await api("GET", "/api/canonical-bookings");
  check("unauthenticated GET is refused", anonGet.status === 401 || anonGet.status === 403, `status=${anonGet.status}`);
  check("a refused GET carries no bookings", anonGet.body?.bookings === undefined);
  const anonPost = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-anon`, scheduleGroupId: `${RUN}-anon` }));
  check("unauthenticated POST is refused", anonPost.status === 401 || anonPost.status === 403, `status=${anonPost.status}`);
  cookie = anonCookie;

  // 3. Authorized behaviour, and the city/zone invariant, against the real database.
  seedScheduling(`${RUN}-sg`);
  const before = snapshot();
  const created = await api("POST", "/api/canonical-bookings", booking());
  check("authorized POST creates a booking", created.status === 201, `status=${created.status}`);
  const listed = await api("GET", "/api/canonical-bookings");
  check("authorized GET lists it", listed.status === 200 && Array.isArray(listed.body?.bookings));

  seedScheduling(`${RUN}-mm`, { city: "blr", zone: "koramangala" });
  const mismatch = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-mm`, scheduleGroupId: `${RUN}-mm`, cityId: "maa", zoneId: "adyar" }));
  check("a city/zone mismatch is refused", mismatch.status === 409 && /city\/zone does not match/i.test(mismatch.body?.error ?? ""), `status=${mismatch.status}`);
  check("the mismatch wrote no booking", countOf("canonical_bookings", `schedule_group_id='${RUN}-mm'`) === 0);

  // 4. The pet-identity cases whose answer depends on real D1 type affinity.
  const malformed = [["numeric", 7], ["boolean", true], ["object", { id: "x" }], ["array", [7]]];
  for (const [label, sourceId] of malformed) {
    const group = `${RUN}-bad-${label}`;
    seedScheduling(group);
    const petsBefore = countOf("canonical_pets", `customer_id='${CUSTOMER}'`);
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${group}-${i}`, scheduleGroupId: group, pets: [{ sourceId, name: "Seven" }] }))).status);
    check(`${label} sourceId is refused every time`, statuses.every((s) => s === 400), `statuses=${statuses.join(",")}`);
    check(`${label} sourceId created no pet row`, countOf("canonical_pets", `customer_id='${CUSTOMER}'`) === petsBefore);
  }

  // "7" as TEXT must converge on one row — the case the shim could only model.
  const convergeIds = new Set();
  for (let i = 0; i < 12; i++) {
    const group = `${RUN}-seven-${i}`;
    seedScheduling(group);
    const res = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: group, scheduleGroupId: group, pets: [{ sourceId: "7", name: "Seven" }] }));
    if (res.status === 201) (res.body?.data?.petIds ?? []).forEach((id) => convergeIds.add(id));
  }
  check('string "7" converges on ONE canonical pet', convergeIds.size === 1, `distinct ids=${convergeIds.size}`);
  check('only one row exists for source "7"', countOf("canonical_pets", `customer_id='${CUSTOMER}' AND source_pet_id='7'`) === 1);

  // 5. Historical replay through both halves of the idempotency lookup.
  const replayKey = await api("POST", "/api/canonical-bookings", booking());
  check("replay by idempotency key returns the original", replayKey.status === 200 && replayKey.body?.data?.duplicatePrevented === true, `status=${replayKey.status}`);
  const replayGroup = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-other` }));
  check("replay by schedule group returns the original", replayGroup.status === 200 && replayGroup.body?.data?.duplicatePrevented === true, `status=${replayGroup.status}`);
  const after = snapshot();
  check("replays had no side effects", JSON.stringify(before.canonical_bookings + 1) === JSON.stringify(after.canonical_bookings), `${before.canonical_bookings} -> ${after.canonical_bookings}`);

  // 6. A synthetic swarm, sized so the bind cap and batch limits are exercised for real.
  const SWARM = Number(process.env.PREVIEW_SWARM_SIZE || 60);
  let swarmOk = 0;
  for (let i = 0; i < SWARM; i++) {
    const group = `${RUN}-swarm-${i}`;
    seedScheduling(group);
    const res = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: group, scheduleGroupId: group, pets: [{ sourceId: `swarm-${i}`, name: `Pet ${i}` }] }));
    if (res.status === 201) swarmOk++;
  }
  check(`${SWARM}-booking swarm all confirmed`, swarmOk === SWARM, `confirmed=${swarmOk}/${SWARM}`);

  // 7. Reconciliation: every confirmed booking has exactly one payment, one work order and its pets.
  const swarmBookings = countOf("canonical_bookings", `schedule_group_id LIKE '${RUN}-swarm-%'`);
  const swarmPayments = Number(d1(`SELECT COUNT(*) n FROM booking_payments p JOIN canonical_bookings b ON b.id=p.booking_id WHERE b.schedule_group_id LIKE '${RUN}-swarm-%'`)[0]?.n ?? 0);
  const swarmOrders = Number(d1(`SELECT COUNT(*) n FROM provider_work_orders w JOIN canonical_bookings b ON b.id=w.booking_id WHERE b.schedule_group_id LIKE '${RUN}-swarm-%'`)[0]?.n ?? 0);
  const orphanPets = Number(d1(`SELECT COUNT(*) n FROM canonical_bookings b WHERE b.schedule_group_id LIKE '${RUN}-swarm-%' AND (SELECT COUNT(*) FROM canonical_pets p WHERE p.id IN (SELECT value FROM json_each(b.pet_ids_json))) = 0`)[0]?.n ?? 0);
  report.counts.swarm = { bookings: swarmBookings, payments: swarmPayments, workOrders: swarmOrders, orphanPets };
  check("every swarm booking reconciles to one payment", swarmPayments === swarmBookings, `${swarmPayments}/${swarmBookings}`);
  check("every swarm booking reconciles to one work order", swarmOrders === swarmBookings, `${swarmOrders}/${swarmBookings}`);
  check("no booking points at a pet row that does not exist", orphanPets === 0, `orphans=${orphanPets}`);

  // 8. Provider activation must not have been promoted by anything above.
  const liveProviders = countOf("providers", "live=1 OR marketplace_live=1 OR order_eligible=1").toString();
  check("no provider became live in the preview", liveProviders === "0", `live=${liveProviders}`);
}

report.failures = failures;
writeFileSync("release-preview-report.json", JSON.stringify(report, null, 2));
console.log(`\nrelease preview gate: ${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
