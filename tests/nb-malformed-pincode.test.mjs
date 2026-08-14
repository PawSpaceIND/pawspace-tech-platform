/**
 * Malformed / out-of-coverage pincodes must FAIL EXPLICITLY and never resolve to a default (BLR) zone.
 *
 * A live Bengaluru city config covering 560001–560110 is seeded, so if any blr fallback existed a
 * malformed input would leak into a blr zone. The finding-#10 removal means it doesn't: a non-numeric,
 * short, or out-of-range pincode resolves to null (the route answers 404), never a blr-* zone. Driven
 * through the real resolver lib and the real route handler over a real node:sqlite D1.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__NBPIN_DB__", "__NBPIN_ENV__");

const { resolveZoneByPincode } = await import("../lib/service-zones.ts");

// The city table DDL is taken from the module that owns it, never re-typed (a hand-typed name is how the
// resolver once queried the wrong table and passed a broken test).
const CITY_DDL = (() => {
  const source = fs.readFileSync(new URL("../lib/city-governance.ts", import.meta.url), "utf8");
  const m = /CREATE TABLE IF NOT EXISTS city_launch_configs \([\s\S]*?\)(?=")/.exec(source);
  assert.ok(m, "could not find city_launch_configs DDL");
  return m[0];
})();

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__NBPIN_DB__ = db;
  globalThis.__NBPIN_ENV__ = {};
  sqlite.exec(CITY_DDL);
  // A LIVE Bengaluru config advertising the whole 560001–560110 range.
  sqlite.prepare("INSERT INTO city_launch_configs (id,city_code,city,state,status,centre,radius_km,pincodes,gst_included,services_json,version,updated_by,created_at,updated_at) VALUES ('bengaluru','blr','Bengaluru','Karnataka','Live','12.9716, 77.5946',35,'560001–560110','{}','{}',1,'test',0,0)")
    .run();
  return { sqlite, db };
}

const MALFORMED = ["abc", "abcdef", "12", "560", "56o102", "5600!!", "", "   "];

test("a valid in-coverage pincode resolves (control — a blr fallback WOULD fire here if one existed)", async () => {
  const { db } = fresh();
  const hit = await resolveZoneByPincode(db, "560102"); // HSR Layout
  assert.ok(hit, "a real Bengaluru pincode must resolve");
  assert.equal(hit.zone.zoneId.slice(0, 3), "blr", "and it resolves to a blr zone");
});

for (const pincode of MALFORMED) {
  test(`malformed pincode ${JSON.stringify(pincode)} resolves to null — never a default/blr zone`, async () => {
    const { db } = fresh();
    const result = await resolveZoneByPincode(db, pincode);
    assert.equal(result, null, `${JSON.stringify(pincode)} must not resolve to any zone`);
  });
}

test("a well-formed but OUT-OF-COVERAGE pincode is not-serviceable, never a blr fallback", async () => {
  const { db } = fresh();
  const chennai = await resolveZoneByPincode(db, "600042"); // Velachery, Chennai — no maa config seeded
  assert.equal(chennai, null, "an unserviced city pincode must be null, not a Bengaluru zone");
  const outOfRange = await resolveZoneByPincode(db, "700001"); // Kolkata
  assert.equal(outOfRange, null);
});

test("the route answers 404 for a malformed pincode and never returns a blr zone", async () => {
  fresh();
  const { GET } = await import("../app/api/service-zone/route.ts");
  for (const pincode of ["abc", "12", "56o102"]) {
    const res = await GET(new Request(`https://app.pawspace.in/api/service-zone?pincode=${encodeURIComponent(pincode)}`));
    assert.equal(res.status, 404, `${pincode} must be an explicit not-found`);
    const body = await res.json();
    assert.doesNotMatch(JSON.stringify(body), /blr/i, "a malformed pincode must never surface a blr zone");
  }
  // Control: a valid pincode is 200 with a blr zone.
  const ok = await GET(new Request("https://app.pawspace.in/api/service-zone?pincode=560102"));
  assert.equal(ok.status, 200);
});
