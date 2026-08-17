/**
 * The preview/UAT verification gate, run ENTIRELY inside the GitHub Actions runner against the
 * deployed release-preview Worker and its isolated real D1.
 *
 * It exists because the local suites prove the handler's logic against a node:sqlite shim, and a shim
 * is not D1: type affinity, transaction semantics and the bind cap are all modelled rather than
 * observed. The cases below are the ones whose answers could differ on the real database.
 *
 * The gate is a FUNCTION over two adapters — `http` and `d1` — rather than a script that reaches for
 * the network directly. That is not decoration: a gate nobody can test is a gate nobody can trust, and
 * the first version of this file shipped four defects that no amount of reading caught. Injecting the
 * adapters lets tests/release-preview-gate-behavior.test.mjs drive it against mocks and prove that a
 * misplaced snapshot, a partial success or a sequential "swarm" actually fails.
 *
 * NOTHING SENSITIVE LEAVES THIS JOB. The access code, session cookies, the API token and the database
 * id are read from the environment, held in locals, and never written to the report, echoed, or put in
 * a failure message. The report records statuses, counts and booking identifiers only.
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** The five tables a booking writes. A refusal must change none of them. */
export const TOUCHED_TABLES = [
  "canonical_bookings",
  "canonical_pets",
  "booking_payments",
  "provider_work_orders",
  "booking_lifecycle_events",
];

/**
 * A run tag namespaces every identifier this gate creates, so a second run — a re-dispatch, or a
 * re-attempt of the same run — starts from a clean namespace instead of colliding with the first.
 * Without it the second run's bookings match the first run's idempotency keys and REPLAY, so the gate
 * silently stops testing creation and starts testing duplicate prevention.
 *
 * It is interpolated into SQL that builds test identifiers, so it is validated as a strict identifier
 * rather than trusted: letters, digits, hyphen and underscore only, and bounded.
 */
export const RUN_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function assertRunTag(tag) {
  if (!tag || !RUN_TAG_PATTERN.test(tag)) {
    throw new Error("PREVIEW_RUN_TAG must be a safe identifier: letters, digits, hyphen or underscore, 1-64 characters.");
  }
  return tag;
}

