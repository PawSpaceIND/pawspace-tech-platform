# Marketing connector configuration

The marketing module stores reporting truth in PawSpace canonical tables. Direct Google Ads, direct Meta Ads, and Supermetrics are ingestion paths; they do not create separate reporting authorities.

## Safety defaults

- `PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED=false` keeps budget/bid mutations off.
- `PAWSPACE_GOOGLE_DATA_MANAGER_UPLOAD_ENABLED=false` keeps Google offline conversion uploads validate-only/disabled.
- `PAWSPACE_META_CAPI_UPLOAD_ENABLED=false` keeps Meta CAPI delivery off.
- `PAWSPACE_SUPERMETRICS_SYNC_ENABLED=false` keeps Supermetrics reads off until its API key and queries are configured.

## Direct Google Ads

Required: `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_OAUTH_ACCESS_TOKEN`. Optional/advanced: `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_API_VERSION`.

Offline conversion delivery additionally requires `GOOGLE_DATA_MANAGER_OAUTH_ACCESS_TOKEN` and conversion action IDs: `GOOGLE_ADS_CONVERSION_ACTION_LEAD_QUALIFIED`, `GOOGLE_ADS_CONVERSION_ACTION_BOOKING_CREATED`, `GOOGLE_ADS_CONVERSION_ACTION_PAYMENT_CAPTURED`.

## Direct Meta Ads / CAPI

Reporting requires `META_ADS_ACCOUNT_ID`, `META_ADS_ACCESS_TOKEN`, and explicit `META_ADS_API_VERSION`.

CAPI additionally requires `META_PIXEL_ID` and `META_CAPI_ACCESS_TOKEN` plus `PAWSPACE_META_CAPI_UPLOAD_ENABLED=true` after controlled-live certification.

## Supermetrics read connector

Required: `SUPERMETRICS_API_KEY`, `SUPERMETRICS_QUERY_CONFIG_JSON`, and `PAWSPACE_SUPERMETRICS_SYNC_ENABLED=true`.

The connector calls the server-side Supermetrics `keyjson` API with bearer authentication. Queries can target `google_ads`, `meta_ads`, or `ga4`. Google/Meta rows are normalized into `marketing_ad_metric_facts`; GA4 rows are stored separately in `marketing_web_metric_facts`.

Example query configuration shape:

```json
{
  "queries": [
    {
      "name": "google-ads-reporting",
      "platform": "google_ads",
      "ds_id": "YOUR_SUPERMETRICS_DATA_SOURCE_ID",
      "ds_accounts": "YOUR_CONNECTED_ACCOUNT",
      "fields": "date,account_id,campaign_id,campaign_name,impressions,clicks,spend,conversions,conversion_value,currency"
    },
    {
      "name": "ga4-web-reporting",
      "platform": "ga4",
      "ds_id": "YOUR_GA4_SUPERMETRICS_DATA_SOURCE_ID",
      "ds_accounts": "YOUR_CONNECTED_PROPERTY",
      "fields": "date,source_medium,campaign_name,landing_page,device,sessions,users,new_users,engaged_sessions,conversions,conversion_value,currency"
    }
  ]
}
```

If a source exposes different field IDs, provide a `fieldMap` in that query rather than changing PawSpace's canonical schema.

## Deployment rule

Store API keys/tokens as encrypted secrets. Store non-sensitive account IDs, API versions, query JSON, and enablement flags as deployment variables where appropriate. A connector is only `verified_connected` after a successful external read has been recorded; presence of credentials alone is `configured_unverified`.
