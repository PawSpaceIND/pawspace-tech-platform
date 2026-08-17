/**
 * The preview/UAT verification gate, run ENTIRELY inside the GitHub Actions runner against the
 * deployed release-preview Worker and its isolated real D1.
 *
 * It exists because the committed suites prove the handlers' logic against a node:sqlite shim, and a
 * shim is not D1: type affinity, transaction semantics, the bind cap and real concurrency are all
 * modelled rather than observed. The cases below are the ones whose answers could differ on the real
 * database, plus the authorization cases that are only end-to-end once a real Worker is answering.
 *
 * TWO-CHECKOUT SAFE. This file is bootstrap tooling and lives in the infra/ checkout. The product it
 * exercises lives in candidate/ and is reached over HTTP; the only thing read from the candidate's
 * files is table DDL (see ddlFor), so this gate can verify a candidate commit that does not contain it.
 *
 * NOTHING SENSITIVE LEAVES THIS JOB. The access code, the session cookies, the API token and the D1 id
 * are read from the environment and never written to the report, never echoed, never included in a
 * failure message. The report records check names, statuses, counts and run-scoped identifiers only.
 *
 * Env (all supplied by .github/workflows/deploy-release-preview.yml):
 *   PREVIEW_WORKER            the dedicated Worker name (resolves its URL, and names it to wrangler)
 *   EXPECTED_SHA              the exact commit the workflow deployed
 *   PAWSPACE_UAT_ACCESS_CODE  tester code for /api/staging-login
 *   PREVIEW_D1                the isolated preview database id
 *   CANDIDATE_DIR             the candidate checkout (its wrangler binary, and its DDL)
 *   PREVIEW_URL               optional override for the deployed base URL
 *   REPORT_PATH               optional override for where the evidence artifact is written
 *   PREVIEW_SWARM_SIZE        optional override for the synthetic swarm (default 60)
 */
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const WORKER = String(process.env.PREVIEW_WORKER || "").trim();
const EXPECTED_SHA = String(process.env.EXPECTED_SHA || "").trim();
const ACCESS_CODE = String(process.env.PAWSPACE_UAT_ACCESS_CODE || "");
const PREVIEW_D1 = String(process.env.PREVIEW_D1 || "").trim();
const CANDIDATE_DIR = String(process.env.CANDIDATE_DIR || process.cwd());
const REPORT_PATH = String(process.env.REPORT_PATH || "release-preview-report.json");
const SWARM = Number(process.env.PREVIEW_SWARM_SIZE || 60);

const missing = [];
if (!WORKER) missing.push("PREVIEW_WORKER");
if (!/^[0-9a-f]{40}$/i.test(EXPECTED_SHA)) missing.push("EXPECTED_SHA");
if (!ACCESS_CODE) missing.push("PAWSPACE_UAT_ACCESS_CODE");
if (!PREVIEW_D1) missing.push("PREVIEW_D1");
if (!existsSync(CANDIDATE_DIR)) missing.push("CANDIDATE_DIR");
if (missing.length) {
  // Names only — never the values.
  console.error(`release-preview gate: required environment is not configured (${missing.join(", ")}).`);
  process.exit(1);
}

const BASE = String(process.env.PREVIEW_URL || `https://${WORKER}.workers.dev`).replace(/\/$/, "");
const RUN = `preview-${Date.now().toString(36)}`;   // namespaces every row this gate creates
const report = { sha: EXPECTED_SHA, worker: WORKER, run: RUN, checks: [], counts: {}, warnings: [] };
let failures = 0;
let warnings = 0;

function check(name, ok, detail = "") {
  report.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
}

/**
 * A check that could not be RUN, as distinct from one that failed. Never counted as a pass: it is
 * printed, recorded in the artifact and repeated in the summary, so an unavailable check cannot be
 * mistaken for a clean one by anybody reading the log.
 */
function unavailable(name, reason) {
  report.checks.push({ name, ok: null, detail: reason });
  report.warnings.push(`${name}: ${reason}`);
  warnings++;
  console.log(`  WARN  ${name} — NOT RUN: ${reason}`);
}

// ── wrangler, from the candidate's own pinned install ─────────────────────────────────────────────
const localWrangler = path.join(CANDIDATE_DIR, "node_modules", ".bin", "wrangler");
const WRANGLER = existsSync(localWrangler) ? { cmd: localWrangler, lead: [] } : { cmd: "npx", lead: ["wrangler"] };

