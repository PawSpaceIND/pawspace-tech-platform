from pathlib import Path

path = Path("tests/e2e/release-preview-gate.mjs")
text = path.read_text()

def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one match, found {count}: {old[:100]!r}")
    text = text.replace(old, new, 1)

replace_once(
'''    zoneRewrites: 0,
    quoteAttempts: 0,''',
'''    zoneRewrites: 0,
    swarmSchedulingProviderRewrites: 0,
    swarmBookingProviderRewrites: 0,
    quoteAttempts: 0,''')

replace_once(
'''    if (/^INSERT OR REPLACE INTO scheduling_reservations /i.test(next)) {
      const rewritten = next.replaceAll("'blr','koramangala'", "'blr','blr-east'");
      if (rewritten !== next) metrics.zoneRewrites++;
      next = rewritten;
    }
    return d1(next);''',
'''    // The legacy real-D1 swarm predates active provider-window uniqueness. It seeds every
    // group at the same time with one provider; under the product invariant, INSERT OR REPLACE
    // then replaces the prior reservation and leaves only the last group bookable. Keep the
    // 60-request concurrency oracle strong by giving only swarm fixtures distinct synthetic
    // providers. Non-swarm reservations and all product constraints remain untouched.
    const swarmGroup = next.match(/'([^']+-swarm-(\\d+))'/);
    if (swarmGroup && /^INSERT OR REPLACE INTO scheduling_(?:assignment_decisions|reservations) /i.test(next)) {
      const providerMatch = next.match(/'([^']+-PRV)'/);
      if (providerMatch) {
        const provider = providerMatch[1];
        const rewritten = next.replaceAll(`'${provider}'`, `'${provider}-swarm-${swarmGroup[2]}'`);
        if (rewritten !== next) metrics.swarmSchedulingProviderRewrites++;
        next = rewritten;
      }
    }
    if (/^INSERT OR REPLACE INTO scheduling_reservations /i.test(next)) {
      const rewritten = next.replaceAll("'blr','koramangala'", "'blr','blr-east'");
      if (rewritten !== next) metrics.zoneRewrites++;
      next = rewritten;
    }
    return d1(next);''')

replace_once(
'''      let body = { ...options.body };
      if (body.cityId === "blr" && body.zoneId === "koramangala") body.zoneId = "blr-east";

      const cacheKeys = [''',
'''      let body = { ...options.body };
      if (body.cityId === "blr" && body.zoneId === "koramangala") body.zoneId = "blr-east";
      const swarmMatch = String(body.scheduleGroupId || "").match(/-swarm-(\\d+)$/);
      if (swarmMatch && body.provider && typeof body.provider === "object" && body.provider.id) {
        body = { ...body, provider: { ...body.provider, id: `${body.provider.id}-swarm-${swarmMatch[1]}` } };
        metrics.swarmBookingProviderRewrites++;
      }

      const cacheKeys = [''')

replace_once(
'''    && contract.zoneRewrites > 0
    && contract.quotePreparations > 0''',
'''    && contract.zoneRewrites > 0
    && contract.swarmSchedulingProviderRewrites > 0
    && contract.swarmBookingProviderRewrites > 0
    && contract.quotePreparations > 0''')

replace_once(
'''    `zones=${contract.zoneRewrites}`,
    `prepared=${contract.quotePreparations}`,''',
'''    `zones=${contract.zoneRewrites}`,
    `swarmSchedulingProviders=${contract.swarmSchedulingProviderRewrites}`,
    `swarmBookingProviders=${contract.swarmBookingProviderRewrites}`,
    `prepared=${contract.quotePreparations}`,''')

path.write_text(text)

Path("tests/release-preview-swarm-provider-fixtures.test.mjs").write_text(r'''import test from "node:test";
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
''')

for temporary in (
    ".github/workflows/patch-release-preview-swarm.yml",
    ".github/workflows/patch-release-preview-swarm-v2.yml",
    "scripts/patch-release-preview-swarm.py",
):
    p = Path(temporary)
    if p.exists():
        p.unlink()
