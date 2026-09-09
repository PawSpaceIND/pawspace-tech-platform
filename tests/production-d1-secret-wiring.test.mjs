import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/deploy-production.yml", import.meta.url), "utf8");

test("production deploy reads the production D1 identifier from the protected secret source", () => {
  const secretRefs = workflow.match(/PRODUCTION_D1_ID:\s*\$\{\{\s*secrets\.PRODUCTION_D1_ID\s*\}\}/g) || [];
  assert.ok(secretRefs.length >= 2, "configuration and post-deploy certification must both use secrets.PRODUCTION_D1_ID");
  assert.doesNotMatch(
    workflow,
    /PRODUCTION_D1_ID:\s*\$\{\{\s*vars\.PRODUCTION_D1_ID\s*\}\}/,
    "production deployment must not read PRODUCTION_D1_ID from repository/environment variables",
  );
});
