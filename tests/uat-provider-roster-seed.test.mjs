/**
 * LP / UAT Pet Sitting: the customer Sitting journey defaults to overnight care, but every authored
 * `roster` row the capacity seed published for a synthetic `uatcap_*` provider covered 06:00-22:00
 * only, so the scheduler correctly refused and the journey never rendered a sitter card. The seed now
 * treats Pet Sitting like Boarding (all day) and repairs the stale day-only rows a previous seed left
 * behind, because INSERT OR IGNORE alone would preserve them.
 *
 * This executes the seed's two roster statements against a real SQLite database and reads the result
 * back through lib/scheduling-roster-authority, the module the scheduler itself uses to decide which
 * rows are authoritative. A change that keeps the SQL text but breaks the rows fails here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { listAuthoritativeAvailability, AUTHORED_AVAILABILITY_SOURCES } from "../lib/scheduling-roster-authority.ts";

const seed = fs.readFileSync(new URL("../scripts/uat-staging-provider-capacity.sql", import.meta.url), "utf8");

/** The seed's roster block: the stale-row repair, then the authored publish. */
function rosterStatements() {
  const repair = seed.match(/UPDATE scheduling_availability\s+SET windows_json='\["00:00-23:59"\]'[\s\S]*?;/);
  const publish = seed.match(/WITH RECURSIVE days\(d,n\)[\s\S]*?WHERE p\.id LIKE 'uatcap\\_%' ESCAPE '\\';/);
  assert.ok(repair, "the seed must carry the stale Pet Sitting roster repair");
  assert.ok(publish, "the seed must carry the authored roster publish");
  return { repair: repair[0], publish: publish[0] };
}

function world() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY, city_id TEXT NOT NULL, zones_json TEXT NOT NULL, services_json TEXT NOT NULL);`);
  const availability = seed.match(/CREATE TABLE IF NOT EXISTS scheduling_availability \([^;]*\);/);
  assert.ok(availability, "the seed must declare scheduling_availability");
  sqlite.exec(availability[0]);
  sqlite.exec(`
    INSERT INTO provider_capacity_profiles VALUES
      ('uatcap_sit_cm','blr','["blr-east"]','["pet_sitting"]'),
      ('uatcap_board_1','blr','["blr-east"]','["boarding"]'),
      ('uatcap_groom_ft','blr','["blr-east"]','["grooming"]'),
      ('partnerprofile_sit','blr','["blr-east"]','["pet_sitting"]');`);
  // A previous seed run left this sitter day-only; INSERT OR IGNORE would keep it forever.
  const today = new Date().toISOString().slice(0, 10);
  sqlite.exec(`INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES ('uatseed_uatcap_sit_cm_${today}_blr-east','uatcap_sit_cm','blr','blr-east','${today}','["06:00-22:00"]','roster',1);`);
  // Authored partner availability must never be rewritten by the seed.
  sqlite.exec(`INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES ('partner_row','partnerprofile_sit','blr','blr-east','${today}','["09:00-17:00"]','partner_app',1);`);
  const { repair, publish } = rosterStatements();
  sqlite.exec(repair);
  sqlite.exec(publish);
  const db = {
    prepare: (sql) => ({
      bind: (...binds) => ({ all: async () => ({ results: sqlite.prepare(sql).all(...binds) }) }),
    }),
  };
  return { sqlite, db, today };
}

const windowsOf = (rows) => rows.flatMap((row) => JSON.parse(String(row.windows_json)));

test("UAT Pet Sitting roster is published all day, so an overnight Sitting journey can be scheduled", async () => {
  const { db, today } = world();
  const rows = await listAuthoritativeAvailability(db, "uatcap_sit_cm", today);
  assert.ok(rows.length > 0, "the scheduler must see authoritative availability for the seeded sitter");
  assert.ok(rows.every((row) => AUTHORED_AVAILABILITY_SOURCES.includes(String(row.source))), "seeded rows must be authored, not runtime");
  assert.deepEqual([...new Set(windowsOf(rows))], ["00:00-23:59"], "Pet Sitting must be overnight-capable");
});

test("a stale day-only Pet Sitting row from an earlier seed run is repaired rather than preserved", async () => {
  const { sqlite, today } = world();
  const stale = sqlite.prepare("SELECT windows_json FROM scheduling_availability WHERE id=?").get(`uatseed_uatcap_sit_cm_${today}_blr-east`);
  assert.equal(String(stale.windows_json), '["00:00-23:59"]', "the repair must rewrite the pre-existing day-only row");
});

test("Boarding stays all day, day services stay 06:00-22:00, and authored partner rows are untouched", async () => {
  const { sqlite, db, today } = world();
  assert.deepEqual([...new Set(windowsOf(await listAuthoritativeAvailability(db, "uatcap_board_1", today)))], ["00:00-23:59"]);
  assert.deepEqual([...new Set(windowsOf(await listAuthoritativeAvailability(db, "uatcap_groom_ft", today)))], ["06:00-22:00"]);
  const partner = sqlite.prepare("SELECT windows_json,source FROM scheduling_availability WHERE id='partner_row'").get();
  assert.equal(String(partner.windows_json), '["09:00-17:00"]', "partner_app availability is authoritative and must not be rewritten");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM scheduling_availability WHERE provider_id='partnerprofile_sit'").get().n, 1, "the seed must not publish rows for non-uatcap providers");
});
