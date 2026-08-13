// Checks the Cloudflare account audit log over a window, to finish an API-token rotation.
//
// It answers two questions a rotation is not complete without:
//   1. Was the old token DELETED, or merely superseded? A superseded token still authenticates.
//   2. Did anything happen in the exposure window that nobody on the team did?
//
// WHAT THIS CANNOT TELL YOU — read this before treating a clean run as an all-clear. Cloudflare's
// audit log records CONTROL-PLANE actions: configuration changes made through the dashboard or API.
// It does NOT record every data-plane request made with a token. An exposed token with D1 access
// could have run `wrangler d1 execute` reads against staging and left NOTHING in this log. The
// signals for that are the token's "Last used" timestamp (visible on the API Tokens page, and
// destroyed along with the token — capture it BEFORE deleting) and Workers/D1 request analytics.
//
// Usage:
//   export CLOUDFLARE_API_TOKEN=<the NEW token; needs Account Audit Logs or Analytics: Read>
//   export CLOUDFLARE_ACCOUNT_ID=<account id, or pass --account=>
//   node scripts/cloudflare-audit-check.mjs --since=2026-08-01T00:00:00Z --before=2026-08-14T00:00:00Z
//
// Exit code 0 only when a token deletion was found AND nothing sensitive is unexplained, so this can
// sit in a checklist. Any error exits non-zero — it never reports "clean" when it could not look.

const API = "https://api.cloudflare.com/client/v4";

/**
 * Action types worth a human look in a token-exposure window. Each is a way to keep access, widen
 * it, or move data out — the things an attacker does after acquiring a credential, as opposed to the
 * routine deploys and secret-puts a rotation itself produces.
 */
export const SENSITIVE_PATTERNS = [
  { pattern: /token.*(create|add)|create.*token/i, why: "a new API token was created — an attacker's way to keep access after your rotation" },
  { pattern: /member.*(add|invite)|invite/i, why: "an account member was added or invited" },
  { pattern: /logpush|log.?destination|logpull/i, why: "a log destination was added — a route for moving data out" },
  { pattern: /r2.*(create|bucket)|bucket.*create/i, why: "an R2 bucket was created — somewhere to stage exfiltrated data" },
  { pattern: /d1.*(create|delete|drop)/i, why: "a D1 database was created or deleted" },
  { pattern: /(worker|script).*(deploy|create|update|delete)/i, why: "a Worker was deployed or changed — arbitrary code on your account" },
  { pattern: /dns.*(create|update|delete)|zone.*(create|delete)/i, why: "DNS or zone configuration changed" },
  { pattern: /(role|permission|policy).*(update|create|grant)/i, why: "permissions were changed" },
  { pattern: /2fa|two.?factor|password/i, why: "an account security setting changed" },
];

/** Did this entry delete or revoke an API token? That is the event a rotation is not done without. */
export const TOKEN_DELETION = /token.*(delete|revoke|roll)|(delete|revoke|roll).*token/i;

const actionOf = (entry) => {
  const action = entry?.action;
  const type = typeof action === "string" ? action : action?.type || action?.result || "";
  const resource = entry?.resource?.type || entry?.resource?.id || "";
  return `${type} ${resource}`.trim();
};
const actorOf = (entry) => entry?.actor?.email || entry?.actor?.id || entry?.actor?.type || "unknown";
const whenOf = (entry) => entry?.when || entry?.timestamp || entry?.created_at || "";

/**
 * Sorts audit entries into what needs a human look and what does not. Pure, so it is testable
 * without a network call and without credentials.
 */
