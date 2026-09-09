import test from "node:test";
import assert from "node:assert/strict";
import { adaptCurrentProductContracts } from "./e2e/release-preview-gate.mjs";

test("current preview adapter gives each swarm scheduling group an independent provider slot", async () => {
  const d1Seen = [];
  const httpSeen = [];
  const d1 = async (sql) => { d1Seen.push(String(sql)); return []; };
  const http = async (method, path, options = {}) => {
    httpSeen.push({ method, path, body: options.body });
    return { status: 418, body: {}, headers: {} };
  };
  const adapted = adaptCurrentProductContracts({ http, d1 });

  const group = "preview-deadbeef-9001-1-swarm-3";
  const baseProvider = "preview-deadbeef-9001-1-PRV";
  const uniqueProvider = `${group}-PRV`;

  await adapted.d1(`INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('${group}','balanced','[]','${baseProvider}','assigned','preview','gate',1)`);
  await adapted.d1(`INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('RES-${group}','${group}','${baseProvider}','pet_sitting','blr','koramangala','preview-deadbeef-9001-1-CUS','[]','2027-03-04T09:00:00.000Z','2027-03-04T11:00:00.000Z',1,1,NULL,'reserved','{}',1)`);

  assert.equal(d1Seen.length, 2);
  for (const sql of d1Seen) {
    assert.match(sql, new RegExp(`'${uniqueProvider}'`), "both assignment and reservation must use the unique swarm provider");
  }
  assert.match(d1Seen[1], /'blr','blr-east'/, "the existing current-zone adaptation must remain intact");

  await adapted.http("POST", "/api/canonical-bookings", {
    body: {
      idempotencyKey: group,
      scheduleGroupId: group,
      customer: { id: "not-the-owned-gate-customer" },
      pets: [{ sourceId: "swarm-3", name: "Pet 3" }],
      cityId: "maa",
      zoneId: "adyar",
      serviceCode: "pet_sitting",
      provider: { id: baseProvider, name: "Preview sitter", model: "full_time" },
    },
  });

  const forwarded = httpSeen.at(-1);
  assert.equal(forwarded.path, "/api/canonical-bookings");
  assert.equal(forwarded.body.provider.id, uniqueProvider, "booking payload must name the same provider the swarm reservation holds");

  const metrics = adapted.stats();
  assert.equal(metrics.swarmSeedProviderRewrites, 2, "assignment and reservation rewrites must both be observed");
  assert.equal(metrics.swarmBookingProviderRewrites, 1, "booking provider rewrite must be observed");
});

test("current preview adapter leaves non-swarm provider identities unchanged", async () => {
  const d1Seen = [];
  const httpSeen = [];
  const adapted = adaptCurrentProductContracts({
    d1: async (sql) => { d1Seen.push(String(sql)); return []; },
    http: async (method, path, options = {}) => { httpSeen.push({ method, path, body: options.body }); return { status: 418, body: {}, headers: {} }; },
  });

  const group = "preview-deadbeef-9001-1-normal";
  const provider = "preview-deadbeef-9001-1-PRV";
  await adapted.d1(`INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('${group}','balanced','[]','${provider}','assigned','preview','gate',1)`);
  await adapted.http("POST", "/api/canonical-bookings", {
    body: {
      scheduleGroupId: group,
      customer: { id: "not-the-owned-gate-customer" },
      pets: [{ sourceId: "pet", name: "Pet" }],
      cityId: "maa",
      zoneId: "adyar",
      serviceCode: "pet_sitting",
      provider: { id: provider, name: "Preview sitter", model: "full_time" },
    },
  });

  assert.match(d1Seen[0], new RegExp(`'${provider}'`));
  assert.equal(httpSeen.at(-1).body.provider.id, provider);
  assert.equal(adapted.stats().swarmSeedProviderRewrites, 0);
  assert.equal(adapted.stats().swarmBookingProviderRewrites, 0);
});
