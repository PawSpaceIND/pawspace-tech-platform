const EXACT_SHA = /^[0-9a-f]{40}$/;

export function atlasProofProvenanceFields(version) {
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  const value = (name) => String(bindings.find(binding => binding?.name === name)?.text || "");
  return {
    versionMessage: String(version?.annotations?.["workers/message"] || "").trim(),
    stagingBuildSha: value("PAWSPACE_STAGING_BUILD_SHA"),
    releaseSha: value("PAWSPACE_RELEASE_SHA"),
    paymentEnvironment: value("PAWSPACE_PAYMENT_ENV"),
    forbidProduction: value("FORBID_PRODUCTION"),
    paymentLiveApproved: value("PAWSPACE_PAYMENT_LIVE_APPROVED")
  };
}

export function verifyAtlasProofProvenance({version, expectedSha, targetEnvironment, workerName}) {
  if (!EXACT_SHA.test(expectedSha || "")) throw new Error("Expected product SHA must be an exact commit");
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  const value = (name) => String(bindings.find(binding => binding?.name === name)?.text || "");
  if (targetEnvironment === "pawspace-staging") {
    if (workerName !== "pawspace-staging") throw new Error("Staging proof requires the dedicated pawspace-staging Worker");
    // The normal staging certificate uses this exact publication message. PAWSPACE_RELEASE_SHA
    // belongs to release-preview configuration and is not provisioned by stage-config.mjs.
    const message = String(version?.annotations?.["workers/message"] || "").trim();
    if (message !== `staging ${expectedSha}`) throw new Error("Active staging version message does not match expected product SHA");
    const buildSha = value("PAWSPACE_STAGING_BUILD_SHA");
    if (buildSha && buildSha !== expectedSha) throw new Error("Staging build binding conflicts with the active version message");
    if (value("PAWSPACE_PAYMENT_ENV") !== "sandbox" || value("FORBID_PRODUCTION") !== "true" || value("PAWSPACE_PAYMENT_LIVE_APPROVED") !== "false") {
      throw new Error("Active staging version is outside the certified sandbox payment envelope");
    }
    return {sha: expectedSha, environment: targetEnvironment, provenance: "exact_staging_version_message"};
  }
  if (targetEnvironment !== "pawspace-release-preview") throw new Error("Unsupported proof environment");
  if (value("PAWSPACE_RELEASE_SHA") !== expectedSha) throw new Error("Active release-preview product SHA does not match expected SHA");
  return {sha: expectedSha, environment: targetEnvironment, provenance: "exact_release_sha_binding"};
}