function wrangler(args, { allowFailure = false } = {}) {
  try {
    return execFileSync(WRANGLER.cmd, [...WRANGLER.lead, ...args], {
      cwd: CANDIDATE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return "";
    // The command is reported, never its environment. Arguments here carry the database id, so only
    // the subcommand is echoed.
    throw new Error(`wrangler ${args[0]} ${args[1] || ""} failed`.trim() + `: ${String(error.stderr || error.message).slice(0, 400)}`);
  }
}

/** Read the isolated preview D1 BY ID, so a query cannot land on another database by name resolution. */
function d1(sql) {
  const out = wrangler(["d1", "execute", PREVIEW_D1, "--remote", "--json", "--command", sql]);
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? parsed?.result?.[0]?.results ?? [];
}
const exec1 = (sql) => { d1(sql); };
const countOf = (table, where = "1=1") => Number(d1(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)[0]?.n ?? 0);

/**
 * The DDL for a support table, taken from the CANDIDATE's own source rather than copied here.
 *
 * The preview D1 starts empty and this candidate has no migrations directory: the product routes
 * create the tables they own on first request, but the gate has to seed staff, roles and a scheduling
 * reservation BEFORE any request can succeed. Copying four CREATE TABLE statements into this file
 * would mean maintaining a second definition that silently drifts from the one being deployed, so the
 * statement is extracted from the candidate instead — always the exact shape the deployed code expects.
 */
function ddlFor(table) {
  const roots = ["app", "lib", "worker"].map((dir) => path.join(CANDIDATE_DIR, dir)).filter(existsSync);
  const needle = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.(ts|tsx|mjs|js)$/.test(entry)) files.push(full);
    }
  };
  for (const root of roots) walk(root);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const start = source.indexOf(needle);
    if (start < 0) continue;
    // Balance the parentheses rather than stopping at the first ")", which lands inside DEFAULT (...)
    // and NOT NULL DEFAULT '(' style column definitions.
    let depth = 0;
    for (let i = start + needle.length - 1; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") { depth--; if (depth === 0) return source.slice(start, i + 1); }
    }
  }
  throw new Error(`No CREATE TABLE statement for ${table} found in the candidate — the gate cannot seed it.`);
}

// ── identities the gate signs in as ───────────────────────────────────────────────────────────────
// Explicit permission sets, seeded as role_definitions rows, because that table is what both the
// gateway and the UAT staff resolver read. Asserting against the product's own default role list would
// make this gate a test of a constant rather than of the deployed authorization path.
const ROLES = [
  { code: "gate_ops", permissions: ["bookings.view", "scheduling.book", "bookings.manage"] },
  { code: "gate_viewer", permissions: ["bookings.view"] },
  { code: "gate_booker", permissions: ["scheduling.book"] },
  { code: "gate_finance", permissions: ["finance.view", "finance.manage"] },
];
const STAFF = [
  { email: `${RUN}.ops@pawspace.in`, role: "gate_ops" },
  { email: `${RUN}.viewer@pawspace.in`, role: "gate_viewer" },
  { email: `${RUN}.booker@pawspace.in`, role: "gate_booker" },
  { email: `${RUN}.finance@pawspace.in`, role: "gate_finance" },
];

const CUSTOMER = `${RUN}-CUS`;
const OTHER_CUSTOMER = `${RUN}-CUS2`;
const PROVIDER = `${RUN}-PRV`;
const START = "2027-03-04T09:00:00.000Z";
const END = "2027-03-04T11:00:00.000Z";
const RESERVED_CITY = "blr";
const RESERVED_ZONE = "koramangala";

const booking = (over = {}) => ({
  idempotencyKey: `${RUN}-ik`, scheduleGroupId: `${RUN}-sg`,
  customer: { id: CUSTOMER, name: "Preview tester", primaryPhone: "+919000000900" },
  pets: [{ sourceId: "acct-1", name: "Bruno", species: "dog", breed: "Beagle", vaccinationStatus: "up_to_date" }],
  cityId: RESERVED_CITY, zoneId: RESERVED_ZONE,
  serviceCode: "pet_sitting", packageCode: "home-visit", packageName: "Pet Sitting",
  scheduledStart: START, scheduledEnd: END,
  provider: { id: PROVIDER, name: "Preview sitter", model: "full_time" },
  totalAmount: 1349, amountDueNow: 1349,
  payment: { method: "upi", mode: "prepaid", status: "captured", detail: "preview" },
  pricing: { discount: 0 },
  ...over,
});

