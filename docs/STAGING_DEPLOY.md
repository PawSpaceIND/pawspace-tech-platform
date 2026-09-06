# PawSpace — Isolated Staging Deploy (free Cloudflare, for human UAT)

Goal: a **reachable staging URL** where the team clicks through every module. Isolated from production —
its own Worker (`pawspace-staging`), its own D1, sandbox posture. A **free** Cloudflare account covers it
(Workers free tier + D1 free tier + a `*.workers.dev` URL). No credit card needed for Workers.

How this app deploys: `npm run build` (vinext) emits **`dist/server/wrangler.json`** (main `index.js`,
assets `../client`, D1 binding `DB`, 5-min cron). We patch that generated config for staging, then
`wrangler deploy` from the repository root. `scripts/stage-config.mjs` does the patch.

> You run this with **your** Cloudflare account. Secrets go in `wrangler secret put` or GitHub Actions
> secrets — **never pasted into chat**.

---

## One-time setup (ops, ~15 min)

1. **Free account:** sign up at dash.cloudflare.com. Copy your **Account ID** (Workers & Pages → right rail).
2. **API token:** My Profile → API Tokens → Create Token → *Custom* with:
   `Account · Workers Scripts · Edit` and `Account · D1 · Edit` (add `Account · Workers AI · Read` only if you want to test voice). No Zone scopes needed.
3. **Create the staging D1** and copy its `database_id`:
   ```bash
   npx wrangler d1 create pawspace-staging
   ```
4. Choose your path below.

### Path A — one-click via GitHub Actions (recommended)
Add in GitHub → Settings → Secrets and variables → Actions:
- **Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PAWSPACE_UAT_ACCESS_CODE`,
  `PAWSPACE_UAT_SIGNING_KEY`, `PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT` (generate each fresh — see the
  three `openssl rand -hex 32` lines below)
- **Variable:** `STAGING_D1_ID` = the id from step 3

Then: **Actions → "Deploy staging" → Run workflow →** type `staging` → Run.
It builds, patches the config (non-secret settings only), and uploads code plus the three UAT
credentials in one attributed Worker version using `wrangler deploy --secrets-file`. They remain
encrypted **secrets**, are never written into `wrangler.json`, and are never printed. The run log prints your URL:
`https://pawspace-staging.<your-subdomain>.workers.dev`

### Path B — from a terminal
```bash
set -euo pipefail
npm run install:ci
export CLOUDFLARE_API_TOKEN=…                          # from step 2 (do not commit)
export CLOUDFLARE_ACCOUNT_ID=…                         # from step 1
export STAGING_D1_ID=…                                 # from step 3
export PAWSPACE_UAT_ACCESS_CODE=…                      # openssl rand -hex 32 (>=32 chars)
export PAWSPACE_UAT_SIGNING_KEY=…                      # openssl rand -hex 32
export PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT=…        # openssl rand -hex 32
npm run build
node scripts/stage-config.mjs            # validates the 3 UAT credentials (fail-closed) and patches
                                         # dist/server/wrangler.json — NON-SECRET settings only
SECRETS_DIR="$(mktemp -d)"
SECRETS_FILE="$SECRETS_DIR/secrets.json"
export SECRETS_FILE
trap 'rm -rf "$SECRETS_DIR"' EXIT
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const names = ["PAWSPACE_UAT_ACCESS_CODE", "PAWSPACE_UAT_SIGNING_KEY", "PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT"];
  writeFileSync(process.env.SECRETS_FILE, JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))), { mode: 0o600 });
'
npx wrangler deploy --secrets-file "$SECRETS_FILE" # from the repo ROOT; secrets are encrypted bindings
```

---

## Optional integrations (staging only, fail-closed until set)
Set any of these as staging secrets to exercise that path; leave unset to keep it fail-closed:
```
RAZORPAY_KEY_ID_SANDBOX / RAZORPAY_KEY_SECRET_SANDBOX / RAZORPAY_WEBHOOK_SECRET_SANDBOX
IDFY_API_KEY / IDFY_ACCOUNT_ID / IDFY_URL
PAWSPACE_AI_PROVIDER_API_KEY            (then set AI rollout to staff_only at /team/ai/rollout)

The staging UAT sign-in needs three credentials, supplied as GitHub Actions **secrets**.
`scripts/stage-config.mjs` validates them (fail-closed) but never writes them into `wrangler.json`; the
deploy uploads them with the code as encrypted **secrets** (`wrangler deploy --secrets-file`). There are
no defaults: the deploy fails closed without them, refuses a value below its minimum length, and refuses
the three values that were once committed to this repository (they are public now, so re-supplying one
would restore the defect). Generate each fresh:

```bash
openssl rand -hex 32     # PAWSPACE_UAT_SIGNING_KEY               signs the UAT session cookie
openssl rand -hex 32     # PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT signs OTP identity assertions
openssl rand -hex 32     # PAWSPACE_UAT_ACCESS_CODE               the code testers type (>=32 chars)
```

Nothing prints them. The access code used to be echoed by the deploy script, which put it in every
build log.
```
Workers AI (voice) uses the `AI` binding; on the free tier it has a daily allowance. If a first deploy
ever complains about the `AI` binding, it is optional — voice simply stays fail-closed without it.

