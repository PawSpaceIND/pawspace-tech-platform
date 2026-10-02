import test from "node:test";
import assert from "node:assert/strict";
import {atlasProofProvenanceFields, verifyAtlasProofProvenance} from "../scripts/atlas-proof-provenance.mjs";
const sha = "b0c9e4a8b4663cba27d91ff60d20055e90d516a3";
const staging = () => ({annotations: {"workers/message": `staging ${sha}`}, resources: {bindings: [
  {name: "PAWSPACE_PAYMENT_ENV", text: "sandbox"}, {name: "FORBID_PRODUCTION", text: "true"},
  {name: "PAWSPACE_PAYMENT_LIVE_APPROVED", text: "false"}
]}});
const check = (version, extra = {}) => verifyAtlasProofProvenance({version, expectedSha: sha, targetEnvironment: "pawspace-staging", workerName: "pawspace-staging", ...extra});
test("certified normal staging needs no release-preview-only SHA binding", () => assert.equal(check(staging()).sha, sha));
test("wrong or missing staging publication message is refused", () => {
  for (const message of ["", `staging ${"a".repeat(40)}`, `release ${sha}`, `staging ${sha} extra`]) {
    const version = staging(); version.annotations["workers/message"] = message;
    assert.throws(() => check(version), /version message/);
  }
});
test("a staging SHA binding cannot contradict the publication message", () => {
  const version = staging(); version.resources.bindings.push({name: "PAWSPACE_STAGING_BUILD_SHA", text: "a".repeat(40)});
  assert.throws(() => check(version), /conflicts/);
});
test("sandbox envelope refuses each missing or unsafe payment flag", () => {
  for (const name of ["PAWSPACE_PAYMENT_ENV", "FORBID_PRODUCTION", "PAWSPACE_PAYMENT_LIVE_APPROVED"]) {
    for (const replacement of [null, "unsafe"]) {
      const version = staging(); const binding = version.resources.bindings.find(b => b.name === name);
      if (replacement === null) version.resources.bindings = version.resources.bindings.filter(b => b.name !== name);
      else binding.text = replacement;
      assert.throws(() => check(version), /sandbox payment envelope/);
    }
  }
});
test("wrong Worker, unknown environment and nonexact SHA are refused", () => {
  assert.throws(() => check(staging(), {workerName: "pawspace-production"}), /dedicated/);
  assert.throws(() => check(staging(), {targetEnvironment: "production"}), /Unsupported/);
  assert.throws(() => check(staging(), {expectedSha: "main"}), /exact commit/);
});
test("release-preview still requires its exact release SHA binding", () => {
  const version = {resources: {bindings: [{name: "PAWSPACE_RELEASE_SHA", text: sha}]}};
  assert.equal(check(version, {targetEnvironment: "pawspace-release-preview"}).sha, sha);
  assert.throws(() => check(staging(), {targetEnvironment: "pawspace-release-preview"}), /release-preview product SHA/);
});
test("diagnostic includes only needed public provenance and sandbox fields", () => {
  const version = staging();
  version.resources.bindings.push({name: "PAWSPACE_UAT_ACCESS_CODE", text: "must-not-export"});
  const fields = atlasProofProvenanceFields(version);
  assert.deepEqual(Object.keys(fields).sort(), ["forbidProduction", "paymentEnvironment", "paymentLiveApproved", "releaseSha", "stagingBuildSha", "versionMessage"].sort());
  assert.equal(JSON.stringify(fields).includes("must-not-export"), false);
  assert.equal(fields.versionMessage, `staging ${sha}`);
});
