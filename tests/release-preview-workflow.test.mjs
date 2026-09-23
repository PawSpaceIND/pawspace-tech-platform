import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const deployStep = () =>
  namedStep(
    "Deploy the dedicated preview Worker from the candidate build",
    "Verify the DEPLOYED sha is the candidate sha",
  );

test("release-preview deploy records the exact requested sha in the version message", () => {
  const deploy = deployStep();

  assert.match(
    deploy,
    /EXPECTED_SHA: \$\{\{ github\.event\.inputs\.expected_sha \}\}/,
    "deploy must receive the workflow's expected_sha input",
  );
  assert.match(
    deploy,
    /npx wrangler deploy --message "release-preview \$EXPECTED_SHA"/,
    "deploy must persist the exact candidate sha in Wrangler's version message",
  );
  assert.match(
    deploy,
    /echo "preview_url=\$PREVIEW_URL" >> "\$GITHUB_OUTPUT"/,
    "deploy must expose the exact account-qualified URL Wrangler reported",
  );
});

test("no step after the deploy publishes a version that supersedes the marked one", () => {
  // `wrangler secret put` publishes a NEW Worker version. Four of them ran after the deploy, so the
  // version actually serving the preview carried no `release-preview <sha>` message, and every gate
  // that resolves the ACTIVE version refused a preview that was in fact correct. The credentials now
  // travel with the deploy itself, which is why nothing may reintroduce a post-deploy publish.
  // Anchored on whatever step follows the deploy, not on a step name, so reintroducing the old
  // `secret put` step between them is caught rather than sliced past.
  const deployStart = workflow.indexOf("      - name: Deploy the dedicated preview Worker from the candidate build");
  assert.notEqual(deployStart, -1, "missing the deploy step");
  const nextStep = workflow.indexOf("\n      - name: ", deployStart + 1);
  assert.notEqual(nextStep, -1, "the deploy step must not be the last step in the job");
  const afterDeploy = workflow.slice(nextStep);
  assert.doesNotMatch(
    afterDeploy,
    /wrangler secret put/,
    "a post-deploy secret put would leave the marked version superseded again",
  );
  assert.doesNotMatch(
    afterDeploy,
    /npx wrangler deploy\b/,
    "only one deploy may publish a version, so the marked version stays the serving one",
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

// The cases below run the workflow's real verification program rather than matching its text, so a
// rewrite that still reads plausibly cannot pass them. It is lifted out of the step's heredoc and
// executed against synthetic `deployments status` / `versions list` output.
function verificationProgram() {
  const verify = namedStep(
    "Verify the DEPLOYED sha is the candidate sha",
    "Post-deploy gate (runner-local; nothing sensitive leaves this job)",
  );
  assert.match(
    verify,
    /npx wrangler deployments status --json --name "\$WORKER"/,
    "verification must resolve which version is actually serving",
  );
  const opener = "<<'NODE'\n";
  const open = verify.indexOf(opener);
  assert.notEqual(open, -1, "the verification step must run a node heredoc");
  const body = verify.slice(open + opener.length);
  const close = body.indexOf("\n          NODE\n");
  assert.notEqual(close, -1, "the node heredoc must be terminated");
  return body.slice(0, close).replace(/^ {10}/gm, "");
}

const SHA = "a".repeat(40);
const MARKER = `release-preview ${SHA}`;
const marked = (id) => ({ id, annotations: { "workers/message": MARKER } });
const unmarked = (id) => ({ id, annotations: { "workers/message": "Automatic deployment on secret update." } });

function runVerification(status, versions) {
  const dir = mkdtempSync(join(tmpdir(), "preview-verify-"));
  writeFileSync(join(dir, "deploy-status.json"), JSON.stringify(status));
  writeFileSync(join(dir, "versions.json"), JSON.stringify(versions));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", verificationProgram()], {
    cwd: dir,
    env: { ...process.env, EXPECTED_SHA: SHA },
    encoding: "utf8",
  });
  return { code: result.status, stderr: String(result.stderr || "") };
}

test("verification accepts one marked version serving all of the traffic", () => {
  const result = runVerification({ versions: [{ version_id: "v2", percentage: 100 }] }, [marked("v2"), unmarked("v1")]);
  assert.equal(result.code, 0, result.stderr);
});

test("verification refuses a superseded marker: the serving version is not the marked one", () => {
  // The original defect. `secret put` published v2 on top of the marked v1, which is still listed.
  const result = runVerification({ versions: [{ version_id: "v2", percentage: 100 }] }, [unmarked("v2"), marked("v1")]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not carry release-preview/);
});

test("verification refuses split traffic in which an unmarked version still takes requests", () => {
  // Review finding: resolving `active` from any nested version id and taking the first match let a
  // marked version satisfy the gate while an unmarked one served half the requests.
  const result = runVerification(
    { versions: [{ version_id: "v1", percentage: 50 }, { version_id: "v2", percentage: 50 }] },
    [marked("v1"), unmarked("v2")],
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /must serve exactly one/);
});

test("verification refuses a single version that is not at 100% traffic", () => {
  const result = runVerification({ versions: [{ version_id: "v1", percentage: 50 }] }, [marked("v1")]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not one version at 100% traffic/);
});

test("verification refuses status output it cannot read rather than passing on the whole list", () => {
  const result = runVerification({ deployment: { version_id: "v1" } }, [marked("v1")]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /did not report a versions array/);
});

test("release-preview installs the Maps UAT key only as an encrypted Worker secret", () => {
  const deploy = deployStep();
  assert.match(deploy, /GOOGLE_MAPS_SERVER_API_KEY_UAT: \${{ secrets\.GOOGLE_MAPS_SERVER_API_KEY_UAT }}/);
  assert.match(
    deploy,
    /npx wrangler deploy --message "release-preview \$EXPECTED_SHA" --secrets-file "\$SECRETS_FILE"/,
    "the UAT credentials must be delivered as encrypted Worker secrets by the deploy itself",
  );
  assert.match(
    deploy,
    /const names = \["PAWSPACE_UAT_ACCESS_CODE", "PAWSPACE_UAT_SIGNING_KEY", "PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT", "GOOGLE_MAPS_SERVER_API_KEY_UAT"\];/,
    "all four UAT credentials must travel with the deploy",
  );
  assert.match(
    deploy,
    /if \(missing\.length\) throw new Error/,
    "a blank value must refuse the deploy rather than overwrite a working secret with an empty one",
  );
  // The secrets file is written by node and handed over by path; no credential may become a command
  // argument, an echoed line, or a value inside the deployed wrangler.json artifact.
  assert.doesNotMatch(deploy, /echo[^\n]*\$\{?(PAWSPACE_UAT|GOOGLE_MAPS_SERVER)/);
  assert.match(deploy, /trap 'rm -f "\$DEPLOY_LOG" "\$SECRETS_FILE"' EXIT/, "the secrets file must not outlive the step");
});
