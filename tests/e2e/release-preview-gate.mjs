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
import { writeFileSync, readFileSync, existsSync } from "node:fs";
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
 * Tables this gate must SEED before it can drive anything, and which a freshly created preview database
 * does not have. `/api/canonical-bookings` creates the tables it owns on first request; these belong to
 * routes the gate never calls, so seeding a staff identity or a reservation into a new preview database
 * fails on "no such table" before the first booking is ever attempted — and the failure reads as a
 * broken release candidate rather than a gate that never set itself up.
 */
export const SUPPORT_TABLES = [
  "app_users",
  "role_definitions",
  "customer_identity_links",
  "scheduling_assignment_decisions",
  "scheduling_reservations",
];

/**
 * EVERY table this gate touches before the product does — the five support tables above plus the ones it
 * reads. The support tables were the visible half of the problem, because seeding them throws. The other
 * half is quieter and just as fatal: `snapshot()` runs `SELECT COUNT(*)` over the five booking tables,
 * and the anonymous block takes its first snapshot before any request has reached the route, so on a
 * fresh database those SELECTs are "no such table" too. `canonical_customers` is here for the same
 * reason — the route upserts it on the first booking, and a preview whose customer table appears only
 * as a side effect of a request the gate may never get to make is not a bootstrapped preview.
 *
 * `providers` is deliberately absent. The gate only ever reads it, and F requires that read to be real:
 * a preview where no provider route has run has no providers table, and that is a genuine "not run".
 */
export const REQUIRED_TABLES = [
  "role_definitions",
  "app_users",
  "customer_identity_links",
  "scheduling_assignment_decisions",
  "scheduling_reservations",
  "canonical_customers",
  "canonical_pets",
  "canonical_bookings",
  "booking_payments",
  "provider_work_orders",
  "booking_lifecycle_events",
  // Not a table a booking writes, so deliberately not in TOUCHED_TABLES — but the deployed provider
  // module owns it, and a preview whose provider surface has no schema is not a whole preview.
  "canonical_providers",
];

/**
 * WHICH FILE IS ALLOWED TO DEFINE EACH TABLE.
 *
 * Not "the first file in the checkout that happens to contain a matching CREATE TABLE". This repository
 * declares these tables in many places — `canonical_bookings` in eight product files, `canonical_customers`
 * in eight with two genuinely different definitions — so a first-match search returns whatever the
 * directory walk reached first, which is a function of file naming rather than of what the deployed code
 * creates. Renaming a route could silently change the preview's schema.
 *
 * Each table is therefore mapped to the source that OWNS it — the one whose handler creates it in
 * production — and no other file may stand in:
 *
 *   the booking aggregate  -> app/api/canonical-bookings/route.ts, the route this gate exercises, so the
 *                             preview gets exactly the schema that route creates on a live request;
 *   identity and security  -> lib/server-auth.ts, which owns sign-in and the customer binding and is what
 *                             /api/staging-login actually runs through;
 *   scheduling             -> app/api/uat-scheduling/route.ts, the route that writes BOTH the assignment
 *                             decision and the reservation rows this gate stands in for.
 *                             app/api/provider-capacity-control/route.ts also declares
 *                             scheduling_reservations — identically, as it happens — but it only reserves
 *                             against capacity; the scheduling route is the owner, so it is the authority.
 */
export const AUTHORITATIVE_DDL_SOURCES = {
  role_definitions: "lib/server-auth.ts",
  app_users: "lib/server-auth.ts",
  customer_identity_links: "lib/server-auth.ts",
  scheduling_assignment_decisions: "app/api/uat-scheduling/route.ts",
  scheduling_reservations: "app/api/uat-scheduling/route.ts",
  canonical_customers: "app/api/canonical-bookings/route.ts",
  canonical_pets: "app/api/canonical-bookings/route.ts",
  canonical_bookings: "app/api/canonical-bookings/route.ts",
  booking_payments: "app/api/canonical-bookings/route.ts",
  provider_work_orders: "app/api/canonical-bookings/route.ts",
  booking_lifecycle_events: "app/api/canonical-bookings/route.ts",
  canonical_providers: "lib/partner-otp.ts",
};

