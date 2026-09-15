import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// /team/subscription-plans "Add plan" turned the admin's OWN input into HTTP 500.
//
// lib/subscription-plan-governance.ts refused business-rule violations with plain `Error`s carrying
// exact, actionable text ("A plan with this code already exists for this service/city (update it
// instead)"). authError() in lib/server-auth.ts maps ANY non-Response throw to 500 + the route's
// fallback string, so the operator who typed a duplicate plan code — or a single space into an input
// that `required` happily accepts — was told the platform had failed, and never what to change.
//
// The trap: throwing a Response is NOT enough. authError() redacts an *ungoverned* thrown Response's
// body too (see the `isGovernedHttpError` branch), replacing it with the same fallback. A refusal
// survives only if the Response was minted by governedJsonError(), which registers the object in the
// module-private WeakSet that isGovernedHttpError() checks by identity.
//
// These drive the REAL POST /api/subscription-plans handler against a real in-memory D1, so they fail
// if the governance library goes back to Error, if the WeakSet registration is lost, or if authError's
// redaction stops distinguishing governed refusals from internal faults.
// ---------------------------------------------------------------------------

installWorkersHooks("__SUBPLAN_4XX_DB__");

const ORIGIN = "http://localhost:3000";

function makeD1(sqlite, hooks = {}) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => {
      hooks.before?.(sql, args);
      const row = sqlite.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    run: async () => {
      hooks.before?.(sql, args);
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => {
      hooks.before?.(sql, args);
      return { results: sqlite.prepare(sql).all(...args) };
    },
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => {
      const out = [];
      for (const item of list) out.push(await item.run());
      return out;
    },
  };
}

async function world(hooks) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite, hooks);
  globalThis.__SUBPLAN_4XX_DB__ = db;
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  return { sqlite, db };
}

const VALID = {
  serviceCode: "grooming",
  planCode: "grooming-6",
  cityId: "blr",
  name: "Grooming 6",
  price: 6594,
  sessionCount: 6,
  validityValue: 8,
  validityUnit: "months",
  servicePackageCode: "grooming-full",
  reason: "New plan via admin",
};

async function addPlan(body) {
  const { POST } = await import("../app/api/subscription-plans/route.ts");
  const response = await POST(new Request(`${ORIGIN}/api/subscription-plans`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  }));
  return { response, body: await response.json() };
}

test("a duplicate plan code is refused as 409 carrying the real reason, not 500 with a fallback", async () => {
  await world();

  const first = await addPlan(VALID);
  assert.equal(first.response.status, 201, JSON.stringify(first.body));

  const second = await addPlan(VALID);
  assert.ok(second.response.status >= 400 && second.response.status < 500,
    `a duplicate plan code is the admin's input, so it must be 4xx — got ${second.response.status}`);
  assert.equal(second.response.status, 409);
  assert.equal(second.body.error, "A plan with this code already exists for this service/city (update it instead)");
  assert.notEqual(second.body.error, "Unable to create subscription plan",
    "the generic fallback means the refusal was redacted on its way out of authError()");
});

test("whitespace-only fields (which satisfy <input required>) are refused as a precise 400", async () => {
  await world();
  const { response, body } = await addPlan({ ...VALID, planCode: "   ", name: " " });
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.error, "planCode, cityId, name and servicePackageCode are required");
});

test("every create-time business rule keeps its own message and a 4xx status", async () => {
  for (const [patch, status, expected] of [
    [{ serviceCode: "dog_yoga" }, 400, /Unsupported service/],
    [{ servicePackageCode: "  " }, 400, /planCode, cityId, name and servicePackageCode are required/],
    [{ validityUnit: "years" }, 400, /validityUnit must be 'days' or 'months'/],
    [{ price: -1 }, 400, /A valid price is required/],
    [{ sessionCount: 0 }, 400, /sessionCount and validityValue must be at least 1/],
    [{ validityValue: 0 }, 400, /sessionCount and validityValue must be at least 1/],
  ]) {
    await world();
    const { response, body } = await addPlan({ ...VALID, ...patch });
    assert.equal(response.status, status, `${JSON.stringify(patch)} -> ${JSON.stringify(body)}`);
    assert.match(String(body.error), expected, `${JSON.stringify(patch)} lost its message`);
  }
});

test("a governed refusal writes nothing: the duplicate never becomes a second row", async () => {
  const { sqlite } = await world();
  await addPlan(VALID);
  await addPlan(VALID);
  const count = sqlite.prepare("SELECT COUNT(*) c FROM subscription_plans WHERE plan_code=?").get("grooming-6").c;
  assert.equal(Number(count), 1);
});

test("CONTROL: a genuine internal fault is still redacted to 500 + the fallback", async () => {
  // The fix must widen nothing but the caller's own refusals. An unexpected failure inside the insert
  // is not the admin's input and must keep leaking nothing.
  await world({
    before: (sql) => { if (sql.startsWith("INSERT INTO subscription_plans ")) throw new Error("D1_ERROR: disk image is malformed"); },
  });
  const { response, body } = await addPlan(VALID);
  assert.equal(response.status, 500);
  assert.equal(body.error, "Unable to create subscription plan");
});
