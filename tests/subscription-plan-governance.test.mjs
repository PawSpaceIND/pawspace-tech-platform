import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
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

async function seededPlan() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const { createSubscriptionPlan } = await import("../lib/subscription-plan-governance.ts");
  const plan = await createSubscriptionPlan(db, {
    serviceCode: "grooming",
    planCode: "grooming-6",
    cityId: "blr",
    name: "Grooming 6",
    price: 6594,
    sessionCount: 6,
    validityValue: 8,
    validityUnit: "months",
    servicePackageCode: "grooming-full",
    actorId: "test@pawspace.in",
  });
  return { sqlite, db, plan };
}

const update = async (db, plan, changes) => {
  const { updateSubscriptionPlan } = await import("../lib/subscription-plan-governance.ts");
  return updateSubscriptionPlan(db, {
    id: plan.id,
    changes,
    reason: "Regression validation",
    actorId: "test@pawspace.in",
  });
};

test("subscription plan PATCH rejects invalid commercial invariants", async () => {
  for (const [field, value, message] of [
    ["price", -1, /numeric price/i],
    ["price", Number.NaN, /numeric price/i],
    ["session_count", 0, /at least 1/i],
    ["session_count", -3, /at least 1/i],
    ["validity_value", 0, /at least 1/i],
    ["validity_value", -2, /at least 1/i],
    ["validity_unit", "years", /days.*months/i],
  ]) {
    const { db, plan } = await seededPlan();
    await assert.rejects(() => update(db, plan, { [field]: value }), message, `${field}=${String(value)} must be rejected`);
  }
});

test("subscription plan PATCH rejects malformed JSON value types", async () => {
  for (const [field, value, message] of [
    ["price", null, /numeric price/i],
    ["price", false, /numeric price/i],
    ["price", "", /numeric price/i],
    ["price", "6999", /numeric price/i],
    ["session_count", "8", /numeric values/i],
    ["validity_value", "10", /numeric values/i],
    ["active", "false", /must be a boolean/i],
    ["active", 0, /must be a boolean/i],
    ["family_wallet", "false", /must be a boolean/i],
    ["family_wallet", 1, /must be a boolean/i],
  ]) {
    const { db, plan } = await seededPlan();
    await assert.rejects(() => update(db, plan, { [field]: value }), message, `${field} malformed value must be rejected`);
  }
});

test("subscription plan PATCH preserves the stored plan when validation fails", async () => {
  const { sqlite, db, plan } = await seededPlan();
  await assert.rejects(() => update(db, plan, { session_count: 0 }), /at least 1/i);
  const stored = sqlite.prepare("SELECT price,session_count,validity_value,validity_unit,version FROM subscription_plans WHERE id=?").get(plan.id);
  assert.equal(Number(stored.price), 6594);
  assert.equal(Number(stored.session_count), 6);
  assert.equal(Number(stored.validity_value), 8);
  assert.equal(stored.validity_unit, "months");
  assert.equal(Number(stored.version), 1, "a rejected change must not increment plan version");
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) c FROM subscription_plan_audit WHERE plan_id=? AND action='updated'").get(plan.id).c,
    0,
    "a rejected change must not create an update audit record",
  );
});

test("subscription plan PATCH accepts valid edits and normalizes count fields", async () => {
  const { sqlite, db, plan } = await seededPlan();
  const changed = await update(db, plan, {
    price: 6999,
    session_count: 8.9,
    validity_value: 10.7,
    validity_unit: "months",
    active: false,
    family_wallet: false,
  });
  assert.equal(changed.price, 6999);
  assert.equal(changed.sessionCount, 8);
  assert.equal(changed.validityValue, 10);
  assert.equal(changed.validityUnit, "months");
  assert.equal(changed.active, false);
  assert.equal(changed.familyWallet, false);
  assert.equal(changed.version, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM subscription_plan_audit WHERE plan_id=? AND action='updated'").get(plan.id).c, 1);
});
