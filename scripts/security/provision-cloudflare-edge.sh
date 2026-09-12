#!/usr/bin/env bash
set -euo pipefail

API="https://api.cloudflare.com/client/v4"
ZONE_ID="${PAWSPACE_EDGE_ZONE_ID:-}"
HOST="${PAWSPACE_EDGE_HOST:-}"
TOKEN="${CLOUDFLARE_API_TOKEN:-}"
DRY_RUN="${PAWSPACE_EDGE_DRY_RUN:-false}"
MANAGED_WAF_ID="efb7b8c949ac4650a09736fc376e9aee"

log(){ printf '[EDGE-PROVISION] %s\n' "$*"; }
die(){ printf '[EDGE-PROVISION][FAIL] %s\n' "$*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null || die "$1 is required"; }
need curl; need jq
[[ -n "$ZONE_ID" ]] || die "PAWSPACE_EDGE_ZONE_ID is required"
[[ -n "$HOST" ]] || die "PAWSPACE_EDGE_HOST is required"
case "$HOST" in *.workers.dev) die "workers.dev cannot provide the required zone WAF proof; use a Cloudflare-managed custom hostname";; esac
if [[ "$DRY_RUN" != "true" ]]; then [[ -n "$TOKEN" ]] || die "CLOUDFLARE_API_TOKEN with Zone WAF/Rulesets Write is required"; fi

api(){
  local method="$1" path="$2" payload="${3:-}" tmp code
  tmp="$(mktemp)"
  if [[ "$DRY_RUN" == "true" && "$method" != "GET" ]]; then
    log "DRY_RUN $method $path payload=$payload"
    printf '%s\n' '{"success":true,"result":{"id":"dry-run"}}'
    rm -f "$tmp"; return 0
  fi
  code="$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$API$path" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    ${payload:+--data "$payload"})"
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    cat "$tmp" >&2; rm -f "$tmp"; die "Cloudflare API $method $path returned HTTP $code"
  fi
  jq -e '.success == true' "$tmp" >/dev/null || { cat "$tmp" >&2; rm -f "$tmp"; die "Cloudflare API reported failure"; }
  cat "$tmp"; rm -f "$tmp"
}

if [[ "$DRY_RUN" != "true" ]]; then
  zone="$(api GET "/zones/$ZONE_ID")"
  zone_name="$(jq -r '.result.name' <<<"$zone")"
  zone_status="$(jq -r '.result.status' <<<"$zone")"
  [[ "$zone_status" == "active" ]] || die "zone $zone_name is not active (status=$zone_status)"
  [[ "$HOST" == "$zone_name" || "$HOST" == *".$zone_name" ]] || die "host $HOST is not inside zone $zone_name"
  log "zone=$zone_name status=$zone_status host=$HOST"
else
  log "dry-run host=$HOST zone_id=$ZONE_ID"
fi

entrypoint_id(){
  local phase="$1" tmp code body
  if [[ "$DRY_RUN" == "true" ]]; then printf '%s\n' "dry-$phase"; return; fi
  tmp="$(mktemp)"
  code="$(curl -sS -o "$tmp" -w '%{http_code}' "$API/zones/$ZONE_ID/rulesets/phases/$phase/entrypoint" -H "Authorization: Bearer $TOKEN")"
  if [[ "$code" == "200" ]]; then jq -er '.result.id' "$tmp"; rm -f "$tmp"; return; fi
  if [[ "$code" != "404" ]]; then cat "$tmp" >&2; rm -f "$tmp"; die "cannot read $phase entrypoint (HTTP $code)"; fi
  rm -f "$tmp"
  body="$(jq -cn --arg p "$phase" '{name:"PawSpace edge entrypoint",description:"PawSpace pre-freeze edge hardening",kind:"zone",phase:$p,rules:[]}')"
  api POST "/zones/$ZONE_ID/rulesets" "$body" | jq -er '.result.id'
}

