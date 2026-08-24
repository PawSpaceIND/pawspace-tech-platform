import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args = []) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: sql => statement(sql),
    batch: async statements => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
  };
}

const future = hours => new Date(Date.now() + hours * 3_600_000).toISOString();

test("Boarding persists the governed second-city quote context and refuses a Bengaluru relabel", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const boarding = await import("../lib/boarding-governance.ts");
  const quote = await boarding.createBoardingQuote(db, {
    packageCode: "boarding-24h", petCount: 1, cityId: "maa", zoneId: "maa-central",
    scheduledStart: future(48), scheduledEnd: future(72), paymentMode: "prepaid",
  });
  assert.equal(quote.cityId, "maa");
  assert.equal(quote.zoneId, "maa-central");
  assert.deepEqual(
    { ...sqlite.prepare("SELECT city_id,zone_id FROM boarding_commercial_quotes WHERE id=?").get(quote.quoteId) },
    { city_id: "maa", zone_id: "maa-central" },
  );
  await assert.rejects(
    boarding.governBoardingBooking(db, {
      quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
      petCount: 1, cityId: "blr", zoneId: "blr-east", scheduledStart: quote.scheduledStart,
      scheduledEnd: quote.scheduledEnd, submittedTotal: quote.totalAmount,
      submittedAmountDueNow: quote.amountDueNow, paymentMode: quote.paymentMode,
      paymentStatus: "captured", reservationCount: 1, providerId: "host_sana",
      species: ["dog"], vaccinationStatuses: ["verified"],
    }),
    error => error instanceof Response && error.status === 409,
  );
});

test("Sitting confirms only when the persisted quote city and scheduler city agree", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const sitting = await import("../lib/sitting-governance.ts");
  const quote = await sitting.createSittingQuote(db, {
    packageCode: "sitting-overnight", petCount: 2, cityId: "maa", zoneId: "maa-central",
    scheduledStart: future(48), scheduledEnd: future(72), paymentMode: "prepaid",
  });
  const base = {
    quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
    petCount: 2, scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
    submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
    paymentMode: quote.paymentMode, paymentStatus: "captured", reservationCount: 1,
  };
  const governed = await sitting.governSittingBooking(db, { ...base, cityId: "maa", zoneId: "maa-central" });
  assert.equal(governed.totalAmount, quote.totalAmount);
  await assert.rejects(
    sitting.governSittingBooking(db, { ...base, cityId: "blr", zoneId: "blr-east" }),
    error => error instanceof Response && error.status === 409,
  );
});