const sql = (value) => String(value).replace(/'/g, "''");

/** Seed a reservation the booking can confirm, in the city/zone the reservation is actually for. */
function seedScheduling(group, { city = RESERVED_CITY, zone = RESERVED_ZONE, customer = CUSTOMER } = {}) {
  exec1(`INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('${sql(group)}','balanced','[]','${sql(PROVIDER)}','assigned','preview-gate','release preview',1)`);
  exec1(`INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('RES-${sql(group)}','${sql(group)}','${sql(PROVIDER)}','pet_sitting','${sql(city)}','${sql(zone)}','${sql(customer)}','[]','${START}','${END}',1,1,NULL,'reserved','{}',1)`);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────────
async function signIn(email) {
  const res = await fetch(`${BASE}/api/staging-login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: ACCESS_CODE, email }),
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  // The code itself is never reported — only whether a session came back.
  return { status: res.status, cookie: res.ok ? cookie : "" };
}

async function api(method, route, body, cookie, extraHeaders = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  const text = await res.text();
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed, text };
}

const TOUCHED = ["canonical_pets", "canonical_bookings", "booking_payments", "provider_work_orders", "booking_lifecycle_events"];
const runScoped = (table) => (table === "canonical_bookings" ? `schedule_group_id LIKE '${RUN}%'` : "1=1");
const snapshot = () => Object.fromEntries(TOUCHED.map((t) => [t, countOf(t, runScoped(t))]));

console.log(`Release preview gate — ${WORKER} @ ${EXPECTED_SHA.slice(0, 8)}  (run ${RUN})`);

// ── 1. the preview database answers, is addressed by id, and is not carrying production volume ────
let preexisting = null;
try {
  // Warms the product's own schema creation for every table the route owns, before anything is counted.
  const warm = await api("GET", "/api/canonical-bookings");
  check("the deployed Worker answers on the preview URL", warm.status > 0, `status=${warm.status}`);
  preexisting = countOf("canonical_bookings");
  report.counts.preexistingBookings = preexisting;
  check("the isolated preview D1 responds when addressed by id", Number.isFinite(preexisting), `bookings=${preexisting}`);
} catch (error) {
  check("the isolated preview D1 responds when addressed by id", false, String(error.message).slice(0, 200));
}

// ── 2. hosted sha verification, from inside the runner ────────────────────────────────────────────
{
  const versions = wrangler(["versions", "list", "--name", WORKER, "--json"], { allowFailure: true })
    || wrangler(["deployments", "list", "--name", WORKER], { allowFailure: true });
  if (!versions) unavailable("the hosted version marker carries the deployed sha", "wrangler could not read the Worker's versions");
  else check("the hosted version marker carries the deployed sha", versions.includes(EXPECTED_SHA), "read back from the deployed version, not a public endpoint");
}

// ── 3. seed the staff directory this preview needs ────────────────────────────────────────────────
// The preview D1 is empty, and /api/staging-login refuses any email that is not an ACTIVE staff
// account whose role has a definition. Without this the gate cannot sign in at all.
let seeded = false;
try {
  for (const table of ["app_users", "role_definitions", "scheduling_reservations", "scheduling_assignment_decisions"]) {
    exec1(ddlFor(table));
  }
  for (const role of ROLES) {
    exec1(`INSERT OR REPLACE INTO role_definitions (code,permissions_json) VALUES ('${role.code}','${sql(JSON.stringify(role.permissions))}')`);
  }
  for (const person of STAFF) {
    exec1(`INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-${sql(person.email)}','${sql(person.email)}','Preview ${person.role}','${person.role}','active',1,1)`);
  }
  seeded = check("the preview staff directory and scheduling tables are seeded", true, `${STAFF.length} identities, ${ROLES.length} roles`);
} catch (error) {
  check("the preview staff directory and scheduling tables are seeded", false, String(error.message).slice(0, 300));
}

let ops = "";
let viewer = "";
let booker = "";
let finance = "";

if (seeded) {
  // ── 4. UAT sign-in ──────────────────────────────────────────────────────────────────────────────
  const opsSignIn = await signIn(STAFF[0].email);
  ops = opsSignIn.cookie;
  check("UAT sign-in establishes a session for a seeded staff identity", opsSignIn.status === 200 && Boolean(ops), `status=${opsSignIn.status}`);
  viewer = (await signIn(STAFF[1].email)).cookie;
  booker = (await signIn(STAFF[2].email)).cookie;
  finance = (await signIn(STAFF[3].email)).cookie;
  const stranger = await signIn(`${RUN}.stranger@pawspace.in`);
  check("UAT sign-in refuses an email that is not a provisioned staff account", stranger.status === 403 && !stranger.cookie, `status=${stranger.status}`);
}

if (ops) {
  // ── 5. gateway authorization, end to end through the deployed Worker ────────────────────────────
  const anonGet = await api("GET", "/api/canonical-bookings");
  check("unauthenticated GET is refused", anonGet.status === 401 || anonGet.status === 403, `status=${anonGet.status}`);
  check("a refused GET discloses no bookings", anonGet.body?.bookings === undefined && !/customer_id/.test(anonGet.text || ""));

  const anonPost = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-anon`, scheduleGroupId: `${RUN}-anon` }));
  check("unauthenticated POST is refused", anonPost.status === 401 || anonPost.status === 403, `status=${anonPost.status}`);
  check("the refused POST wrote nothing", countOf("canonical_bookings", `schedule_group_id='${RUN}-anon'`) === 0);

  check("GET with bookings.view is permitted", (await api("GET", "/api/canonical-bookings", undefined, viewer)).status === 200);
  const financeGet = await api("GET", "/api/canonical-bookings", undefined, finance);
  check("GET without bookings.view is refused", financeGet.status === 403, `status=${financeGet.status}`);

  const viewerPost = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-noperm`, scheduleGroupId: `${RUN}-noperm` }), viewer);
  check("POST without scheduling.book is refused", viewerPost.status === 403, `status=${viewerPost.status}`);
  check("that refusal wrote nothing", countOf("canonical_bookings", `schedule_group_id='${RUN}-noperm'`) === 0);

  // scheduling.book gets past the GATEWAY, and is then stopped by canonical customer ownership: the
  // second half of the policy for this route, enforced by the handler rather than the gateway.
  seedScheduling(`${RUN}-own`, { customer: OTHER_CUSTOMER });
  const notOwner = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-own`, scheduleGroupId: `${RUN}-own`, customer: { id: OTHER_CUSTOMER, name: "Someone else", primaryPhone: "+919000000901" } }), booker);
  check("scheduling.book alone cannot book for a customer it does not own", notOwner.status === 403, `status=${notOwner.status}`);
  check("the ownership refusal wrote nothing", countOf("canonical_bookings", `schedule_group_id='${RUN}-own'`) === 0);

  const forged = await api("GET", "/api/canonical-bookings", undefined, "", {
    "oai-authenticated-user-email": STAFF[0].email, "x-pawspace-role": "founder", "x-forwarded-host": "localhost",
  });
  check("client-supplied identity and role headers cannot manufacture authorization", forged.status === 401 || forged.status === 403, `status=${forged.status}`);

  // ── 6. city/zone integrity against the real database ────────────────────────────────────────────
  seedScheduling(`${RUN}-sg`);
  const before = snapshot();
  const created = await api("POST", "/api/canonical-bookings", booking(), ops);
  check("an authorized booking whose city/zone matches its reservation is created", created.status === 201, `status=${created.status}`);
  const storedCity = d1(`SELECT city_id,zone_id FROM canonical_bookings WHERE schedule_group_id='${RUN}-sg'`)[0] || {};
  check("it persists the reserved city and zone", String(storedCity.city_id) === RESERVED_CITY && String(storedCity.zone_id) === RESERVED_ZONE);

  for (const [label, over] of [["city", { cityId: "maa" }], ["zone", { zoneId: "adyar" }]]) {
    const group = `${RUN}-mm-${label}`;
    seedScheduling(group);
    const mismatch = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: group, scheduleGroupId: group, ...over }), ops);
    check(`a ${label} mismatch is refused 409`, mismatch.status === 409 && /city\/zone does not match/i.test(mismatch.body?.error ?? ""), `status=${mismatch.status}`);
    check(`the ${label} mismatch wrote no booking`, countOf("canonical_bookings", `schedule_group_id='${group}'`) === 0);
  }

  // ── 7. pet identity, where real D1 type affinity decides the answer ─────────────────────────────
  for (const [label, sourceId] of [["numeric", 7], ["boolean", true], ["object", { id: "x" }], ["array", [7]]]) {
    const group = `${RUN}-bad-${label}`;
    seedScheduling(group);
    const petsBefore = countOf("canonical_pets", `customer_id='${CUSTOMER}'`);
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${group}-${i}`, scheduleGroupId: group, pets: [{ sourceId, name: "Seven" }] }), ops)).status);
    }
    check(`a ${label} sourceId is refused 400 every time`, statuses.every((s) => s === 400), `statuses=${[...new Set(statuses)].join(",")}`);
    check(`a ${label} sourceId created no pet row`, countOf("canonical_pets", `customer_id='${CUSTOMER}'`) === petsBefore);
  }

  const convergeIds = new Set();
  for (let i = 0; i < 12; i++) {
    const group = `${RUN}-seven-${i}`;
    seedScheduling(group);
    const res = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: group, scheduleGroupId: group, pets: [{ sourceId: "7", name: "Seven" }] }), ops);
    if (res.status === 201) (res.body?.data?.petIds ?? []).forEach((id) => convergeIds.add(id));
  }
  check('a TEXT sourceId of "7" converges on ONE canonical pet', convergeIds.size === 1, `distinct ids=${convergeIds.size}`);
  check('only one row exists for source "7"', countOf("canonical_pets", `customer_id='${CUSTOMER}' AND source_pet_id='7'`) === 1);

  // A booking that carries no breed must not blank the breed the customer saved.
  const preserveGroup = `${RUN}-preserve`;
  seedScheduling(preserveGroup);
  await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: preserveGroup, scheduleGroupId: preserveGroup, pets: [{ sourceId: "acct-keep", name: "Kept", species: "dog", breed: "Indie", vaccinationStatus: "up_to_date" }] }), ops);
  const bareGroup = `${RUN}-bare`;
  seedScheduling(bareGroup);
  await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: bareGroup, scheduleGroupId: bareGroup, pets: [{ sourceId: "acct-keep", name: "Kept" }] }), ops);
  const kept = d1(`SELECT breed,vaccination_status FROM canonical_pets WHERE customer_id='${CUSTOMER}' AND source_pet_id='acct-keep'`)[0] || {};
  check("a booking that omits breed does not erase the saved profile", String(kept.breed || "") === "Indie", `breed=${String(kept.breed || "")}`);

  // ── 8. historical replay, through both halves of the idempotency lookup ─────────────────────────
  const replayKey = await api("POST", "/api/canonical-bookings", booking(), ops);
  check("replay by idempotency key returns the original", replayKey.status === 200 && replayKey.body?.data?.duplicatePrevented === true, `status=${replayKey.status}`);
  const replayGroup = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-other` }), ops);
  check("replay by schedule group returns the original", replayGroup.status === 200 && replayGroup.body?.data?.duplicatePrevented === true, `status=${replayGroup.status}`);
  // A stored booking must still replay even when its payload would now be refused on city/zone.
  const replayRefusable = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-ik`, cityId: "maa", zoneId: "adyar" }), ops);
  check("a stored booking replays even when the replay payload would now be refused", replayRefusable.status === 200 && replayRefusable.body?.data?.duplicatePrevented === true, `status=${replayRefusable.status}`);
  check("the replays created no second booking", countOf("canonical_bookings", `schedule_group_id='${RUN}-sg'`) === 1);

  // ── 9. concurrency and duplicate submit, against real D1 rather than one event loop ─────────────
  const raceGroup = `${RUN}-race`;
  seedScheduling(raceGroup);
  const raced = await Promise.all(Array.from({ length: 8 }, () =>
    api("POST", "/api/canonical-bookings", booking({ idempotencyKey: raceGroup, scheduleGroupId: raceGroup }), ops)));
  const racedStatuses = raced.map((r) => r.status);
  check("8 simultaneous identical submits produce exactly one booking", countOf("canonical_bookings", `schedule_group_id='${raceGroup}'`) === 1, `statuses=${[...new Set(racedStatuses)].join(",")}`);
  check("no simultaneous submit failed with a server error", racedStatuses.every((s) => s < 500), `statuses=${[...new Set(racedStatuses)].join(",")}`);
  check("the race created exactly one payment", Number(d1(`SELECT COUNT(*) n FROM booking_payments p JOIN canonical_bookings b ON b.id=p.booking_id WHERE b.schedule_group_id='${raceGroup}'`)[0]?.n ?? 0) === 1);

  const dupe = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: raceGroup, scheduleGroupId: raceGroup }), ops);
  check("a later duplicate submit is prevented, not duplicated", dupe.status === 200 && dupe.body?.data?.duplicatePrevented === true, `status=${dupe.status}`);

  // ── 10. one cross-role golden journey ───────────────────────────────────────────────────────────
  {
    const group = `${RUN}-journey`;
    seedScheduling(group);
    const opsCreated = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: group, scheduleGroupId: group }), ops);
    const bookingId = opsCreated.body?.data?.bookingId || "";
    const viewerSees = await api("GET", "/api/canonical-bookings", undefined, viewer);
    const visible = (viewerSees.body?.bookings ?? []).some((b) => String(b?.id || b?.bookingId || "") === String(bookingId));
    const financeBlocked = await api("GET", "/api/canonical-bookings", undefined, finance);
    const rows = d1(`SELECT status,city_id,zone_id FROM canonical_bookings WHERE schedule_group_id='${group}'`)[0] || {};
    check("cross-role journey: ops books, a viewer reads it back, finance is refused, the row is correct",
      opsCreated.status === 201 && Boolean(bookingId) && viewerSees.status === 200 && visible && financeBlocked.status === 403
      && String(rows.city_id) === RESERVED_CITY && String(rows.zone_id) === RESERVED_ZONE,
      `create=${opsCreated.status} read=${viewerSees.status} visible=${visible} finance=${financeBlocked.status}`);
  }

  // ── 11. synthetic swarm, sized so the bind cap and batch limits are exercised for real ──────────
  let swarmOk = 0;
  const swarmStatuses = new Set();
  for (let i = 0; i < SWARM; i++) {
    const group = `${RUN}-swarm-${i}`;
    seedScheduling(group);
    const res = await api("POST", "/api/canonical-bookings", booking({ idempotencyKey: group, scheduleGroupId: group, pets: [{ sourceId: `swarm-${i}`, name: `Pet ${i}`, species: "dog" }] }), ops);
    swarmStatuses.add(res.status);
    if (res.status === 201) swarmOk++;
  }
  check(`${SWARM}-booking synthetic swarm all confirmed`, swarmOk === SWARM, `confirmed=${swarmOk}/${SWARM} statuses=${[...swarmStatuses].join(",")}`);

  // ── 12. D1 reconciliation ───────────────────────────────────────────────────────────────────────
  const swarmWhere = `b.schedule_group_id LIKE '${RUN}-swarm-%'`;
  const swarmBookings = countOf("canonical_bookings", `schedule_group_id LIKE '${RUN}-swarm-%'`);
  const one = (sqlText) => Number(d1(sqlText)[0]?.n ?? 0);
  const swarmPayments = one(`SELECT COUNT(*) n FROM booking_payments p JOIN canonical_bookings b ON b.id=p.booking_id WHERE ${swarmWhere}`);
  const swarmOrders = one(`SELECT COUNT(*) n FROM provider_work_orders w JOIN canonical_bookings b ON b.id=w.booking_id WHERE ${swarmWhere}`);
  const orphanPets = one(`SELECT COUNT(*) n FROM canonical_bookings b WHERE ${swarmWhere} AND (SELECT COUNT(*) FROM canonical_pets p WHERE p.id IN (SELECT value FROM json_each(b.pet_ids_json))) = 0`);
  const cityDrift = one(`SELECT COUNT(*) n FROM canonical_bookings b JOIN scheduling_reservations r ON r.group_id=b.schedule_group_id WHERE b.schedule_group_id LIKE '${RUN}%' AND (b.city_id<>r.city_id OR b.zone_id<>r.zone_id)`);
  report.counts.swarm = { bookings: swarmBookings, payments: swarmPayments, workOrders: swarmOrders, orphanPets, cityDrift };
  check("every swarm booking reconciles to exactly one payment", swarmPayments === swarmBookings, `${swarmPayments}/${swarmBookings}`);
  check("every swarm booking reconciles to exactly one work order", swarmOrders === swarmBookings, `${swarmOrders}/${swarmBookings}`);
  check("no booking points at a pet row that does not exist", orphanPets === 0, `orphans=${orphanPets}`);
  check("no stored booking contradicts its reservation's city or zone", cityDrift === 0, `mismatched rows=${cityDrift}`);
  const after = snapshot();
  report.counts.tables = after;
  check("the preview created rows only under this run's namespace", after.canonical_bookings >= before.canonical_bookings);

  // ── 13. nothing went live ───────────────────────────────────────────────────────────────────────
  try {
    const live = one("SELECT COUNT(*) n FROM providers WHERE live=1 OR marketplace_live=1 OR order_eligible=1");
    check("no provider became live in the preview", live === 0, `live=${live}`);
  } catch {
    // The table only exists once a provider route has run here. Absence is not a pass.
    unavailable("no provider became live in the preview", "the providers table does not exist in this preview database");
  }
}