## Data
Tables self-provision on first use; pricing packages, UAT coupons and provider defaults auto-seed. Start
clean and let testers create data by using the app (add lead → book → pay sandbox → track → rate).

**Or pre-populate with the 220-customer seed pack** (same profile as the launch audit — 220 customers
across 5 cities, 294 pets, 307 bookings across all 6 verticals with mixed captured/pending/failed
payments, 23 subscriptions, marketing consent on ~⅓). Idempotent (`INSERT OR IGNORE`), safe to re-run:
```bash
npx wrangler d1 execute pawspace-staging --remote --file=scripts/staging-seed.sql
```
(Regenerate any time with `node scripts/staging-seed-gen.mjs` — deterministic output.)

**Load the staff sign-in directory** so the `/staging-login` identities in `docs/UAT-TESTER-GUIDE.md`
(Founder, Finance, Manager, Groomer, Associate) can actually sign in — UAT sign-in refuses any email
that is not an active `app_users` row, so without this seed every advertised staff identity is rejected:
```bash
npx wrangler d1 execute pawspace-staging --remote --file=scripts/employee-seed.sql
```
Idempotent (`INSERT OR IGNORE`), regenerate with `node scripts/employee-seed-gen.mjs`. It seeds 40
employees plus the `founder@pawspace.in` owner identity, one approved payroll run, and the GST entity.
After loading, open `/team/acquisition-funnel` and hit **Refresh sweep** to compute funnel stages, ₹300
recoveries and App-Inbound leads from the seeded data — instant material for the CRM/Sales test.

### Before any `--remote` command

`npx wrangler d1 execute --remote` writes to the live staging database using `CLOUDFLARE_API_TOKEN`.
Confirm the token you are about to use is the current one and that any previously exposed token has
been **revoked, not merely superseded** — a superseded token still works until it is deleted:

```bash
npx wrangler whoami          # must show the expected account
```

If a token has been shared, pasted into a transcript, or committed at any point, rotate it in the
Cloudflare dashboard (My Profile → API Tokens) and delete the old one before continuing. Every
`--remote` step below is blocked on that.

#### Finishing a rotation

Creating a replacement token is not the end of a rotation. Two things are left:

**1. Capture the old token's "Last used" timestamp BEFORE you delete it.** It is shown on the API
Tokens page and is destroyed along with the token. A last-used time inside the exposure window that
does not match your own activity means treat the token as used, not merely leaked.

**2. Delete the old token, then check the audit log.** A rotated-but-undeleted token still
authenticates. Run:

```bash
export CLOUDFLARE_API_TOKEN=…                 # the NEW token; needs Account Audit Logs (or Analytics) Read
export CLOUDFLARE_ACCOUNT_ID=…                # npx wrangler whoami prints it
node scripts/cloudflare-audit-check.mjs --since=<RFC3339 before the leak> --before=<now>
```

It groups every action in the window, reports whether a token deletion actually happened, and flags
the actions that mean someone kept or widened access: a new token created, a member invited, a
Logpush destination added, an R2 bucket or D1 database created, a Worker deployed, DNS or permissions
changed. Exit code 0 only when a deletion was found and nothing sensitive is unexplained; any error
exits non-zero, so it can never tick a checklist it could not actually check.

**What none of this covers.** The audit log records configuration changes, not data reads. A token
with D1 access could have run `wrangler d1 execute` against staging and left nothing in it. The only
signals for that are the last-used timestamp above and Workers/D1 request analytics.

**And settle what data was in staging during the window.** If only `staging-seed.sql`,
`employee-seed.sql` and `uat-demo-seed.sql` had been loaded, the content is synthetic and the impact
is low. If the masked real book (`truth-masked.sql`, below) had been loaded, this stops being
housekeeping — treat it as a potential data incident and escalate rather than closing it out.

**Add the module demo layer so NO page opens empty.** The two seeds above cover customers, bookings,
payments and the employee/payroll baseline, but leave the module-level surfaces blank (ops queues, AI
analytics, ledger, incentives, attendance, partner earnings, intelligence reports). This third seed
fills exactly those gaps with a small, legible, fully derivable data set:
```bash
npx wrangler d1 execute pawspace-staging --remote --file=scripts/uat-demo-seed.sql
```
Idempotent, `UATD`-marked (never collides with the other two seeds), regenerate with
`node --experimental-strip-types scripts/uat-demo-seed-gen.mjs`. Every CREATE TABLE inside it is copied
verbatim from the source file that owns it, and the generator refuses to emit a column that does not
exist in that real DDL.
It carries 12 bookings across all six verticals (including one cancelled so revenue exclusions are
visible), boarding stays, walk sessions, taxi trips, 4 demo employees with a full payroll run,
attendance, leave, incentives, productivity facts, AI conversations/handoff/voice/CSAT, app installs,
a ledger with a deliberately unbalanced journal plus duplicate and outlier vendor bills (so the
finance anomaly report is not empty), commercial terms with computed payouts, CRM leads and tickets,
ratings, vaccinations and birthdays.