/**
 * How the provider claim is made: the three variables scripts/release-preview-config.mjs writes into the
 * deployed artifact, read back off the deployed version. See the check itself for why it is not a table.
 */
export const PROVIDER_ACTIVATION_VARS = {
  PAWSPACE_PROVIDER_MARKETPLACE_LIVE: "false",
  PAWSPACE_PROVIDER_ORDER_ELIGIBLE: "false",
  PAWSPACE_PROVIDER_ACTIVATION: "uat_ready",
};

/** Whitespace- and case-insensitive form, so one schema written two ways compares as one schema. */
export function normalizeDdl(sql) {
  return sql.replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim().toLowerCase();
}

/**
 * Every complete `CREATE TABLE IF NOT EXISTS <table> ( … )` in a source, parentheses balanced rather than
 * cut at the first `)` — which lands inside `DEFAULT (...)` and `CHECK (x IN (...))`.
 *
 * Quoted runs are skipped, so a parenthesis inside a string literal cannot move the depth: the product
 * really does write `DEFAULT '{}'`, and a default of `')('` would otherwise truncate the statement at a
 * parenthesis that is data. A statement whose parentheses never close is counted as malformed rather
 * than silently dropped, because "found nothing" and "found something broken" need different answers.
 */
export function extractAllDdl(source, table) {
  const opener = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+["'\`]?${table}["'\`]?\\s*\\(`, "gi");
  const statements = [];
  let malformed = 0;
  let match;
  while ((match = opener.exec(source))) {
    let depth = 0, end = -1;
    for (let i = match.index + match[0].length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === "'" || ch === '"' || ch === "`") {
        const quote = ch;
        i++;
        while (i < source.length) {
          if (source[i] === "\\") { i += 2; continue; }
          if (source[i] === quote) { if (source[i + 1] === quote) { i += 2; continue; } break; }
          i++;
        }
        if (i >= source.length) break;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) malformed++;
    else statements.push(source.slice(match.index, end));
  }
  return { statements, malformed };
}

/**
 * The ONE definition of a table in a source. `null` when the source does not define it; THROWS when it
 * defines it two different ways or defines it unparseably.
 *
 * Failing closed here matters more than it looks. Every alternative — take the first, take the longest,
 * take the one with the most columns — invents a preview schema nobody wrote, and the run that follows
 * looks like a passing test of the release candidate.
 */
export function extractDdl(source, table) {
  const { statements, malformed } = extractAllDdl(source, table);
  if (malformed) throw new Error(`${table}: a CREATE TABLE statement does not parse — unbalanced parentheses`);
  if (!statements.length) return null;
  // First occurrence wins among IDENTICAL spellings, so the returned text is stable rather than
  // depending on which formatting happened to appear last. Genuinely different definitions still throw.
  const distinct = new Map();
  for (const sql of statements) {
    const key = normalizeDdl(sql);
    if (!distinct.has(key)) distinct.set(key, sql);
  }
  if (distinct.size > 1) {
    throw new Error(`${table}: ${distinct.size} different definitions in its authoritative source — refusing to guess which one the preview should have`);
  }
  return [...distinct.values()][0];
}

/** Nothing but a bare CREATE TABLE IF NOT EXISTS for the expected table may ever reach the database. */
export function assertCreateTableOnly(sql, table) {
  if (!new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+["'\`]?${table}["'\`]?\\s*\\(`, "i").test(sql)) {
    throw new Error(`${table}: extracted statement is not a CREATE TABLE IF NOT EXISTS for that table`);
  }
  if (sql.includes(";")) throw new Error(`${table}: extracted statement contains a statement terminator`);
  if (sql.includes("--") || sql.includes("/*")) throw new Error(`${table}: extracted statement contains a comment sequence`);
  if (!sql.trimEnd().endsWith(")")) throw new Error(`${table}: extracted statement does not end at a closing parenthesis`);
  if (!sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")")).trim()) throw new Error(`${table}: extracted statement declares no columns`);
  return sql;
}

