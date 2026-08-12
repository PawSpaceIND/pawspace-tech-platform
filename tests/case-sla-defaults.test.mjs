import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Case SLA defaults. The property that matters: after seeding, EVERY case a
// module can open gets a real deadline and can actually breach - and seeding
// can never overwrite a commitment the ops owner has configured.
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

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const cases = await import("../lib/unified-case-center.ts");
  await cases.ensureUnifiedCaseTables(db);
  const defaults = await import("../lib/case-sla-defaults.ts");
  return { sqlite, db, cases, defaults };
}

test("the default matrix covers every case type and severity with coherent, ordered deadlines", async () => {
  const { defaults } = await world();
  const matrix = defaults.defaultCaseSlaMatrix();
  assert.equal(matrix.length, defaults.caseTypes.length * defaults.caseSeverities.length, "no (type, severity) pair may be left out");
  const seen = new Set();
  for (const row of matrix) {
    const key = `${row.caseType}:${row.severity}`;
    assert.ok(!seen.has(key), `duplicate policy for ${key}`);
    seen.add(key);
    assert.ok(row.firstResponseMinutes >= 5, `${key}: never promise a sub-5-minute human response`);
    // Manager escalation is the "about to be missed" signal: after first response, before resolution.
    assert.ok(row.managerEscalationMinutes >= row.firstResponseMinutes, `${key}: manager escalation must not precede first response`);
    assert.ok(row.managerEscalationMinutes < row.resolutionMinutes, `${key}: manager escalation must fire before the resolution deadline`);
    assert.ok(Number.isInteger(row.firstResponseMinutes) && Number.isInteger(row.resolutionMinutes) && Number.isInteger(row.managerEscalationMinutes));
  }
  // Severity has to actually mean something within a type.
  for (const caseType of defaults.caseTypes) {
    const byType = Object.fromEntries(matrix.filter(row => row.caseType === caseType).map(row => [row.severity, row]));
    assert.ok(byType.critical.firstResponseMinutes <= byType.high.firstResponseMinutes, `${caseType}: critical must not be slower than high`);
    assert.ok(byType.high.firstResponseMinutes <= byType.medium.firstResponseMinutes, `${caseType}: high must not be slower than medium`);
    assert.ok(byType.medium.firstResponseMinutes <= byType.low.firstResponseMinutes, `${caseType}: medium must not be slower than low`);
  }
  // A pet's welfare is the most urgent thing in the business.
  const safety = matrix.find(row => row.caseType === "safety_incident" && row.severity === "critical");
  const backOffice = matrix.find(row => row.caseType === "reconciliation" && row.severity === "critical");
  assert.ok(safety.firstResponseMinutes < backOffice.firstResponseMinutes, "a critical safety incident must outrank back-office reconciliation");
  assert.equal(safety.firstResponseMinutes, 5);
});

test("seeding gives every newly created case a real, breachable deadline", async () => {
  const { db, cases, defaults } = await world();
  const before = await defaults.caseSlaCoverageGaps(db);
  assert.equal(before.covered, 0);
  assert.equal(before.fullyCovered, false, "an unseeded environment genuinely has no SLA coverage");

  const result = await defaults.seedDefaultCasePolicies(db, { actorId: "founder@pawspace.in" });
  assert.equal(result.seeded, 36);
  assert.equal(result.skipped, 0);
  assert.equal(result.truth.overwritesConfiguredPolicy, false);

  const after = await defaults.caseSlaCoverageGaps(db);
  assert.equal(after.fullyCovered, true);
  assert.deepEqual(after.gaps, []);

  // The real end-to-end property: a case opened now carries deadlines and the sweep can breach it.
  const opened = await cases.createUnifiedCase(db, {
    idempotencyKey: "case-sla-1", caseType: "lead_escalation", severity: "medium",
    title: "Bot call needs a human", description: "Escalated from a bot call",
    sourceType: "bot_call_disposition", sourceId: "ATT-1", ownerTeam: "sales", actorId: "system",
  });
  const row = opened.case;
  assert.ok(row.first_response_due_at, "first response deadline is set");
  assert.ok(row.resolution_due_at, "resolution deadline is set");
  assert.ok(row.manager_escalation_due_at, "manager escalation deadline is set");
  assert.ok(Number(row.manager_escalation_due_at) < Number(row.resolution_due_at));

  const swept = await cases.runUnifiedCaseEscalations(db, { actorId: "system", asOf: Number(row.resolution_due_at) + 1000 });
  assert.equal(swept.firstResponseBreaches, 1, "an ignored case now genuinely breaches");
  assert.equal(swept.managerEscalations, 1, "and pulls in a manager");
});

