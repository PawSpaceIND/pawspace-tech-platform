import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// The shift-liveness gate's refusals, and the workspace state the Partner app dropped.
//
// assertPartnerDailyScheduleLiveness writes two careful, actionable refusals: a 409 when onboarding is
// not verified and a 428 naming the one step that clears the gate ("Complete a live selfie/liveness
// match..."). Both were thrown as plain Responses, so authError - which only passes a 4xx body through
// when it came from the governed factory - replaced them with "Unable to load your provider workspace".
// The instruction was written and then discarded, leaving the partner blocked with nothing to act on.
//
// The gate's outcome, the onboarding link state and the outstanding proof stages all ride along in the
// same /api/provider-workspace payload, and none of them used to leave the app's fetch handler.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const page = readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
const auth = await import("../lib/server-auth.ts");
const PROVIDER = "groom_arun";

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_onboarding_applications (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, verification_status TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  return { sqlite, db };
}

/** Run the gate and return what the caller would actually receive, after authError. */
async function gateOutcome(db, { enforce }) {
  const gate = await import("../lib/trust-safety/partner-shift-liveness-gate.ts");
  try {
    return { ok: true, value: await gate.assertPartnerDailyScheduleLiveness(db, { providerId: PROVIDER, enforce }) };
  } catch (error) {
    const response = auth.authError(error, "Unable to load your provider workspace");
    return { ok: false, status: response.status, body: await response.json() };
  }
}

test("unverified onboarding refuses with the step that clears it, not a generic failure", async () => {
  const { sqlite, db } = fresh();
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,verification_status,updated_at) VALUES (?,?,?,?)")
    .run("APP-1", PROVIDER, "pending", 1);

  const outcome = await gateOutcome(db, { enforce: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 409);
  assert.equal(outcome.body.error, "onboarding_verification_required");
  assert.match(outcome.body.message, /Finish onboarding, or ask Ops to review/);
  assert.notEqual(outcome.body.error, "Unable to load your provider workspace",
    "this refusal used to be redacted to the route fallback");
});

test("a verified partner with no liveness match gets the 428 instruction intact", async () => {
  const { sqlite, db } = fresh();
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,verification_status,updated_at) VALUES (?,?,?,?)")
    .run("APP-2", PROVIDER, "verified", 1);

  const outcome = await gateOutcome(db, { enforce: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 428);
  assert.equal(outcome.body.error, "shift_liveness_required");
  assert.match(outcome.body.message, /Complete a live selfie\/liveness match/,
    "the one sentence that tells the partner what to do must survive authError");
  assert.equal(outcome.body.providerId, PROVIDER);
  assert.ok(outcome.body.shiftDate, "the shift date the gate is refusing for");
});

test("a matched liveness check is recorded, clears the gate, and lands in the right columns", async () => {
  const { sqlite, db } = fresh();
  const gate = await import("../lib/trust-safety/partner-shift-liveness-gate.ts");
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,verification_status,updated_at) VALUES (?,?,?,?)")
    .run("APP-3", PROVIDER, "verified", 1);
  await gate.ensurePartnerShiftLivenessTables(db);

  // This insert used to be impossible: ten placeholders, nine bound arguments, so every value after
  // application_id landed one column to the left and detail_json's NOT NULL rejected the row. The gate
  // could therefore never find a matched check, making its 428 permanent whenever enforcement was on.
  await gate.recordPartnerShiftLivenessResult(db, { providerId: PROVIDER, applicationId: "APP-3", idfyReference: "IDFY-SANDBOX-1", matched: true, matchScore: 0.97 });

  const row = sqlite.prepare("SELECT * FROM partner_shift_liveness_checks WHERE provider_id=?").get(PROVIDER);
  assert.ok(row, "the liveness check must actually persist");
  assert.equal(row.idfy_reference, "IDFY-SANDBOX-1", "the reference must not land in shift_date");
  assert.equal(row.status, "matched", "status must not receive the match score");
  assert.equal(row.match_score, 0.97);
  assert.match(String(row.shift_date), /^\d{4}-\d{2}-\d{2}$/, "shift_date must hold an IST day, not a reference");
  assert.equal(row.application_id, "APP-3");
  assert.equal(row.detail_json, "{}");
  assert.ok(Number(row.expires_at) > Number(row.checked_at), "the window must be ahead of the check time");

  const outcome = await gateOutcome(db, { enforce: true });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value.required, true);
  assert.equal(outcome.value.matched, true);
  assert.ok(outcome.value.checkId);
});

test("a failed liveness attempt records as failed and does NOT clear the gate", async () => {
  const { sqlite, db } = fresh();
  const gate = await import("../lib/trust-safety/partner-shift-liveness-gate.ts");
  sqlite.prepare("INSERT INTO provider_onboarding_applications (id,provider_id,verification_status,updated_at) VALUES (?,?,?,?)")
    .run("APP-4", PROVIDER, "verified", 1);
  await gate.ensurePartnerShiftLivenessTables(db);
  await gate.recordPartnerShiftLivenessResult(db, { providerId: PROVIDER, applicationId: "APP-4", idfyReference: "IDFY-SANDBOX-2", matched: false });

  assert.equal(sqlite.prepare("SELECT status FROM partner_shift_liveness_checks WHERE provider_id=?").get(PROVIDER).status, "failed");
  const outcome = await gateOutcome(db, { enforce: true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 428, "a failed match must not open the schedule");
});

test("with enforcement off the gate reports not-required rather than refusing", async () => {
  const { db } = fresh();
  const outcome = await gateOutcome(db, { enforce: false });
  assert.equal(outcome.ok, true);
  assert.deepEqual({ required: outcome.value.required, matched: outcome.value.matched }, { required: false, matched: false });
});

test("the Partner app consumes the three workspace fields it used to drop", () => {
  assert.match(page, /onboardingStatus\?: string/);
  assert.match(page, /liveness\?: WorkspaceLiveness/);
  assert.match(page, /pendingProof\?: WorkspacePendingProof\[\]/);
  // Declared is not shown: each must also be read in the render.
  assert.match(page, /workspaceState\.liveness\?\.required && !workspaceState\.liveness\.matched/);
  assert.match(page, /workspaceState\.onboardingStatus && workspaceState\.onboardingStatus !== "active"/);
  assert.match(page, /workspaceState\.pendingProof\.length/);
  assert.match(page, /Shift liveness check due/);
  assert.match(page, /Service proof still outstanding/);
});

test("an unlinked identity clears the derived workspace state instead of keeping a stale gate", () => {
  const unlinked = page.slice(page.indexOf("linked === false"), page.indexOf("linked === false") + 400);
  assert.match(unlinked, /setWorkspaceState\(\{ onboardingStatus: "", liveness: null, pendingProof: \[\] \}\)/);
});
