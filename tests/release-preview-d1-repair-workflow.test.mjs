import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__RELEASE_PREVIEW_D1_REPAIR_DB__", "__RELEASE_PREVIEW_D1_REPAIR_ENV__");

const { SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE } = await import("../lib/scheduling-reservation-leases.ts");
const workflow = fs.readFileSync(".github/workflows/repair-release-preview-d1.yml", "utf8");
const compactWorkflow = workflow.replace(/\s+/g, " ");

test("release-preview D1 repair addresses the isolated database by UUID through Cloudflare query API", () => {
  assert.match(
    workflow,
    /api\.cloudflare\.com\/client\/v4\/accounts\/\$\{CLOUDFLARE_ACCOUNT_ID\}\/d1\/database\/\$\{PREVIEW_D1\}\/query/,
  );
  assert.doesNotMatch(
    workflow,
    /wrangler\s+d1\s+execute\s+["']?\$PREVIEW_D1/,
    "a raw D1 UUID must never be passed as Wrangler's configured database name/binding",
  );
});

test("release-preview D1 repair remains fail-closed and enforces the production scheduling invariant", () => {
  assert.match(workflow, /RELEASE_PREVIEW_D1_ID/);
  assert.match(workflow, /PRODUCTION_D1_ID/);
  assert.match(workflow, /SHARED_STAGING_D1_ID/);
  assert.match(workflow, /Preview D1 matches production/);
  assert.match(workflow, /Preview D1 matches shared staging/);
  assert.match(workflow, /created_at=1/);
  assert.match(workflow, /id LIKE 'RES-preview-%'/);
  assert.match(workflow, /CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduling_reservations_active_provider_window/);
  assert.ok(
    compactWorkflow.includes(`WHERE ${SCHEDULING_RESERVATION_ACTIVE_SLOT_PREDICATE}`),
    "preview repair must use the exact active-slot predicate exported by production scheduling governance",
  );
});
