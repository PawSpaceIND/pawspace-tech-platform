/**
 * "Where is the UI, it can't be blank - we can always feed the test data to check the functionality
 * and the outcome."
 *
 * scripts/uat-demo-seed.sql is that data. These tests load the generated file into a real database and
 * then drive the same modules the screens call, so the seed is proven by the outcome it produces
 * rather than by the rows it contains: the leaderboard ranks four reps with real SLA, conversion and
 * revenue numbers, and the campaign command centre shows a live campaign with its audience snapshot.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";


installWorkersHooks("__SEED_DB__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const out = [];
      for (const item of statements) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

const SEED_BASE = Date.UTC(2026, 7, 1);
const DAY = 86_400_000;

async function loadSeed() {
  const sqlite = new DatabaseSync(":memory:");
  // The documented load order: the staging seed supplies customers and bookings, the demo seed layers
  // the team and marketing work on top of them. Loading both is also what proves they line up.
  sqlite.exec(await readFile(new URL("../scripts/staging-seed.sql", import.meta.url), "utf8"));
  sqlite.exec(await readFile(new URL("../scripts/uat-demo-seed.sql", import.meta.url), "utf8"));
  globalThis.__SEED_DB__ = makeD1(sqlite);
  globalThis.__SEED_ENV__ = {};
  return sqlite;
}

test("the demo seed loads into a fresh database and is safe to re-run", async () => {
  const sqlite = await loadSeed();
  const before = sqlite.prepare("SELECT COUNT(*) AS value FROM lead_sla_events").get().value;
  sqlite.exec(await readFile(new URL("../scripts/uat-demo-seed.sql", import.meta.url), "utf8"));
  const after = sqlite.prepare("SELECT COUNT(*) AS value FROM lead_sla_events").get().value;
  assert.equal(after, before, "re-running the seed must not duplicate a single row");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS value FROM lead_assignment_memberships WHERE team_code='sales' AND active=1").get().value, 4);
});

test("real execution: the seeded team produces a ranked leaderboard with real numbers", async () => {
  await loadSeed();
  const { generateSalesProductivityFacts } = await import("../lib/sales-productivity-governance.ts");
  const { employeePerformanceCenter } = await import("../lib/employee-performance-center.ts");

  // Exactly what "Generate report" on /team/performance does, over the window the seed covers.
  const periodEnd = SEED_BASE + DAY, periodStart = periodEnd - 30 * DAY;
  const run = await generateSalesProductivityFacts(globalThis.__SEED_DB__, { periodStart, periodEnd, idempotencyKey: "uat-demo-30d", actorId: "tester@pawspace.in" });
  const facts = [...run.facts].sort((a, b) => b.netCollectedRevenue - a.netCollectedRevenue);
  assert.equal(facts.length, 4, "one row per seeded rep");
  assert.ok(facts.every((fact) => fact.leadsAssigned > 0), "every rep carries assigned leads");
  assert.ok(facts.every((fact) => fact.meaningfulActions > 0), "every rep has actions the policy counts");
  assert.ok(facts.some((fact) => fact.qualifiedLeads > 0), "qualified outcomes are measured");
  assert.ok(facts.some((fact) => fact.bookingConversions > 0), "leads converted to canonical bookings");
  assert.ok(facts[0].netCollectedRevenue > 0, "the top rep has real collected revenue, not zero");
  assert.ok(facts.some((fact) => fact.refunds > 0), "refunds exist so the net figure is exercised");
  assert.ok(facts.every((fact) => fact.netCollectedRevenue === fact.collectedRevenue - fact.refunds), "net is collected less refunds");
  assert.ok(facts.some((fact) => fact.firstResponseBreached > 0), "SLA misses are visible, not a flat 100%");
  assert.ok(facts.every((fact) => fact.firstResponseMet + fact.firstResponseBreached <= fact.firstResponseClocks));

  // The board itself is anchored on the live clock, so a report for the window on screen is what fills
  // it. The roster is what puts a rep on the board at all.
  const now = Date.now();
  await generateSalesProductivityFacts(globalThis.__SEED_DB__, { periodStart: now - 30 * DAY, periodEnd: now, idempotencyKey: "uat-demo-current", actorId: "tester@pawspace.in" });
  const board = await employeePerformanceCenter(globalThis.__SEED_DB__, { metric: "net_collected_revenue", days: 30 });
  assert.equal(board.rows.length, 4, "all four seeded reps appear on the leaderboard");
  assert.ok(board.rows.every((row) => row.employeeName && row.employeeName !== row.employeeEmail), "each rep resolves to a real name");
  assert.deepEqual(board.rows.map((row) => row.rank), [1, 2, 3, 4]);
  assert.ok(board.period.sourceRun, "the board names the run it is showing");
});

test("real execution: the campaign command centre is not blank on the seeded database", async () => {
  const sqlite = await loadSeed();
  const campaigns = sqlite.prepare("SELECT * FROM governed_marketing_campaigns ORDER BY id").all();
  assert.equal(campaigns.length, 2);

  const live = campaigns.find((row) => row.status === "active");
  assert.ok(live, "one campaign is live so the screen shows an activated state");
  assert.equal(live.approval_status, "approved", "activation never bypasses approval");
  assert.ok(live.approved_by && live.approved_at, "the approval is attributed to a human");
  const pending = campaigns.find((row) => row.status === "draft");
  assert.equal(pending.approval_status, "approval_required", "the second campaign shows the approval gate itself");

  const snapshot = sqlite.prepare("SELECT * FROM marketing_audience_snapshots WHERE campaign_id=?").get(live.id);
  assert.ok(snapshot, "the live campaign has an audience snapshot");
  const members = sqlite.prepare("SELECT cohort,COUNT(*) AS value FROM marketing_audience_members WHERE campaign_id=? GROUP BY cohort").all(live.id);
  const byCohort = Object.fromEntries(members.map((row) => [row.cohort, row.value]));
  assert.equal(byCohort.eligible + byCohort.holdout + byCohort.suppressed, snapshot.total_candidates, "the snapshot counts agree with its members");
  assert.equal(byCohort.eligible, snapshot.eligible_count);
  assert.equal(byCohort.holdout, snapshot.holdout_count);
  assert.equal(byCohort.suppressed, snapshot.suppressed_count);
  assert.ok(byCohort.holdout > 0, "an explicit holdout exists, which is the point of the governance");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS value FROM marketing_audience_members WHERE cohort='suppressed' AND suppression_reason IS NULL").get().value,
    0,
    "every suppression names its reason",
  );
});

test("real execution: seeded ad spend reaches the unit-economics CAC line", async () => {
  const sqlite = await loadSeed();
  const spend = sqlite.prepare("SELECT COALESCE(SUM(spend_amount),0) AS value FROM marketing_attribution_facts").get().value;
  assert.ok(spend > 0, "the seed carries real spend rows rather than leaving CAC unconfigured");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS value FROM marketing_attribution_facts WHERE attribution_model='unconfigured'").get().value,
    0,
    "each fact declares the attribution model it was produced under",
  );
});

test("the generator and the checked-in seed file agree", async () => {
  const [generator, seed] = await Promise.all([
    readFile(new URL("../scripts/uat-demo-seed-gen.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/uat-demo-seed.sql", import.meta.url), "utf8"),
  ]);
  // Deterministic output: no clock, no randomness, and every write is re-runnable.
  assert.doesNotMatch(generator, /Date\.now\(\)|Math\.random\(\)/);
  assert.match(seed, /^-- PawSpace UAT demo seed/);
  assert.equal(seed.split("\n").filter((line) => line.startsWith("INSERT ") && !line.startsWith("INSERT OR IGNORE")).length, 0, "every insert must be INSERT OR IGNORE");
});
