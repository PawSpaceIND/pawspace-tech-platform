/**
 * The preview/UAT verification gate, run ENTIRELY inside the GitHub Actions runner against the
 * deployed release-preview Worker and its isolated real D1.
 *
 * It exists because the local suites prove the handler's logic against a node:sqlite shim, and a shim
 * is not D1: type affinity, transaction semantics and the bind cap are all modelled rather than
 * observed. The cases below are the ones whose answers could differ on the real database.
 *
 * The gate is a FUNCTION over adapters — `http`, `d1`, `ddl`, `hostedSha`, `workerLog` — rather than a
 * script that reaches for the network directly. That is not decoration: a gate nobody can test is a gate
 * nobody can trust, and the first version of this file shipped four defects that no amount of reading
 * caught. Injecting the adapters lets tests/release-preview-gate-behavior.test.mjs drive it against
 * mocks and prove that a misplaced snapshot, a partial success or a sequential "swarm" actually fails.
 *
 * MANDATORY EVIDENCE. Every check here is required. A hosted-sha, authentication, schema, D1,
 * reconciliation or log check that cannot be RUN fails the gate; there is deliberately no outcome that
 * records "not run" and still exits zero. An unavailable check is indistinguishable from an unverified
 * release, and a release gate that reports success for an unverified release is worse than no gate.
 *
 * NOTHING SENSITIVE LEAVES THIS JOB. The access code, session cookies, the API token and the database
 * id are read from the environment, held in locals, and never written to the report, echoed, or put in
 * a failure message. The report records statuses, counts and booking identifiers only.
 */
import { writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

/** The five tables a booking writes. A refusal must change none of them. */
export const TOUCHED_TABLES = [
  "canonical_bookings",
  "canonical_pets",
  "booking_payments",
  "provider_work_orders",
  "booking_lifecycle_events",
];

/**
 * Tables the gate must SEED before it can drive anything, and which a freshly created preview database
 * does not have. `/api/canonical-bookings` creates the tables it owns on first request; these belong to
 * routes the gate never calls, so seeding a staff identity or a reservation into a new preview database
 * fails on "no such table" before the first booking is ever attempted.
 */
export const SUPPORT_TABLES = [
  "app_users",
  "role_definitions",
  "customer_identity_links",
  "scheduling_assignment_decisions",
  "scheduling_reservations",
];

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
 * The one `CREATE TABLE IF NOT EXISTS <table> (...)` statement in a source file, parentheses balanced
 * rather than cut at the first `)` — which lands inside `DEFAULT (...)` and quoted defaults.
 *
 * The gate obtains its support schema this way instead of carrying its own copy. A second hardcoded
 * schema is a second definition to maintain, and it drifts silently from the one the deployed candidate
 * actually creates; extracted DDL is by construction the shape the deployed code expects.
 */
export function extractDdl(source, table) {
  const needle = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = source.indexOf(needle);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + needle.length - 1; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return null;
}

/** Search a checkout for a table's DDL. Returns null when the candidate does not define it. */
export function ddlFromCheckout(root, table) {
  const roots = ["app", "lib", "worker"].map((dir) => path.join(root, dir)).filter(existsSync);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry)) files.push(full);
    }
  };
  for (const dir of roots) walk(dir);
  for (const file of files) {
    const found = extractDdl(readFileSync(file, "utf8"), table);
    if (found) return found;
  }
  return null;
}

/**
 * The columns a DDL statement makes mandatory: `NOT NULL` without a `DEFAULT`. Used by the mock world so
 * an incomplete INSERT fails the way the real database fails it.
 */
export function requiredColumnsOf(ddl) {
  const inner = ddl.slice(ddl.indexOf("(") + 1, ddl.lastIndexOf(")"));
  const columns = [];
  let depth = 0, current = "";
  for (const char of inner) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) { columns.push(current); current = ""; continue; }
    current += char;
  }
  columns.push(current);
  return columns
    .map((c) => c.trim())
    .filter((c) => /NOT NULL/i.test(c) && !/DEFAULT/i.test(c))
    .map((c) => c.split(/\s+/)[0]);
}