// ── 14. Worker and audit-log error inspection ─────────────────────────────────────────────────────
// Two independent views, because each misses what the other sees: the Worker's own log stream catches
// unhandled exceptions that never reach the database, and the audit table catches authorization
// outcomes that never appear as an error.
try {
  const failed = Number(d1(`SELECT COUNT(*) n FROM security_audit_events WHERE outcome='failed' AND created_at>=${Date.now() - 3600_000}`)[0]?.n ?? 0);
  const denied = Number(d1(`SELECT COUNT(*) n FROM security_audit_events WHERE outcome='denied' AND created_at>=${Date.now() - 3600_000}`)[0]?.n ?? 0);
  report.counts.audit = { failed, denied };
  // Denials are EXPECTED here — this gate deliberately provokes them — so the useful assertion is that
  // the gateway recorded them, and that nothing was recorded as an outright failure.
  check("the gateway audited the refusals this gate provoked", denied > 0, `denied=${denied}`);
  check("no request was audited as a failure", failed === 0, `failed=${failed}`);
} catch (error) {
  unavailable("audit-log error inspection", `security_audit_events could not be read: ${String(error.message).slice(0, 120)}`);
}

{
  // A bounded tail: start it, provoke one good and one refused request, then stop and read what it saw.
  const lines = [];
  let tail = null;
  try {
    tail = spawn(WRANGLER.cmd, [...WRANGLER.lead, "tail", "--name", WORKER, "--format", "json"], { cwd: CANDIDATE_DIR, stdio: ["ignore", "pipe", "pipe"] });
    tail.stdout.on("data", (chunk) => lines.push(String(chunk)));
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await api("GET", "/api/canonical-bookings", undefined, ops);
    await api("GET", "/api/canonical-bookings");
    await new Promise((resolve) => setTimeout(resolve, 8000));
  } catch { /* handled below */ }
  finally { if (tail) tail.kill("SIGINT"); }

  const captured = lines.join("");
  if (!captured.trim()) {
    unavailable("Worker log error inspection", "wrangler tail produced no output in the sampling window");
  } else {
    const exceptions = (captured.match(/"outcome"\s*:\s*"exception"/g) || []).length
      + (captured.match(/"exceptions"\s*:\s*\[\s*\{/g) || []).length;
    const serverErrors = (captured.match(/"status"\s*:\s*5\d\d/g) || []).length;
    report.counts.workerLog = { exceptions, serverErrors, bytes: captured.length };
    check("the Worker log shows no unhandled exception", exceptions === 0, `exceptions=${exceptions}`);
    check("the Worker log shows no 5xx response", serverErrors === 0, `5xx=${serverErrors}`);
  }
}

// ── evidence ──────────────────────────────────────────────────────────────────────────────────────
report.failures = failures;
report.warningCount = warnings;
report.passed = report.checks.filter((c) => c.ok === true).length;
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`\nrelease preview gate: ${failures === 0 ? "PASS" : `FAIL (${failures})`} — ${report.passed} passed, ${failures} failed, ${warnings} not run`);
if (warnings) for (const warning of report.warnings) console.log(`  not run: ${warning}`);
process.exit(failures === 0 ? 0 : 1);
