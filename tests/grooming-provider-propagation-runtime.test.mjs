import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
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
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        sqlite.prepare(sql).run(...args);
        return { success: true };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

test("real execution: Grooming safety requirements and add-ons reach the assigned provider feed", async () => {
  const { listProviderJobs } = await import("../lib/partner-job-feed.ts");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, service_code TEXT NOT NULL, package_code TEXT NOT NULL, package_name TEXT NOT NULL, schedule_group_id TEXT NOT NULL, provider_id TEXT NOT NULL, scheduled_start TEXT NOT NULL, scheduled_end TEXT NOT NULL, status TEXT NOT NULL, pet_ids_json TEXT NOT NULL DEFAULT '[]', pricing_json TEXT NOT NULL DEFAULT '{}')");
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, name TEXT NOT NULL)");

  const now = Date.now();
  const start = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(now + 26 * 60 * 60 * 1000).toISOString();
  const pricing = {
    requirements: ["grooming_safety:aggressive"],
    addOns: ["Tick & flea treatment", "Full-body oil massage"],
  };

  sqlite.prepare("INSERT INTO canonical_customers (id,name) VALUES (?,?)").run("cus_groom", "Anita Rao");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,pet_ids_json,pricing_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("GROOM-1", "cus_groom", "grooming", "dog-bath", "Essential Bath", "grp_groom_1", "groom_arun", start, end, "assigned", JSON.stringify(["pet_1"]), JSON.stringify(pricing));

  const feed = await listProviderJobs(makeD1(sqlite), "groom_arun", now);
  assert.equal(feed.upcoming.length, 1);
  assert.equal(feed.upcoming[0].bookingId, "GROOM-1");
  assert.equal(feed.upcoming[0].serviceCode, "grooming");
  assert.equal(feed.upcoming[0].packageName, "Essential Bath");
  assert.deepEqual(feed.upcoming[0].safetyRequirements, ["grooming_safety:aggressive"]);
  assert.deepEqual(feed.upcoming[0].addOns, ["Tick & flea treatment", "Full-body oil massage"]);
});