/**
 * The role INSERT, as one exported statement builder.
 *
 * `role_definitions` requires name, description, permissions_json and updated_at. A row carrying only
 * `code` and `permissions_json` — which is what a competing implementation of this gate wrote — is
 * rejected by the real database, so sign-in would fail with a NOT NULL constraint error rather than an
 * authorization result. It is exported so a test can drive the real statement against the real DDL.
 */
export function roleDefinitionInsert(code, permissions, columns = null) {
  const values = {
    code,
    name: code,
    description: "release preview gate role",
    permissions_json: JSON.stringify(permissions),
    system_role: 0,
    updated_at: 1,
  };
  const chosen = columns ?? Object.keys(values);
  const literal = (key) => (typeof values[key] === "number" ? String(values[key]) : `'${String(values[key]).replace(/'/g, "''")}'`);
  return `INSERT OR REPLACE INTO role_definitions (${chosen.join(",")}) VALUES (${chosen.map(literal).join(",")})`;
}

/**
 * A run namespace that is unique per workflow run AND per re-run attempt, so two runs of the SAME
 * candidate sha never collide in one preview database. Sanitized to a safe, non-secret slug: it appears
 * in row ids, and a run tag carrying anything else would put it there too.
 */
export function sanitizeRunTag(raw) {
  const tag = String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return tag || null;
}

/**
 * @param {object} io
 * @param {(method:string, path:string, opts?:{headers?:object, body?:any}) => Promise<{status:number, body:any, headers?:object}>} io.http
 * @param {(sql:string) => Promise<Array<object>>} io.d1
 * @param {(table:string) => Promise<string|null>} io.ddl        support-table DDL, from the candidate
 * @param {() => Promise<string|null>} io.hostedSha              the deployed version marker
 * @param {() => Promise<string|null>} io.workerLog              a bounded sample of the Worker's log
 * @param {object} io.env   { EXPECTED_SHA, ACCESS_CODE, RUN_TAG }
 * @param {(line:string)=>void} [io.log]
 * @param {number} [io.swarmSize]
 * @param {number} [io.concurrency]
 */