/** Run `tasks` with at most `limit` in flight, reporting the high-water mark actually reached. */
export async function boundedAll(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0, inFlight = 0, maxInFlight = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try { results[index] = await tasks[index](); }
      finally { inFlight--; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return { results, maxInFlight };
}

/**
 * @param {object} io
 * @param {(method:string, path:string, opts?:{headers?:object, body?:any}) => Promise<{status:number, body:any, headers?:object}>} io.http
 * @param {(sql:string) => Promise<Array<object>>} io.d1
 * @param {object} io.env   { EXPECTED_SHA, ACCESS_CODE }
 * @param {(line:string)=>void} [io.log]
 * @param {number} [io.swarmSize]
 * @param {number} [io.concurrency]
 */
export async function runGate({ http, d1, env, log = console.log, swarmSize = 60, concurrency = 8 }) {
  const report = { sha: env.EXPECTED_SHA, checks: [], counts: {} };
  let failures = 0;
  const check = (name, ok, detail = "") => {
    report.checks.push({ name, ok, detail });
    if (!ok) failures++;
    log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    return ok;
  };

  // No constant fallback: an unnamespaced run is the defect, not a convenience.
  const RUN = `preview-${env.EXPECTED_SHA.slice(0, 8)}-${assertRunTag(env.RUN_TAG)}`;
  report.runTag = env.RUN_TAG;
  const CUSTOMER = `${RUN}-CUS`, OTHER_CUSTOMER = `${RUN}-CUS2`, PROVIDER = `${RUN}-PRV`;
  const START = "2027-03-04T09:00:00.000Z", END = "2027-03-04T11:00:00.000Z";

  const countOf = async (table, where = "1=1") =>
    Number((await d1(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`))[0]?.n ?? 0);

  /** All five tables at one instant. Compared by value, so a single changed row fails. */
  const snapshot = async () => {
    const entries = [];
    for (const table of TOUCHED_TABLES) entries.push([table, await countOf(table)]);
    return Object.fromEntries(entries);
  };

  const seedScheduling = async (group, { city = "blr", zone = "koramangala", customer = CUSTOMER } = {}) => {
    await d1(`INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('${group}','balanced','[]','${PROVIDER}','assigned','preview','gate',1)`);
    await d1(`INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('RES-${group}','${group}','${PROVIDER}','pet_sitting','${city}','${zone}','${customer}','[]','${START}','${END}',1,1,NULL,'reserved','{}',1)`);
  };

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

  // ── real sessions, from the repository's own UAT sign-in ────────────────────────────────────
  //
  // Authorization is proved with REAL sessions, never with headers a client could invent. The roles
  // are seeded into the isolated preview database, signed in through /api/staging-login exactly as a
  // tester would, and the cookie that comes back is the one the Worker's own session layer minted.
  const signIn = async (email) => {
    // The route reads body.code — NOT body.accessCode. It also requires the email to be an active
    // staff record whose role has a definition, which is why the roles and users are seeded first.
    const res = await http("POST", "/api/staging-login", {
      body: { action: "login", code: env.ACCESS_CODE, email },
    });
    const cookie = String(res.headers?.["set-cookie"] ?? res.headers?.get?.("set-cookie") ?? "").split(";")[0];
    return { ok: res.status >= 200 && res.status < 400 && Boolean(cookie), cookie, status: res.status };
  };
  const seedRole = async (code, permissions) =>
    d1(`INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('${code}','${code}','preview gate','${JSON.stringify(permissions).replace(/'/g, "''")}',0,1)`);
  const seedUser = async (email, roleCode) =>
    d1(`INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-${roleCode}','${email}','${roleCode}','${roleCode}','active',1,1)`);
  const bindCustomer = async (email, customerId) =>
    d1(`INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES ('${email}','${customerId}','active',1,1)`);

  const as = (cookie) => (method, path, body) => http(method, path, { headers: { cookie }, body });

  log(`Release preview gate — ${env.EXPECTED_SHA.slice(0, 8)}`);

  // ── D — authorization, with real hosted sessions ────────────────────────────────────────────
  await seedRole("preview_viewer", ["bookings.view"]);
  await seedRole("preview_booker", ["bookings.view", "scheduling.book"]);
  await seedRole("preview_marketing", ["marketing.view"]);
  await seedUser("preview-viewer@pawspace.test", "preview_viewer");
  await seedUser("preview-booker@pawspace.test", "preview_booker");
  await seedUser("preview-marketing@pawspace.test", "preview_marketing");
  await bindCustomer("preview-booker@pawspace.test", CUSTOMER);

  // ── ANONYMOUS, before any session exists ───────────────────────────────────────────────────
  //
  // Run first and deliberately: once a cookie is in hand it is easy to write an "unauthenticated"
  // case that quietly carries one. The POST uses an otherwise-valid payload against a REAL seeded
  // reservation, so a refusal here is authorization and not a missing precondition.
  await seedScheduling(`${RUN}-anon`);
  {
    const anonGet = await http("GET", "/api/canonical-bookings");
    check("anonymous GET is refused", anonGet.status === 401 || anonGet.status === 403, `status=${anonGet.status}`);
    check("an anonymous GET discloses no bookings", anonGet.body?.bookings === undefined);

    const before = await snapshot();
    const anonPost = await http("POST", "/api/canonical-bookings", {
      body: booking({ idempotencyKey: `${RUN}-anon`, scheduleGroupId: `${RUN}-anon` }),
    });
    const after = await snapshot();
    check("anonymous POST is refused", anonPost.status === 401 || anonPost.status === 403, `status=${anonPost.status}`);
    check("an anonymous POST changed nothing across all five tables",
      JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }

  const viewer = await signIn("preview-viewer@pawspace.test");
  const booker = await signIn("preview-booker@pawspace.test");
  const marketing = await signIn("preview-marketing@pawspace.test");
  const sessionsOk = check("real UAT sessions were established for all three roles",
    viewer.ok && booker.ok && marketing.ok, `viewer=${viewer.status} booker=${booker.status} marketing=${marketing.status}`);

  if (!sessionsOk) {
    // Without real sessions the authorization results below would be meaningless, and a gate that
    // reports "refused" because sign-in broke is worse than one that stops.
    report.failures = failures;
    report.authHarness = "unavailable";
    return report;
  }

  check("GET succeeds with bookings.view", (await as(viewer.cookie)("GET", "/api/canonical-bookings")).status === 200);
  const noView = await as(marketing.cookie)("GET", "/api/canonical-bookings");
  check("GET fails without bookings.view", noView.status === 401 || noView.status === 403, `status=${noView.status}`);
  check("a refused GET discloses no booking data", noView.body?.bookings === undefined);

  {
    const before = await snapshot();
    const denied = await as(marketing.cookie)("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-noperm`, scheduleGroupId: `${RUN}-noperm` }));
    check("POST fails without scheduling.book", denied.status === 401 || denied.status === 403, `status=${denied.status}`);
    check("a refused POST wrote nothing", JSON.stringify(before) === JSON.stringify(await snapshot()));
  }
  {
    // NON-VACUOUS by construction: the scheduling decision and reservation are seeded FOR the other
    // customer and that exact group is used, so every precondition after ownership is satisfiable.
    // A 403 here is therefore the ownership layer and not a 409 for a reservation that never existed.
    // Exactly 403 is required — "any 4xx" would pass on precisely the failures this rules out.
    await seedScheduling(`${RUN}-owner`, { customer: OTHER_CUSTOMER });
    const before = await snapshot();
    const wrongOwner = await as(booker.cookie)("POST", "/api/canonical-bookings",
      booking({ idempotencyKey: `${RUN}-owner`, scheduleGroupId: `${RUN}-owner`, customer: { id: OTHER_CUSTOMER, name: "Someone else", primaryPhone: "+919000000901" } }));
    const after = await snapshot();
    check("POST fails for a different customer owner with exactly 403", wrongOwner.status === 403, `status=${wrongOwner.status}`);
    check("a wrong-owner POST changed nothing across all five tables",
      JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }

  const post = as(booker.cookie);
  await seedScheduling(`${RUN}-sg`);
  const created = await post("POST", "/api/canonical-bookings", booking());
  check("POST succeeds with scheduling.book and customer ownership", created.status === 201, `status=${created.status}`);

  // ── A — replay, snapshotted around the replay requests and nothing else ─────────────────────
  //
  // The snapshot must be taken IMMEDIATELY before the replay and immediately after. Taking it earlier
  // folds the successful booking above into the comparison, so a replay that wrote a row would still
  // look like a no-op as long as the totals happened to line up.
  {
    const replayBefore = await snapshot();
    const byKey = await post("POST", "/api/canonical-bookings", booking());
    const byGroup = await post("POST", "/api/canonical-bookings", booking({ idempotencyKey: `${RUN}-other-key` }));
    const replayAfter = await snapshot();
    check("replay by idempotency key returns the original booking",
      byKey.status === 200 && byKey.body?.data?.duplicatePrevented === true, `status=${byKey.status}`);
    check("replay by schedule group returns the original booking",
      byGroup.status === 200 && byGroup.body?.data?.duplicatePrevented === true, `status=${byGroup.status}`);
    check("both replays changed nothing across all five tables",
      JSON.stringify(replayBefore) === JSON.stringify(replayAfter),
      `${JSON.stringify(replayBefore)} -> ${JSON.stringify(replayAfter)}`);
  }
  {
    // A numeric source id would be REFUSED on a new booking. Against an existing idempotency key it
    // must still replay, because the identity rules run after the lookup — history stays replayable.
    const replayBefore = await snapshot();
    const numericReplay = await post("POST", "/api/canonical-bookings", booking({ pets: [{ sourceId: 7, name: "Bruno" }] }));
    const replayAfter = await snapshot();
    check("a numeric source id does not block historical replay",
      numericReplay.status === 200 && numericReplay.body?.data?.duplicatePrevented === true, `status=${numericReplay.status}`);
    check("that replay changed nothing either", JSON.stringify(replayBefore) === JSON.stringify(replayAfter));
  }

  // ── B — refused payloads, each snapshotted around its own request ───────────────────────────
  const refusals = [
    ["numeric sourceId", { pets: [{ sourceId: 7, name: "Seven" }] }, 400],
    ["boolean sourceId", { pets: [{ sourceId: true, name: "Seven" }] }, 400],
    ["object sourceId", { pets: [{ sourceId: { id: "x" }, name: "Seven" }] }, 400],
    ["array sourceId", { pets: [{ sourceId: [7], name: "Seven" }] }, 400],
    ["city/zone mismatch", { cityId: "maa", zoneId: "adyar" }, 409],
  ];
  for (const [label, over, expected] of refusals) {
    const group = `${RUN}-bad-${label.replace(/[^a-z0-9]/gi, "")}`;
    await seedScheduling(group);
    // Repeated, because the defect this guards against only appeared across successive requests.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await snapshot();
      const res = await post("POST", "/api/canonical-bookings", booking({ ...over, idempotencyKey: `${group}-${attempt}`, scheduleGroupId: group }));
      const after = await snapshot();
      const ok = res.status === expected && JSON.stringify(before) === JSON.stringify(after);
      if (!ok || attempt === 2) check(`${label} -> ${expected}, zero writes (attempt ${attempt + 1})`, ok, `status=${res.status}`);
      if (!ok) break;
    }
  }

  // ── C — the string form converges, and every request must succeed ───────────────────────────
  {
    const statuses = [], bound = new Set();
    for (let i = 0; i < 12; i++) {
      const group = `${RUN}-seven-${i}`;
      await seedScheduling(group);
      const res = await post("POST", "/api/canonical-bookings", booking({ idempotencyKey: group, scheduleGroupId: group, pets: [{ sourceId: "7", name: "Seven" }] }));
      statuses.push(res.status);
      for (const id of res.body?.data?.petIds ?? []) bound.add(id);
    }
    // All twelve, not "most" — a partial success hides exactly the failure this is looking for.
    check("all 12 string-\"7\" bookings returned 201", statuses.every((s) => s === 201), `statuses=${statuses.join(",")}`);
    check("they converged on exactly one canonical pet id", bound.size === 1, `distinct ids=${bound.size}`);
    check("exactly one canonical_pets row exists for that source",
      (await countOf("canonical_pets", `customer_id='${CUSTOMER}' AND source_pet_id='7'`)) === 1);
  }

  // ── E — the saved profile is bound and preserved ────────────────────────────────────────────
  {
    const petId = `${RUN}-PET-BRUNO`;
    await d1(`INSERT OR REPLACE INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES ('${petId}','${CUSTOMER}','Bruno','dog','Labrador Retriever','verified','acct-bruno',1,1)`);
    const group = `${RUN}-bruno`;
    await seedScheduling(group);
    const res = await post("POST", "/api/canonical-bookings", booking({ idempotencyKey: group, scheduleGroupId: group, pets: [{ sourceId: "acct-bruno", name: "Bruno" }] }));
    check("the Bruno booking succeeded", res.status === 201, `status=${res.status}`);
    check("it bound the SAVED canonical row", (res.body?.data?.petIds ?? []).includes(petId), `petIds=${JSON.stringify(res.body?.data?.petIds)}`);
    const row = (await d1(`SELECT breed,vaccination_status FROM canonical_pets WHERE id='${petId}'`))[0];
    check("breed and verification status are unchanged",
      row?.breed === "Labrador Retriever" && row?.vaccination_status === "verified", JSON.stringify(row));
    const listed = await as(viewer.cookie)("GET", "/api/canonical-bookings");
    const shown = (listed.body?.bookings ?? []).flatMap((b) => b.pets ?? []).find((p) => p.id === petId);
    check("the list response displays them", shown?.breed === "Labrador Retriever" && shown?.vaccination_status === "verified", JSON.stringify(shown));
  }

  // ── F — swarm and reconciliation ────────────────────────────────────────────────────────────
  {
    // Every scheduling group is seeded FIRST, so the concurrent phase is bookings and nothing else.
    const groups = Array.from({ length: swarmSize }, (_, i) => `${RUN}-swarm-${i}`);
    for (const group of groups) await seedScheduling(group);

    const { results, maxInFlight } = await boundedAll(
      groups.map((group, i) => () => post("POST", "/api/canonical-bookings",
        booking({ idempotencyKey: group, scheduleGroupId: group, pets: [{ sourceId: `swarm-${i}`, name: `Pet ${i}` }] }))),
      concurrency,
    );
    const statuses = results.map((r) => r?.status);
    const serverErrors = statuses.filter((s) => s >= 500);
    check(`${swarmSize}/${swarmSize} swarm bookings confirmed`, statuses.filter((s) => s === 201).length === swarmSize,
      `201s=${statuses.filter((s) => s === 201).length}/${swarmSize}`);
    check("no unexpected 5xx", serverErrors.length === 0, `5xx=${serverErrors.length}`);
    // Requests actually overlapped: a sequential loop reports a high-water mark of 1.
    check("the swarm really ran concurrently", maxInFlight > 1, `max in flight=${maxInFlight}`);
    report.counts.maxInFlight = maxInFlight;

    const like = `schedule_group_id LIKE '${RUN}-swarm-%'`;
    const bookings = await countOf("canonical_bookings", like);
    const payments = Number((await d1(`SELECT COUNT(*) n FROM booking_payments p JOIN canonical_bookings b ON b.id=p.booking_id WHERE b.${like}`))[0]?.n ?? 0);
    const orders = Number((await d1(`SELECT COUNT(*) n FROM provider_work_orders w JOIN canonical_bookings b ON b.id=w.booking_id WHERE b.${like}`))[0]?.n ?? 0);
    const events = Number((await d1(`SELECT COUNT(*) n FROM booking_lifecycle_events e JOIN canonical_bookings b ON b.id=e.booking_id WHERE b.${like}`))[0]?.n ?? 0);
    const duplicatePets = Number((await d1(`SELECT COUNT(*) n FROM (SELECT source_pet_id FROM canonical_pets WHERE customer_id='${CUSTOMER}' AND source_pet_id LIKE 'swarm-%' GROUP BY source_pet_id HAVING COUNT(*)>1)`))[0]?.n ?? 0);
    const orphanPayments = Number((await d1("SELECT COUNT(*) n FROM booking_payments p LEFT JOIN canonical_bookings b ON b.id=p.booking_id WHERE b.id IS NULL"))[0]?.n ?? 0);
    const orphanOrders = Number((await d1("SELECT COUNT(*) n FROM provider_work_orders w LEFT JOIN canonical_bookings b ON b.id=w.booking_id WHERE b.id IS NULL"))[0]?.n ?? 0);
    const orphanEvents = Number((await d1("SELECT COUNT(*) n FROM booking_lifecycle_events e LEFT JOIN canonical_bookings b ON b.id=e.booking_id WHERE b.id IS NULL"))[0]?.n ?? 0);

    report.counts.swarm = { bookings, payments, orders, events, duplicatePets, orphanPayments, orphanOrders, orphanEvents };
    check("every swarm booking has exactly one payment", payments === bookings, `${payments}/${bookings}`);
    check("every swarm booking has exactly one work order", orders === bookings, `${orders}/${bookings}`);
    check("every swarm booking has lifecycle events", events >= bookings, `${events} events for ${bookings} bookings`);
    check("no duplicate canonical pets", duplicatePets === 0, `duplicates=${duplicatePets}`);
    check("no orphan payments, work orders or events",
      orphanPayments === 0 && orphanOrders === 0 && orphanEvents === 0,
      `payments=${orphanPayments} orders=${orphanOrders} events=${orphanEvents}`);
  }

  const live = await countOf("providers", "live=1 OR marketplace_live=1 OR order_eligible=1").catch(() => 0);
  check("no provider became live in the preview", live === 0, `live=${live}`);

  report.failures = failures;
  return report;
}

// ── CLI: wire the real adapters. Only reached when this file is executed, never when imported. ──
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const WORKER = process.env.PREVIEW_WORKER || "";
  const EXPECTED_SHA = process.env.EXPECTED_SHA || "";
  const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
  const PREVIEW_D1 = process.env.PREVIEW_D1 || "";
  const RUN_TAG = process.env.PREVIEW_RUN_TAG || "";
  if (!WORKER || !EXPECTED_SHA || !ACCESS_CODE || !PREVIEW_D1 || !RUN_TAG) {
    console.error("release-preview gate: required environment is not configured (PREVIEW_WORKER, EXPECTED_SHA, PAWSPACE_UAT_ACCESS_CODE, PREVIEW_D1, PREVIEW_RUN_TAG).");
    process.exit(1);
  }
  // Validated before it reaches any generated SQL, and never defaulted: a constant tag would make
  // every re-run replay the previous one's bookings instead of creating its own.
  try { assertRunTag(RUN_TAG); }
  catch (error) { console.error(`release-preview gate: ${error.message}`); process.exit(1); }
  const BASE = process.env.PREVIEW_URL || `https://${WORKER}.workers.dev`;

  const http = async (method, path, { headers = {}, body } = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = JSON.parse(await res.text()); } catch { /* non-JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  // Addressed by database ID, so a reconciliation read cannot land on another database.
  const d1 = async (sql) => {
    const out = execFileSync("npx", ["wrangler", "d1", "execute", PREVIEW_D1, "--remote", "--json", "--command", sql], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    return parsed?.[0]?.results ?? parsed?.result?.[0]?.results ?? [];
  };

  const report = await runGate({ http, d1, env: { EXPECTED_SHA, ACCESS_CODE, RUN_TAG } });
  writeFileSync("release-preview-report.json", JSON.stringify(report, null, 2));
  console.log(`\nrelease preview gate: ${report.failures === 0 && report.authHarness !== "unavailable" ? "PASS" : "FAIL"}`);
  process.exit(report.failures === 0 && report.authHarness !== "unavailable" ? 0 : 1);
}
