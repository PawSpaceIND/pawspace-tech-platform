# PawSpace Secrets Management and Rotation Policy

## Production rule

Production secrets must never be stored in plaintext `.env`, `.env.*`, committed configuration, source code, shell history, tickets, chat transcripts, CI logs, screenshots, or documentation. `.env` files are development-only and remain gitignored. Production workloads receive secrets only through an approved secret store and runtime binding.

## Cloudflare secret injection runbook

1. Generate or rotate the credential at its authoritative provider. Do not paste the value into a repository file.
2. Store the value as a Cloudflare Worker Secret using `wrangler secret put <NAME>` or the equivalent Cloudflare API/Secrets Store workflow from an approved CI secret. Cloudflare secret values are encrypted and exposed to the Worker only as runtime bindings.
3. CI may hold the deployment credential in the GitHub Actions secret store, but workflow logs must never echo or serialize it. Use least-privilege, environment-scoped deployment tokens.
4. Treat encryption key material as KMS-backed secret material: generate it with a cryptographically secure source, store it only in the approved managed secret/KMS system, and inject only an opaque runtime reference or secret binding. Never persist AES-GCM keys beside ciphertext in D1, KV, R2, source, or `.env` production files.
5. Deploy the new secret to the non-production/UAT binding first, execute provider and application health checks, then promote through the normal reviewed production deployment path.
6. Revoke the superseded credential at the provider only after the new credential is verified active. Record owner, rotation timestamp, next due date, and affected services without recording the secret value.
7. Any suspected disclosure is an incident: revoke immediately, rotate dependent credentials, audit access/logs, rerun Gitleaks, and document evidence of revocation.

## Mandatory rotation schedule

| Secret class | Maximum age | Rotation rule |
| --- | ---: | --- |
| Razorpay API key/secret | 90 days | Rotate no later than day 90; immediately on suspected disclosure, staff/offboarding risk, or provider alert. |
| Cloudflare/Vectorize management API token | 90 days | Rotate no later than day 90; scope to only the account/resources/actions required for Vectorize management. Prefer native Worker Vectorize bindings at runtime rather than embedding management tokens. |
| AES-GCM/data-encryption key | 90 days maximum unless a shorter compliance window applies | Rotate with key-version tracking and controlled decrypt-old/encrypt-new migration; never reuse a nonce with the same key. |
| CI/deployment token | 90 days maximum | Least privilege and environment scoped; immediately revoke after any leak. |

Rotation ownership must be assigned to Platform/Security with a tracked due date. A missed rotation deadline is a release blocker until the credential is rotated or an explicit, time-bounded security exception is approved.

## Repository gate

`scripts/security/scan-secrets.sh` scans the exact staged blobs, not merely the working tree, using `.gitleaks.toml` plus the upstream Gitleaks default rules. Commits must fail closed when Gitleaks is missing or detects a secret. The custom rules explicitly cover Cloudflare OAuth/API tokens, Stripe/Razorpay-style keys, and AES-GCM/encryption-key assignments.

Before committing security-sensitive changes:

```bash
scripts/security/scan-secrets.sh
git diff --check
```

Never add a real secret to an allowlist. False-positive suppressions require a narrowly scoped rule or fingerprint with a documented security review.
