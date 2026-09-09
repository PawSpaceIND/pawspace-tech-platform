import test from "node:test";
import assert from "node:assert/strict";
import { adaptCurrentProductContracts } from "./e2e/release-preview-gate.mjs";

test("release-preview swarm uses independent provider reservations without weakening active-slot uniqueness", async () => {
  const sql = [];
  const calls = [];
  const adapted = adaptCurrentProductContracts({
    d1: async (statement) => { sql.push(statement); return []; },
    http: async (method, path, options = {}) => {
      calls.push({ method, path, options });
      return { status: 201, body: { data: { bookingId: "BK-SWARM" } }, headers: {} };
    },
  });

  await adapted.d1("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('preview-test-swarm-7','balanced','[]','preview-test-PRV','assigned','preview','gate',1)");
  await adapted.d1("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('RES-preview-test-swarm-7','preview-test-swarm-7','preview-test-PRV','pet_sitting','blr','koramangala','preview-test-CUS','[]','2027-03-04T09:00:00.000Z','2027-03-04T11:00:00.000Z',1,1,NULL,'reserved','{}',1)");

  assert.match(sql[0], /'preview-test-PRV-swarm-7','assigned'/);
  assert.match(sql[1], /'preview-test-PRV-swarm-7','pet_sitting'/);
  assert.match(sql[1], /'blr','blr-east'/);

  await adapted.http("POST", "/api/canonical-bookings", {
    body: {
      scheduleGroupId: "preview-test-swarm-7",
      cityId: "blr",
      zoneId: "koramangala",
      provider: { id: "preview-test-PRV", name: "Preview sitter", model: "full_time" },
    },
  });
  const canonical = calls.at(-1);
  assert.equal(canonical.path, "/api/canonical-bookings");
  assert.equal(canonical.options.body.provider.id, "preview-test-PRV-swarm-7");
  assert.equal(canonical.options.body.zoneId, "blr-east");

  const stats = adapted.stats();
  assert.equal(stats.swarmSchedulingProviderRewrites, 2);
  assert.equal(stats.swarmBookingProviderRewrites, 1);
  assert.equal(stats.zoneRewrites, 1);
});
