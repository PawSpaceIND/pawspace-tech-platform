# Staging voice routing: deployment-source consistency

29 September 2026. Follow-up to merged #1171 and operational issue #1166.

## Verified starting point
#1171 merged as 566801bd456dd892d16101bcb3386c1d05a38f8d. Deployment 36521793096 certified that staging revision with 28/28 checks. Subsequent specialist-UAT run 36522628109 returned provider_unavailable/dialed:false because the configured ElevenLabs phone import was stale. Read-only preparation 36522803862 verified a dedicated existing ExoPhone/import and produced staging-voice-routing-config.

The founder subsequently saved the three staging-environment values. Guarded sync runs 36531784818 and 36534379195 were reported successful before this source continuation. This source change does not edit those secrets, deploy, synchronize them again, change provider imports, or place a call.

## Source defect
Normal deploy-staging did not reference the pawspace-staging environment. Specialist and repair jobs did. An environment-scoped routing correction could therefore be replaced by repository-scoped values on a later normal deployment. EXOTEL_SUBDOMAIN was also not passed into that deployment's secret bundle.

## Proposed repair
- Scope the normal deploy job to the existing pawspace-staging environment.
- Before installation, migrations, deployment or roster writes, validate the selected ElevenLabs routing against provider metadata using only GET requests.
- Reuse the existing dedicated-staging ExoPhone/import selector; compare all three configured routing fields and verify the exact import detail. Reject missing, stale, ambiguous, malformed or oversized evidence, and stop immediately on HTTP errors without alternate-region retry.
- Use the same explicit Exotel/ElevenLabs settings for the guard and deployed Worker; carry EXOTEL_SUBDOMAIN into the deployment bundle.
- Add an explicitly selected provider-workflow inspection action which executes the same guard but cannot deploy, write customer data, change configuration or dial. Its environment contains no Cloudflare credential, staff login code or customer allowlist.
- Keep ordinary customer call limits, production jobs, recording approval, business knowledge and all existing provider-workflow jobs unchanged.

## Required operational completion
The founder-saved three pawspace-staging routing settings must be retained. Do not request another setup or alter shared production/repository routing. A fresh read-only inspection, not a blind write, should establish current consistency. Verify the effective staging settings with the read-only action before a reviewed deployment or guarded staging sync. The existing matched handset, consent, allowlist and attended-call requirements remain separate acceptance gates. This source change does not prove a connected phone conversation.

Reference: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments explains that environment secrets are available only to jobs referencing that environment. API verification reuses scripts/voice-handset-preflight.mjs and scripts/repair-staging-voice-config.mjs rather than introducing a new provider-writing path.

## Recovered local validation
The interrupted 312-test run had an outdated fingerprint for this append-only staging test file and a timed-out child Node process. Only the matching protected fingerprint was updated after verifying its old digest against HEAD; no assertion or path was removed. The child-process test passed unchanged in the resumed 289-test selection. Three reviewed hashes (two workflows and the appended test file) are the only changed entries in the existing contract.

GitHub secret precedence reference: https://docs.github.com/en/actions/reference/security/secrets . Environment-level settings take precedence only for a job referencing that environment; the validation and deployment now reference the same one.