upsert_rule(){
  local phase="$1" ref="$2" payload="$3" rs existing
  rs="$(entrypoint_id "$phase")"
  if [[ "$DRY_RUN" == "true" ]]; then api POST "/zones/$ZONE_ID/rulesets/$rs/rules" "$payload" >/dev/null; return; fi
  existing="$(api GET "/zones/$ZONE_ID/rulesets/$rs" | jq -r --arg ref "$ref" '.result.rules[]? | select(.ref==$ref) | .id' | head -1)"
  if [[ -n "$existing" ]]; then
    api PATCH "/zones/$ZONE_ID/rulesets/$rs/rules/$existing" "$payload" >/dev/null
    log "updated ref=$ref phase=$phase"
  else
    api POST "/zones/$ZONE_ID/rulesets/$rs/rules" "$payload" >/dev/null
    log "created ref=$ref phase=$phase"
  fi
}

HOST_EXPR="http.host eq \"$HOST\""
API_EXPR="($HOST_EXPR and starts_with(http.request.uri.path, \"/api/\"))"
AUTH_EXPR="($HOST_EXPR and http.request.uri.path in {\"/api/customer-otp\" \"/api/partner-otp\" \"/api/staging-login\" \"/api/identity-session\"})"
ATTACK_EXPR="($HOST_EXPR and (lower(url_decode(http.request.uri.query)) contains \"' or 1=1--\" or lower(url_decode(http.request.uri.query)) contains \"<script\" or lower(url_decode(http.request.uri.query)) contains \"javascript:\"))"
BOT_EXPR="($API_EXPR and (http.user_agent contains \"HeadlessChrome\" or http.user_agent contains \"Playwright\" or http.user_agent contains \"Puppeteer\" or http.user_agent contains \"PhantomJS\" or http.user_agent contains \"Selenium\"))"

managed="$(jq -cn --arg id "$MANAGED_WAF_ID" --arg e "$HOST_EXPR" '{action:"execute",action_parameters:{id:$id},expression:$e,description:"PawSpace Cloudflare Managed WAF",ref:"pawspace_managed_waf",enabled:true}')"
upsert_rule http_request_firewall_managed pawspace_managed_waf "$managed"

attack="$(jq -cn --arg e "$ATTACK_EXPR" '{action:"block",expression:$e,description:"PawSpace explicit SQLi/XSS edge block",ref:"pawspace_sqli_xss_block",enabled:true}')"
upsert_rule http_request_firewall_custom pawspace_sqli_xss_block "$attack"

bot="$(jq -cn --arg e "$BOT_EXPR" '{action:"managed_challenge",expression:$e,description:"PawSpace challenge common headless automation on public APIs",ref:"pawspace_headless_challenge",enabled:true}')"
upsert_rule http_request_firewall_custom pawspace_headless_challenge "$bot"

auth_rl="$(jq -cn --arg e "$AUTH_EXPR" '{action:"block",expression:$e,description:"PawSpace auth/OTP 5 requests per minute per IP",ref:"pawspace_auth_5rpm",enabled:true,ratelimit:{characteristics:["cf.colo.id","ip.src"],period:60,requests_per_period:5,mitigation_timeout:60,requests_to_origin:false}}')"
upsert_rule http_ratelimit pawspace_auth_5rpm "$auth_rl"

global_rl="$(jq -cn --arg e "$API_EXPR" '{action:"block",expression:$e,description:"PawSpace public API 100 requests per minute per IP",ref:"pawspace_api_100rpm",enabled:true,ratelimit:{characteristics:["cf.colo.id","ip.src"],period:60,requests_per_period:100,mitigation_timeout:60,requests_to_origin:false}}')"
upsert_rule http_ratelimit pawspace_api_100rpm "$global_rl"

log "EDGE_PROVISION_RESULT=SUCCESS host=$HOST managed_waf=enabled sqli_xss=block headless=managed_challenge api_rpm=100 auth_rpm=5"
