# Ad spend connectors — Google Ads, Meta, Supermetrics

Two routes to the same numbers, so you can pull spend either way and compare before committing to one:

| Route | Reads spend | Can change a live campaign |
| --- | --- | --- |
| Google Ads API (direct) | yes | yes — pause, resume, daily budget |
| Meta Marketing API (direct) | yes | yes — pause, resume, daily budget |
| Supermetrics | yes (fronts both platforms) | no, by design |

The screen is `/team/marketing/ad-spend`. The rule the module keeps: **spend is either real or absent.** An account whose credentials are missing reports exactly which ones and writes nothing, because the CAC line in `lib/unit-economics.ts` divides by whatever lands in `marketing_attribution_facts`.

## 1. Credentials (Cloudflare secrets)

Set each with `npx wrangler secret put NAME` against the target environment. Nothing goes in the repo, and the screen only ever reports whether a secret is present — never its value.

### Google Ads

```
GOOGLE_ADS_DEVELOPER_TOKEN     # Google Ads API Center → developer token (needs Basic access approval)
GOOGLE_ADS_CLIENT_ID           # Google Cloud → OAuth 2.0 client (Desktop or Web)
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_REFRESH_TOKEN       # generated once via the OAuth consent flow for a user with account access
GOOGLE_ADS_LOGIN_CUSTOMER_ID   # optional: the MCC id, if the account sits under a manager account
```

Getting the developer token approved is the long pole — apply from the Google Ads UI (Tools → API Center) before anything else. The account id on the screen is the customer id in `123-456-7890` form.

### Meta

```
META_ADS_ACCESS_TOKEN          # system user token from Business Manager, with ads_read
```

Add `ads_management` to that token only if you intend to pause campaigns or move budgets from here. The account id is `act_<ad account id>`.

### Supermetrics

```
SUPERMETRICS_API_KEY           # from the Supermetrics API / Enterprise product
SUPERMETRICS_DS_USER           # the authorised data-source user (usually the connecting email)
```

Each Supermetrics account also needs its data source id (`ds_id`) on the screen — `AW` for Google Ads, `FA` for Facebook/Meta Ads. The query requests the canonical fields `Date, Campaign_ID, Campaign, Cost, Impressions, Clicks, Currency`; a data source configured with a different field set fails the sync naming the missing field rather than quietly reporting no spend.

## 2. Connect an account

1. Open `/team/marketing/ad-spend`. The **Credentials** panel shows, per provider, which secrets are present and which are missing.
2. Add the account: provider, the platform's own account id, a label. Leave **Live changes** off — an account is read-only until someone deliberately switches it on.
3. Press **Pull spend** for the window you want. Spend is stored per campaign per day; re-pulling an overlapping window restates those days rather than adding a second copy of them.
4. **Map the campaigns.** Spend is only attributed to a governed campaign once its platform campaign is linked to one; anything unlinked is held and shown as awaiting mapping. Once linked, the campaign's spend becomes the `marketing_attribution_facts` row the CAC line reads.

The scheduler re-pulls a trailing 7-day window hourly for every configured account, so late-arriving platform costs settle without anyone pressing a button. With no account configured it is a no-op.

## 3. Changing live campaigns from this tool

Turn writes on per account, choosing **Preview only** (shows the exact request without sending it) or **Live**. A live account also needs a **daily budget ceiling**, and every change requires a reason and an approval reference, both recorded against the actor in `ad_platform_changes`.

What is enforced, in code:

- Supermetrics can never change a campaign, however it is configured.
- A write-disabled account refuses the call before anything is sent.
- A budget above the account's ceiling is refused — a mistyped amount cannot run away.
- The idempotency key is claimed before the platform call, so a retried click cannot apply the change twice.
- Applied, previewed, refused and failed all land in the change log with before/after and the error, visible at the bottom of the screen.

## 4. What this does not do

- **No conversion attribution.** Only platform-reported cost is imported. Nothing here claims which booking came from which ad; `attribution_model` records `<provider>_platform_reported` so no report can imply otherwise.
- **No campaign creation.** Campaigns are created in the ad platforms; this tool reads them, maps them and can pause/resume/rebudget them.
- **No spend without credentials.** There is no fallback, sample or estimated number anywhere in this path.
