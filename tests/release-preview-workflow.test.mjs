import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const workflow = await readFile(
  new URL("../.github/workflows/deploy-release-preview.yml", import.meta.url),
  "utf8",
);

function namedStep(name, nextName) {
  const startMarker = `      - name: ${name}`;
  const start = workflow.indexOf(startMarker);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);

  const end = nextName
    ? workflow.indexOf(`\n      - name: ${nextName}`, start + startMarker.length)
    : workflow.length;
  assert.notEqual(end, -1, `missing following workflow step: ${nextName}`);
  return workflow.slice(start, end);
}

test("release-preview deploy records the exact requested sha in the version message", () => {
  const deploy = namedStep(
    "Deploy the dedicated preview Worker from the candidate build",
    "Install UAT credentials as Worker secrets",
  );

  assert.match(
    deploy,
    /EXPECTED_SHA: \$\{\{ github\.event\.inputs\.expected_sha \}\}/,
    "deploy must receive the workflow's expected_sha input",
  );
  assert.match(
    deploy,
    /run: npx wrangler deploy --message "release-preview \$EXPECTED_SHA"/,
    "deploy must persist the exact candidate sha in Wrangler's version message",
  );
});

test("release-preview verification reads version JSON and requires the exact sha message", () => {
  const verify = namedStep(
    "Verify the DEPLOYED sha is the candidate sha",
    "Post-deploy gate (runner-local; nothing sensitive leaves this job)",
  );

  assert.match(
    verify,
    /npx wrangler versions list --json --name "\$WORKER" > versions\.json/,
    "verification must read wrangler versions list --json",
  );
  assert.doesNotMatch(
    verify,
    /wrangler deployments list/,
    "verification must not fall back to deployments output that cannot attest the version message",
  );
  assert.match(
    verify,
    /const expectedMessage = `release-preview \$\{expected\}`;/,
    "verification must construct the exact deployment message from EXPECTED_SHA",
  );
  assert.match(
    verify,
    /strings\.includes\(expectedMessage\)/,
    "verification must require an exact message match rather than a partial sha grep",
  );
  assert.doesNotMatch(
    verify,
    /grep -q "\$EXPECTED_SHA"/,
    "substring matching is not sufficient for exact-sha verification",
  );
});