export function classifyAuditEntries(entries) {
  const sensitive = [], routine = [], byAction = new Map();
  let tokenDeletions = 0;

  for (const entry of entries) {
    const action = actionOf(entry) || "(unlabelled action)";
    byAction.set(action, (byAction.get(action) || 0) + 1);
    if (TOKEN_DELETION.test(action)) tokenDeletions += 1;

    const hit = SENSITIVE_PATTERNS.find((candidate) => candidate.pattern.test(action));
    const record = { when: whenOf(entry), actor: actorOf(entry), action, why: hit?.why };
    // A token deletion is expected during a rotation, so it is not itself a finding — but a token
    // CREATION is, even though both match "token".
    if (hit && !TOKEN_DELETION.test(action)) sensitive.push(record);
    else routine.push(record);
  }

  return {
    total: entries.length,
    tokenDeletions,
    sensitive,
    routine,
    byAction: [...byAction.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function arg(name) {
  const match = process.argv.find((item) => item.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : "";
}

async function fetchAuditLog({ accountId, token, since, before }) {
  const entries = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `${API}/accounts/${accountId}/audit_logs?since=${encodeURIComponent(since)}&before=${encodeURIComponent(before)}&per_page=100&page=${page}`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success) {
      // Never report "clean" when the check could not run. The token most likely lacks the audit-log
      // read permission, or this account uses the newer /logs/audit endpoint with a different shape.
      const detail = body?.errors?.map((item) => item.message).join("; ") || `HTTP ${response.status}`;
      throw new Error(`Audit log request failed: ${detail}\nIf this says the schema or route is unknown, check Cloudflare's current audit-log API reference — the endpoint has more than one generation.`);
    }
    const batch = body.result || [];
    entries.push(...batch);
    if (batch.length < 100) break;
  }
  return entries;
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN || "";
  const accountId = arg("account") || process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const since = arg("since"), before = arg("before") || new Date().toISOString();

  const missing = [];
  if (!token) missing.push("CLOUDFLARE_API_TOKEN (the NEW token, with Account Audit Logs or Analytics: Read)");
  if (!accountId) missing.push("CLOUDFLARE_ACCOUNT_ID or --account= (npx wrangler whoami prints it)");
  if (!since) missing.push("--since=<RFC3339> — start it BEFORE the token was first exposed, not today");
  if (missing.length) {
    console.error(`Missing:\n${missing.map((item) => `  - ${item}`).join("\n")}`);
    process.exit(2);
  }

  const entries = await fetchAuditLog({ accountId, token, since, before });
  const report = classifyAuditEntries(entries);

  console.log(`Cloudflare audit log · ${since} → ${before}`);
  console.log(`${report.total} entries\n`);

  console.log("Actions in this window:");
  for (const [action, count] of report.byAction) console.log(`  ${String(count).padStart(4)}  ${action}`);

  console.log(`\nAPI token deletion/revocation events: ${report.tokenDeletions}`);
  if (!report.tokenDeletions) {
    console.log("  ✗ none found. A rotated-but-undeleted token still authenticates — delete the old one.");
  } else {
    console.log("  ✓ found. Confirm the deleted token is the exposed one, not an unrelated cleanup.");
  }

  if (report.sensitive.length) {
    console.log(`\n⚠ ${report.sensitive.length} action(s) that need a human look:`);
    for (const item of report.sensitive) console.log(`  ${item.when}  ${item.actor}\n      ${item.action}\n      ${item.why}`);
    console.log("\nEach of these is legitimate if someone on your team did it. Confirm every one by name.");
  } else {
    console.log("\nNo token creation, member addition, Logpush destination, R2/D1 change, Worker deploy,");
    console.log("DNS change or permission change in this window.");
  }

  console.log("\n--- what this does NOT cover -------------------------------------------------");
  console.log("This log records configuration changes, not data reads. A token with D1 access could");
  console.log("have queried staging and left nothing here. Check the token's 'Last used' timestamp on");
  console.log("the API Tokens page (capture it BEFORE deleting) and Workers/D1 request analytics.");
  console.log("Also settle what data was in staging during the window: synthetic seeds are low impact,");
  console.log("but a masked real-customer import is a different conversation.");

  process.exit(report.sensitive.length === 0 && report.tokenDeletions > 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`\n${error.message}`); process.exit(2); });
}