export async function runGate({ http, d1, ddl, hostedSha, workerLog, env, log = console.log, swarmSize = 60, concurrency = 8 }) {
  const report = { sha: env.EXPECTED_SHA, checks: [], counts: {} };
  let failures = 0;
  const check = (name, ok, detail = "") => {
    report.checks.push({ name, ok, detail });
    if (!ok) failures++;
    log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    return ok;
  };
  /**
   * A required check that could not be RUN. It FAILS, and is recorded as unavailable so the reason is
   * legible. There is no third, softer outcome: see the header.
   */
  const unavailable = (name, reason) => {
    report.checks.push({ name, ok: false, detail: `NOT RUN: ${reason}`, unavailable: true });
    failures++;
    log(`  FAIL  ${name} — NOT RUN: ${reason}`);
    return false;
  };

  const runTag = sanitizeRunTag(env.RUN_TAG);
  if (!runTag) {
    // Refused rather than defaulted. A constant fallback namespace means two runs of the same candidate
    // sha write into each other's rows, and the second one's "duplicate prevented" is the first one's
    // booking.
    throw new Error("RUN_TAG is required and must contain at least one alphanumeric character: the gate namespaces every row it writes by it, and a shared namespace makes two runs of one sha collide.");
  }

  const RUN = `preview-${env.EXPECTED_SHA.slice(0, 8)}-${runTag}`;
  report.run = RUN;
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

  log(`Release preview gate — ${env.EXPECTED_SHA.slice(0, 8)} (run ${runTag})`);

  // ── the deployed sha, verified from inside the runner ───────────────────────────────────────
  //
  // Read back from the deployed version rather than served from a public endpoint: a version marker
  // anyone can fetch is a disclosure this gate does not need. Mandatory — a gate that cannot tell WHICH
  // build it just tested has verified nothing in particular.
  try {
    const marker = await hostedSha();
    if (!marker) unavailable("the hosted version marker carries the deployed sha", "the deployed version could not be read");
    else check("the hosted version marker carries the deployed sha", marker.includes(env.EXPECTED_SHA));
  } catch (error) {
    unavailable("the hosted version marker carries the deployed sha", String(error.message).slice(0, 160));
  }

  // ── the support schema a fresh preview database does not have ───────────────────────────────
  let schemaReady = true;
  for (const table of SUPPORT_TABLES) {
    try {
      const statement = await ddl(table);
      if (!statement) { schemaReady = unavailable(`support table ${table} is created from the candidate's DDL`, "the candidate defines no CREATE TABLE for it"); continue; }
      await d1(statement);
    } catch (error) {
      schemaReady = unavailable(`support table ${table} is created from the candidate's DDL`, String(error.message).slice(0, 160));
    }
  }
  check("every support table the gate seeds exists", schemaReady, `${SUPPORT_TABLES.length} tables`);
  if (!schemaReady) {
    // Nothing below can produce a real answer without them, and reporting refusals it did not earn is
    // exactly the failure mode this gate is built to avoid.
    report.failures = failures;
    report.schema = "unavailable";
    return report;
  }

  // ── real sessions, from the repository's own UAT sign-in ────────────────────────────────────
  //
  // Authorization is proved with REAL sessions, never with headers a client could invent. The roles are
  // seeded into the isolated preview database, signed in through /api/staging-login exactly as a tester
  // would, and the cookie that comes back is the one the Worker's own session layer minted.
  //
  // The request body uses `code`, which is the field app/api/staging-login/route.ts reads. Posting
  // `accessCode` returns 401 for every identity, and because the whole authorized half of this gate sits
  // behind sign-in, that single wrong field name makes every case below unreachable.
  const signIn = async (email) => {
    const res = await http("POST", "/api/staging-login", { body: { code: env.ACCESS_CODE, email } });
    const cookie = String(res.headers?.["set-cookie"] ?? res.headers?.get?.("set-cookie") ?? "").split(";")[0];
    return { ok: res.status >= 200 && res.status < 400 && Boolean(cookie), cookie, status: res.status };
  };
  const seedRole = async (code, permissions) => d1(roleDefinitionInsert(code, permissions));
  const seedUser = async (email, roleCode) =>
    d1(`INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-${roleCode}','${email}','${roleCode}','${roleCode}','active',1,1)`);
  const bindCustomer = async (email, customerId) =>
    d1(`INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES ('${email}','${customerId}','active',1,1)`);

  const as = (cookie) => (method, path, body) => http(method, path, { headers: { cookie }, body });

  // ── D — authorization, with real hosted sessions ────────────────────────────────────────────
  let sessionsOk = false;
  try {
    await seedRole("preview_viewer", ["bookings.view"]);
    await seedRole("preview_booker", ["bookings.view", "scheduling.book"]);
    await seedRole("preview_marketing", ["marketing.view"]);
    await seedUser("preview-viewer@pawspace.test", "preview_viewer");
    await seedUser("preview-booker@pawspace.test", "preview_booker");
    await seedUser("preview-marketing@pawspace.test", "preview_marketing");
    await bindCustomer("preview-booker@pawspace.test", CUSTOMER);
    sessionsOk = true;
  } catch (error) {
    unavailable("the preview staff directory is seeded", String(error.message).slice(0, 200));
  }

  const viewer = sessionsOk ? await signIn("preview-viewer@pawspace.test") : { ok: false, status: 0, cookie: "" };
  const booker = sessionsOk ? await signIn("preview-booker@pawspace.test") : { ok: false, status: 0, cookie: "" };
  const marketing = sessionsOk ? await signIn("preview-marketing@pawspace.test") : { ok: false, status: 0, cookie: "" };
  sessionsOk = check("real UAT sessions were established for all three roles",
    viewer.ok && booker.ok && marketing.ok, `viewer=${viewer.status} booker=${booker.status} marketing=${marketing.status}`);

  if (!sessionsOk) {
    // Without real sessions the authorization results below would be meaningless, and a gate that
    // reports "refused" because sign-in broke is worse than one that stops.
    report.failures = failures;
    report.authHarness = "unavailable";
    return report;
  }

  // ── C — refusals that are earned, and proved zero-write across all five tables ──────────────
  //
  // Anonymous first, and with a payload that is otherwise entirely valid against a reservation that
  // really exists: refusing a request that would have been refused anyway proves nothing about
  // authorization. The only thing missing from these requests is a session.
  await seedScheduling(`${RUN}-anon`);
  {
    const anonGet = await http("GET", "/api/canonical-bookings", {});
    check("an anonymous GET is refused", anonGet.status === 401 || anonGet.status === 403, `status=${anonGet.status}`);
    check("the anonymous refusal discloses no booking, customer or provider data",
      anonGet.body?.bookings === undefined && !/customer_id|provider_id/.test(JSON.stringify(anonGet.body ?? "")));

    const before = await snapshot();
    const anonPost = await http("POST", "/api/canonical-bookings", { body: booking({ idempotencyKey: `${RUN}-anon`, scheduleGroupId: `${RUN}-anon` }) });
    const after = await snapshot();
    check("an anonymous POST with an otherwise valid payload is refused",
      anonPost.status === 401 || anonPost.status === 403, `status=${anonPost.status}`);
    check("the anonymous POST wrote nothing across all five tables",
      JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
  {
    // Identity is the session's to assert, never the client's. These headers are exactly what an
    // attacker would try, and the localhost-shaped host header is what would flip a dev-preview bypass.
    const before = await snapshot();
    const forged = await http("POST", "/api/canonical-bookings", {
      headers: {
        "oai-authenticated-user-email": "preview-booker@pawspace.test",
        "x-pawspace-role": "founder",
        "x-forwarded-host": "localhost",
      },
      body: booking({ idempotencyKey: `${RUN}-forged`, scheduleGroupId: `${RUN}-anon` }),
    });
    const after = await snapshot();
    check("forged identity and role headers cannot manufacture authorization",
      forged.status === 401 || forged.status === 403, `status=${forged.status}`);
    check("the forged-header POST wrote nothing across all five tables", JSON.stringify(before) === JSON.stringify(after));
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
    // NON-VACUOUS wrong owner. The reservation exists, is for OTHER_CUSTOMER, and this request uses
    // exactly that customer and that group — so nothing downstream has grounds to refuse it. The only
    // reason it must not succeed is that this session's identity binding is for a different customer,
    // and the status has to be 403 rather than "some error": a 409 here would mean the ownership rule
    // was never reached and the check proves nothing.
    await seedScheduling(`${RUN}-owner`, { customer: OTHER_CUSTOMER });
    const before = await snapshot();
    const wrongOwner = await as(booker.cookie)("POST", "/api/canonical-bookings",
      booking({ idempotencyKey: `${RUN}-owner`, scheduleGroupId: `${RUN}-owner`, customer: { id: OTHER_CUSTOMER, name: "Someone else", primaryPhone: "+919000000901" } }));
    check("POST for a customer this session does not own is refused 403", wrongOwner.status === 403, `status=${wrongOwner.status}`);
    check("a wrong-owner POST wrote nothing", JSON.stringify(before) === JSON.stringify(await snapshot()));
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

  // Provider activation. Mandatory, and NOT swallowed: a table this gate cannot read is a claim it
  // cannot make, and "no provider went live" is precisely the claim nobody should take on trust.
  try {
    const live = await countOf("providers", "live=1 OR marketplace_live=1 OR order_eligible=1");
    check("no provider became live in the preview", live === 0, `live=${live}`);
  } catch (error) {
    unavailable("no provider became live in the preview", String(error.message).slice(0, 160));
  }

  // ── the Worker's own log, which sees what the database cannot ───────────────────────────────
  //
  // An unhandled exception can be thrown and returned as a 500 without ever reaching D1, so the audit
  // tables would show nothing. Mandatory for the same reason as everything else here.
  try {
    const captured = await workerLog();
    if (captured === null || captured === undefined) unavailable("the Worker log shows no unhandled exception or 5xx", "the Worker log could not be sampled");
    else {
      const exceptions = (captured.match(/"outcome"\s*:\s*"exception"/g) || []).length + (captured.match(/"exceptions"\s*:\s*\[\s*\{/g) || []).length;
      const serverErrors = (captured.match(/"status"\s*:\s*5\d\d/g) || []).length;
      report.counts.workerLog = { exceptions, serverErrors, bytes: captured.length };
      check("the Worker log shows no unhandled exception or 5xx", exceptions === 0 && serverErrors === 0, `exceptions=${exceptions} 5xx=${serverErrors}`);
    }
  } catch (error) {
    unavailable("the Worker log shows no unhandled exception or 5xx", String(error.message).slice(0, 160));
  }

  report.failures = failures;
  report.unavailable = report.checks.filter((c) => c.unavailable).map((c) => c.name);
  return report;
}

// ── CLI: wire the real adapters. Only reached when this file is executed, never when imported. ──
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const WORKER = process.env.PREVIEW_WORKER || "";
  const EXPECTED_SHA = process.env.EXPECTED_SHA || "";
  const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
  const PREVIEW_D1 = process.env.PREVIEW_D1 || "";
  const CANDIDATE_DIR = process.env.CANDIDATE_DIR || process.cwd();
  // Required, with no fallback: the namespace has to differ between two runs of the same candidate sha,
  // including a re-run of the same workflow run, and only the runner knows those numbers.
  const RUN_TAG = sanitizeRunTag(process.env.RUN_TAG);
  const missing = [
    ["PREVIEW_WORKER", WORKER], ["EXPECTED_SHA", EXPECTED_SHA], ["PAWSPACE_UAT_ACCESS_CODE", ACCESS_CODE],
    ["PREVIEW_D1", PREVIEW_D1], ["RUN_TAG", RUN_TAG],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    // Names only, never values.
    console.error(`release-preview gate: required environment is not configured (${missing.join(", ")}).`);
    process.exit(1);
  }
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

  const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], {
    cwd: CANDIDATE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
  });

  // Addressed by database ID, so a reconciliation read cannot land on another database.
  const d1 = async (sql) => {
    const out = wrangler(["d1", "execute", PREVIEW_D1, "--remote", "--json", "--command", sql]);
    const parsed = JSON.parse(out);
    return parsed?.[0]?.results ?? parsed?.result?.[0]?.results ?? [];
  };

  // The candidate's OWN definition of each support table, never a copy kept here.
  const ddl = async (table) => ddlFromCheckout(CANDIDATE_DIR, table);

  const hostedSha = async () => {
    try { return wrangler(["versions", "list", "--name", WORKER, "--json"]); }
    catch { return wrangler(["deployments", "list", "--name", WORKER]); }
  };

  /** A bounded sample of the Worker's log, taken while two requests are driven through it. */
  const workerLog = async () => {
    const chunks = [];
    let tail = null;
    try {
      tail = spawn("npx", ["wrangler", "tail", "--name", WORKER, "--format", "json"], { cwd: CANDIDATE_DIR, stdio: ["ignore", "pipe", "pipe"] });
      tail.stdout.on("data", (chunk) => chunks.push(String(chunk)));
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await http("GET", "/api/canonical-bookings");
      await new Promise((resolve) => setTimeout(resolve, 8000));
    } finally { if (tail) tail.kill("SIGINT"); }
    const captured = chunks.join("");
    return captured.trim() ? captured : null;
  };

  const report = await runGate({ http, d1, ddl, hostedSha, workerLog, env: { EXPECTED_SHA, ACCESS_CODE, RUN_TAG } });
  writeFileSync("release-preview-report.json", JSON.stringify(report, null, 2));
  const passed = report.failures === 0 && report.authHarness !== "unavailable" && report.schema !== "unavailable";
  console.log(`\nrelease preview gate: ${passed ? "PASS" : "FAIL"}`);
  if (report.unavailable?.length) for (const name of report.unavailable) console.log(`  could not run (counted as a failure): ${name}`);
  process.exit(passed ? 0 : 1);
}