test("seeding is idempotent and never overwrites a configured commitment", async () => {
  const { sqlite, db, defaults, cases } = await world();
  // The ops owner configures their own real commitment for one pair first.
  const own = await cases.saveCasePolicy(db, {
    name: "Real safety commitment", caseType: "safety_incident", severity: "critical",
    firstResponseMinutes: 2, resolutionMinutes: 60, managerEscalationMinutes: 3,
    effectiveFrom: Date.now() - 1000, actorId: "founder@pawspace.in",
  });
  await cases.activateCasePolicy(db, { policyId: own.id, approvalReference: "BOARD-2026-08", actorId: "founder@pawspace.in" });

  const first = await defaults.seedDefaultCasePolicies(db, { actorId: "founder@pawspace.in" });
  assert.equal(first.seeded, 35);
  assert.equal(first.skipped, 1);
  assert.deepEqual(first.details.skipped[0], { caseType: "safety_incident", severity: "critical", reason: "policy_already_configured" });

  const preserved = sqlite.prepare("SELECT first_response_minutes,approval_reference FROM case_policies WHERE case_type='safety_incident' AND severity='critical' AND status='active_uat'").all();
  assert.equal(preserved.length, 1, "the configured policy was neither replaced nor duplicated");
  assert.equal(preserved[0].first_response_minutes, 2, "the real commitment is untouched");
  assert.equal(preserved[0].approval_reference, "BOARD-2026-08");

  // Re-running changes nothing at all.
  const again = await defaults.seedDefaultCasePolicies(db, { actorId: "founder@pawspace.in" });
  assert.equal(again.seeded, 0);
  assert.equal(again.skipped, 36);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM case_policies").get().c, 36, "no duplicate policies accumulate");
});

test("seeded policies are marked as UAT defaults, and a weak approval reference is refused", async () => {
  const { sqlite, db, defaults } = await world();
  await assert.rejects(() => defaults.seedDefaultCasePolicies(db, { actorId: "founder@pawspace.in", approvalReference: "x" }), /at least 4 characters/);
  await defaults.seedDefaultCasePolicies(db, { actorId: "founder@pawspace.in" });
  const refs = sqlite.prepare("SELECT DISTINCT approval_reference FROM case_policies").all();
  assert.deepEqual(refs.map(row => row.approval_reference), ["UAT-DEFAULT-SLA"], "every seeded policy is traceable as a UAT default, not a board commitment");
  const named = sqlite.prepare("SELECT name FROM case_policies LIMIT 1").get();
  assert.match(named.name, /UAT default/);
});

test("seeding requires settings.manage and the coverage gap is visible to staff", () => {
  const route = read("app/api/unified-cases/route.ts");
  assert.match(route, /action==="seed_default_policies"/);
  assert.match(route, /authorize\(request,"settings\.manage"\)/, "seeding governance config needs more than case-handling permission");
  assert.match(route, /case\.policy\.seed_defaults/, "the seed is written to the security audit trail");
  assert.match(route, /slaCoverage:await caseSlaCoverageGaps\(db\)/, "the directory surfaces uncovered pairs rather than hiding them");
});