/**
 * A table's DDL, from the single source mapped as its authority. Returns null when the candidate does not
 * define it there; throws when that source is ambiguous, unparseable, or yields something that is not a
 * plain CREATE TABLE. A definition in some other file is NOT a fallback — silently substituting one is
 * the failure this map exists to prevent.
 */
export function ddlFromCheckout(root, table) {
  const relative = AUTHORITATIVE_DDL_SOURCES[table];
  if (!relative) throw new Error(`${table}: no authoritative source is mapped for this table`);
  const file = path.join(root, ...relative.split("/"));
  if (!existsSync(file)) return null;
  const found = extractDdl(readFileSync(file, "utf8"), table);
  return found === null ? null : assertCreateTableOnly(found, table);
}

/**
 * The columns a DDL statement makes mandatory: `NOT NULL` without a `DEFAULT`. Used by the mock world so
 * an incomplete INSERT fails there the way the real database fails it.
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
 * The role INSERT, as one exported statement builder, so a test can drive the REAL statement against the
 * REAL extracted DDL. `role_definitions` requires name, description, permissions_json and updated_at; a
 * row carrying only `code` and `permissions_json` is rejected by the database, and sign-in then fails
 * with a constraint error rather than an authorization result.
 */
export function roleDefinitionInsert(code, permissions, columns = null) {
  const values = {
    code,
    name: code,
    description: "preview gate",
    permissions_json: JSON.stringify(permissions),
    system_role: 0,
    updated_at: 1,
  };
  const chosen = columns ?? Object.keys(values);
  const literal = (key) => (typeof values[key] === "number" ? String(values[key]) : `'${String(values[key]).replace(/'/g, "''")}'`);
  return `INSERT OR REPLACE INTO role_definitions (${chosen.join(",")}) VALUES (${chosen.map(literal).join(",")})`;
}

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
export async function runGate({ http, d1, ddl, hostedSha, workerLog, providerActivation, env, log = console.log, swarmSize = 60, concurrency = 8 }) {
  const report = { sha: env.EXPECTED_SHA, checks: [], counts: {} };
  let failures = 0;
  const check = (name, ok, detail = "") => {
    report.checks.push({ name, ok, detail });
    if (!ok) failures++;
    log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    return ok;
  };
  /**
   * A REQUIRED check that could not be run. It fails, and is recorded as unavailable so the reason stays
   * legible. There is deliberately no softer third outcome: a check nobody could run is indistinguishable
   * from an unverified release, and a gate that reports success for an unverified release is worse than
   * no gate. This is also why nothing here swallows an error into a passing zero.
   */
  const unavailable = (name, reason) => {
    report.checks.push({ name, ok: false, detail: `NOT RUN: ${reason}`, unavailable: true });
    failures++;
    log(`  FAIL  ${name} — NOT RUN: ${reason}`);
    return false;
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
  // The statement lives in roleDefinitionInsert so a test can drive the real thing against the real
  // extracted DDL, and so the incomplete two-column shape can be shown to be rejected.
  const seedRole = async (code, permissions) => d1(roleDefinitionInsert(code, permissions));
  const seedUser = async (email, roleCode) =>
    d1(`INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-${roleCode}','${email}','${roleCode}','${roleCode}','active',1,1)`);
  const bindCustomer = async (email, customerId) =>
    d1(`INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES ('${email}','${customerId}','active',1,1)`);

  const as = (cookie) => (method, path, body) => http(method, path, { headers: { cookie }, body });

  log(`Release preview gate — ${env.EXPECTED_SHA.slice(0, 8)}`);

  // ── the deployed sha, verified from inside the runner ───────────────────────────────────────
  //
  // Read back from the deployed version rather than served from a public endpoint: a version marker
  // anyone can fetch is a disclosure this gate does not need. Required — a gate that cannot say WHICH
  // build it just exercised has verified nothing in particular, and the workflow step that checks this
  // separately cannot vouch for what the gate itself was talking to.
  try {
    const marker = await hostedSha();
    if (!marker) unavailable("the hosted version marker carries the deployed sha", "the deployed version could not be read");
    else check("the hosted version marker carries the deployed sha", String(marker).includes(env.EXPECTED_SHA));
  } catch (error) {
    unavailable("the hosted version marker carries the deployed sha", String(error.message).slice(0, 160));
  }

  // ── the support schema a freshly created preview database does not have ──────────────────────
  //
  // Created from the CANDIDATE's own DDL, before anything is seeded. Without this the very first seed
  // fails on "no such table" and every later result is either absent or meaningless.
  let schemaReady = true;
  for (const table of REQUIRED_TABLES) {
    try {
      const statement = await ddl(table);
      if (!statement) { schemaReady = unavailable(`table ${table} is created from the candidate's DDL`, "the candidate defines no CREATE TABLE for it in its authoritative source"); continue; }
      await d1(statement);
    } catch (error) {
      // Ambiguous, unparseable, or not a plain CREATE TABLE. All of them fail here rather than being
      // resolved by preference — a guessed schema produces a run that looks like a passing test.
      schemaReady = unavailable(`table ${table} is created from the candidate's DDL`, String(error.message).slice(0, 160));
    }
  }
  check("every table the gate reads or seeds exists", schemaReady, `${REQUIRED_TABLES.length} tables`);
  if (!schemaReady) {
    // Nothing below can produce a real answer, and reporting refusals it did not earn is exactly what
    // this gate must never do.
    report.failures = failures;
    report.schema = "unavailable";
    return report;
  }

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

  // Provider activation, from the deployed configuration.
  //
  // This check used to count rows in a table named for providers, filtered on three activation columns.
  // It swallowed its own error and substituted zero, which was the first defect. The second is worse: no
  // such table exists in this product. There are 47 provider-scoped tables and none is named that, and two
  // of those three columns appear in no file under app/, lib/, worker/ or drizzle/. So the read could only
  // ever have thrown against a real preview, or been answered by a mock that pre-created it — which is
  // exactly what the behavioural mock was doing. Made mandatory and left as it was, it would have failed
  // every dispatch forever, on a claim about a table nobody can create.
  //
  // What a preview CAN prove is what its own deploy controls: the provider-activation variables written
  // into the artifact by scripts/release-preview-config.mjs, read back off the deployed version. Mandatory
  // like everything else here. (The old query's shape is not written out: the behavioural suite greps for
  // it, and that guard should stay blunt.)
  try {
    const deployed = await providerActivation();
    if (!deployed) unavailable("the deployed preview has provider activation off", "the deployed configuration could not be read");
    else {
      const wrong = Object.entries(PROVIDER_ACTIVATION_VARS)
        .filter(([name, expected]) => String(deployed[name] ?? "") !== expected)
        .map(([name, expected]) => `${name}=${String(deployed[name] ?? "<unset>")} (want ${expected})`);
      report.counts.providerActivation = Object.fromEntries(
        Object.keys(PROVIDER_ACTIVATION_VARS).map((name) => [name, String(deployed[name] ?? "<unset>")]));
      check("the deployed preview has provider activation off", wrong.length === 0, wrong.join(", "));
    }
  } catch (error) {
    unavailable("the deployed preview has provider activation off", String(error.message).slice(0, 160));
  }

  // ── the Worker's own log, which sees what the database cannot ───────────────────────────────
  //
  // An unhandled exception can be thrown and returned as a 500 without ever reaching D1, so no amount of
  // row counting would show it. Required for the same reason as everything else here.
  try {
    const captured = await workerLog();
    if (captured === null || captured === undefined) unavailable("the Worker log shows no unhandled exception or 5xx", "the Worker log could not be sampled");
    else {
      const exceptions = (String(captured).match(/"outcome"\s*:\s*"exception"/g) || []).length
        + (String(captured).match(/"exceptions"\s*:\s*\[\s*\{/g) || []).length;
      const serverErrors = (String(captured).match(/"status"\s*:\s*5\d\d/g) || []).length;
      report.counts.workerLog = { exceptions, serverErrors, bytes: String(captured).length };
      check("the Worker log shows no unhandled exception or 5xx", exceptions === 0 && serverErrors === 0,
        `exceptions=${exceptions} 5xx=${serverErrors}`);
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
  const RUN_TAG = process.env.PREVIEW_RUN_TAG || "";
  const CANDIDATE_DIR = process.env.CANDIDATE_DIR || "";
  if (!WORKER || !EXPECTED_SHA || !ACCESS_CODE || !PREVIEW_D1 || !RUN_TAG || !CANDIDATE_DIR) {
    console.error("release-preview gate: required environment is not configured (PREVIEW_WORKER, EXPECTED_SHA, PAWSPACE_UAT_ACCESS_CODE, PREVIEW_D1, PREVIEW_RUN_TAG, CANDIDATE_DIR).");
    process.exit(1);
  }
  // Validated before it reaches any generated SQL, and never defaulted: a constant tag would make
  // every re-run replay the previous one's bookings instead of creating its own.
  try { assertRunTag(RUN_TAG); }
  catch (error) { console.error(`release-preview gate: ${error.message}`); process.exit(1); }
  const BASE = process.env.PREVIEW_URL || `https://${WORKER}.workers.dev`;
  // CANDIDATE_DIR is required above rather than defaulted to the working directory. The default would
  // usually have been right — the step runs with candidate/ as its cwd — but "usually right" is how the
  // schema ends up being read out of the INFRASTRUCTURE checkout the one time the cwd differs, and a
  // gate that silently bootstraps from the wrong tree is worse than one that refuses to start.
  const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
  });

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

  // The CANDIDATE's own definition of each support table, never a copy kept beside this gate.
  const ddl = async (table) => ddlFromCheckout(CANDIDATE_DIR, table);

  /** The deployed version's variables, which is where provider activation is actually decided. */
  const providerActivation = async () => {
    const parsed = JSON.parse(wrangler(["versions", "list", "--name", WORKER, "--json"]));
    const versions = Array.isArray(parsed) ? parsed : (parsed?.versions ?? parsed?.result ?? []);
    const latest = versions[0] ?? {};
    // wrangler has reported a version's bindings under more than one key across releases; take whichever
    // is present rather than assuming, and let a missing one fail the mandatory check above.
    return latest.vars ?? latest.resources?.bindings ?? latest.annotations ?? {};
  };

  const hostedSha = async () => {
    try { return wrangler(["versions", "list", "--name", WORKER, "--json"]); }
    catch { return wrangler(["deployments", "list", "--name", WORKER]); }
  };

  /** A bounded sample of the Worker's log, taken while a request is driven through it. */
  const workerLog = async () => {
    const chunks = [];
    let tail = null;
    try {
      tail = spawn("npx", ["wrangler", "tail", "--name", WORKER, "--format", "json"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      tail.stdout.on("data", (chunk) => chunks.push(String(chunk)));
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await http("GET", "/api/canonical-bookings");
      await new Promise((resolve) => setTimeout(resolve, 8000));
    } finally { if (tail) tail.kill("SIGINT"); }
    const captured = chunks.join("");
    return captured.trim() ? captured : null;
  };

  const report = await runGate({ http, d1, ddl, hostedSha, workerLog, providerActivation, env: { EXPECTED_SHA, ACCESS_CODE, RUN_TAG } });
  writeFileSync("release-preview-report.json", JSON.stringify(report, null, 2));
  // Both halt paths as well as the failure count: a run that stopped at the schema or the session
  // harness has verified nothing, whatever its failure tally happens to be.
  const passed = report.failures === 0 && report.authHarness !== "unavailable" && report.schema !== "unavailable";
  console.log(`\nrelease preview gate: ${passed ? "PASS" : "FAIL"}`);
  if (report.unavailable?.length) for (const name of report.unavailable) console.log(`  could not run (counted as a failure): ${name}`);
  process.exit(passed ? 0 : 1);
}