It also carries the sales-performance and campaign layer: 4 reps mapped to the `sales` team, 27 leads
with SLA clocks, recorded calls and conversions into the seeded bookings, an active productivity
policy, a live governed campaign with its audience snapshot and holdout, one campaign awaiting
approval, and ad spend rows so the CAC line has real figures instead of `configuration_required`.
Those rows reference the customers and bookings from `staging-seed.sql`, which is why that seed loads
first. After loading, open `/team/performance` and press **Generate 30-day report** — one click turns
the seeded lead work into a ranked leaderboard, and is also the check that the whole
policy -> run -> board pipeline is live.

`tests/uat-demo-seed.test.mjs` loads this file into an empty database and asserts every module's real
route handler returns non-empty data. `tests/uat-demo-seed-sales-marketing.test.mjs` covers the sales
and campaign layer, loading the staging seed alongside it because that layer is measured against it.

The AI rows are the one part not hand-written: `scripts/ai-demo-run.mjs` executes the REAL AI libs
against an in-memory database and the generator dumps whatever they wrote. Those tables store an
engine vocabulary (`outcome`, `policy_decision`, `intent_code`, `queue_code`, and a SHA-256
`immutable_hash`), so hand-written rows passed the column check while carrying values the engine can
never emit. What the seed therefore contains: the activated assistant grounding (profile, system
policy, 10 approved knowledge articles, 5 intents) with genuine digests and its full lifecycle audit
trail; 7 governed turns across WhatsApp, chat and voice — 4 contained and 3 handed off (an explicit
request for a human, a refund policy-risk block routed to `finance-cx`, and a fail-closed voice turn);
one handoff taken over by staff so `/team/ai/handoff` opens on a live case; a voice call transferred
to an agent; and 2 explicit CSAT ratings. The AI replies come from a declared scripted provider
recorded as `provider='uat_demo_scripted'` on every turn — nothing in the seed is output from a live
model. The rollout stage is seeded to `staff_only`: the assistant answers the internal team, and
widening it to customers stays a human decision on `/team/ai/rollout`.

### Switching the assistant on

Four independent conditions all have to be met, and `/team/ai/configuration` now shows each one with a
tick or a cross plus what to do about it:

1. **Model provider** — set `PAWSPACE_AI_PROVIDER_API_KEY` (see the secrets list above). Without it the
   orchestrator hands every conversation to a human, by design.
2. **Grounding** — assistant profile, system policy, approved knowledge and intent catalogue must be
   active. On a fresh environment press **Install starter assistant grounding** on
   `/team/ai/configuration` (or `POST /api/ai-bootstrap`); the demo seed already carries it.
3. **Rollout audience** — `off` by default. Widen it on `/team/ai/rollout`.
4. **Kill switches** — nothing thrown. The Disable/Enable AI buttons on the configuration screen.

**Best option — MASKED REAL data** (the actual 4-year book, safe for staging). Run the importer against
`The_PawSpace_TRUTH.xlsx` locally (the workbook and the generated SQL contain customer data — never
commit either; keep them off shared drives):
```bash
python3 scripts/import-truth-xlsx.py /path/to/The_PawSpace_TRUTH.xlsx --mode masked --out truth-masked.sql
npx wrangler d1 execute pawspace-staging --remote --file=truth-masked.sql && rm truth-masked.sql
```
This imports all **17,321 real customers / 34,984 orders / ₹11.24Cr gross** with segments, dormancy,
next-best-actions and exact service mix — so every report and the targeting/outbound modules show TRUE
business numbers — while **phones are rewritten to non-dialable placeholders and names shortened**, so no
tester action can ever reach a real customer even with integrations switched on. After UAT, the same
importer runs with `--mode live` against production for the real go-live import (real names/phones;
marketing consent stays 0 until captured fresh — DPDP).

## What to open (append to your staging URL)
Customer `/` `/mobile-app` `/services` `/account` · Providers `/partner` `/groomer` `/host` … `/partner/onboarding`
· Sales/CRM `/crm` `/team/sales` `/team/marketing` `/team/daily-revenue` · Ops `/ops` `/booking-command-center`
· Finance `/team/finance` · **New admin screens:** `/team/acquisition-funnel` `/team/catalogue`
`/team/subscription-plans` `/team/pricing-rules` `/team/provider-verification` `/team/ai/rollout` `/team/i18n`.

## Safety
`PAWSPACE_PAYMENT_ENV=sandbox` by default; live payments stay double-gated off. Throwaway staging DB, no
production data or credentials. Turn integrations on one at a time, here, verifying each before the next.

## Note
The deploy wiring targets the real vinext build output and is best validated on the first run. If the
first Actions run surfaces anything, share the log — I'll drive it to green.
