/**
 * The registry and the refusals shared by scripts/d1-backup.mjs and scripts/d1-restore.mjs.
 *
 * It lives in its own module for one reason: the refusals are the load-bearing part of restore
 * tooling, and they must be testable without a Cloudflare account. tests/d1-backup-restore-guards
 * imports this directly and drives every refusal path. What CANNOT be tested without credentials is
 * whether a real restore works — that is what the drill in ops/database-restore-runbook.md is for,
 * and no amount of unit testing substitutes for having run one.
 *
 * Databases are addressed BY NAME throughout. wrangler accepts a name and resolves the uuid itself,
 * so no D1 identifier is ever read, logged, or written to an evidence file by this tooling.
 */

/** Databases this repository deploys, taken from scripts/stage-config.mjs and scripts/prod-config.mjs. */
export const ENVIRONMENTS = {
  staging: {
    database: "pawspace-staging",
    production: false,
    /* Synthetic UAT data. A destructive in-place restore here is an ordinary operation, which is why
     * the time-travel drill is run against staging and never against production. */
    destructiveDrillAllowed: true,
  },
  production: {
    database: "pawspace-prod-bengaluru",
    production: true,
    destructiveDrillAllowed: false,
  },
};

export class RefusedError extends Error {
  constructor(message) { super(message); this.name = "RefusedError"; }
}

const refuse = (message) => { throw new RefusedError(message); };

export function resolveEnvironment(name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) refuse(`An environment is required. Known environments: ${Object.keys(ENVIRONMENTS).join(", ")}.`);
  const environment = ENVIRONMENTS[key];
  /* No fuzzy matching and no default. "prod" must not silently resolve to production, and a typo must
   * not resolve to anything at all. */
  if (!environment) refuse(`Unknown environment "${key}". Known environments: ${Object.keys(ENVIRONMENTS).join(", ")}.`);
  return { key, ...environment };
}

/**
 * Credentials are checked for PRESENCE only and never read into a log line or an evidence file.
 * wrangler reads them from the process environment itself.
 */
export function requireCredentials(env = process.env) {
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((name) => !String(env[name] ?? "").trim());
  if (missing.length) {
    refuse(`Not authenticated: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. ` +
      `Export them for this shell, or run this from a runner that injects them. They are never read from a repository file.`);
  }
  return true;
}

/**
 * Exactly one restore source. Passing a bookmark AND a file is not a preference to be resolved by
 * precedence - it means the operator has two different beliefs about what they are restoring, and
 * guessing which one they meant is how the wrong data gets restored.
 */
export function resolveRestoreSource({ bookmark, timestamp, file } = {}) {
  const supplied = [
    bookmark ? { kind: "bookmark", value: String(bookmark).trim() } : null,
    timestamp ? { kind: "timestamp", value: String(timestamp).trim() } : null,
    file ? { kind: "file", value: String(file).trim() } : null,
  ].filter(Boolean);
  if (!supplied.length) refuse("A restore source is required: --bookmark, --timestamp or --file.");
  if (supplied.length > 1) {
    refuse(`Exactly one restore source may be given; got ${supplied.map((item) => `--${item.kind}`).join(" and ")}. ` +
      `Two sources means two different beliefs about what is being restored.`);
  }
  return supplied[0];
}

/**
 * Production needs TWO independent, deliberate acts, matching how .github/workflows/deploy-production.yml
 * already gates a production deploy: a typed confirmation naming the exact database, and an environment
 * variable set outside the command line. Either alone is something a person can do by reflex - pressing
 * up-arrow on a previous command, or having the variable left set in a shell from an hour ago. Both
 * together is a decision.
 *
 * A restore is worse than a deploy: it overwrites customer data and a deploy does not.
 */
export function assertRestoreAllowed({ environment, confirmProduction, env = process.env } = {}) {
  if (!environment?.production) return { gated: false };
  const typed = String(confirmProduction ?? "").trim();
  const allow = String(env.PAWSPACE_RESTORE_ALLOW_PRODUCTION ?? "").trim().toLowerCase();
  const problems = [];
  if (typed !== environment.database) {
    problems.push(`--confirm-production must be exactly "${environment.database}" (got ${typed ? `"${typed}"` : "nothing"})`);
  }
  if (allow !== "yes") problems.push(`PAWSPACE_RESTORE_ALLOW_PRODUCTION must be set to "yes" in the environment`);
  if (problems.length) {
    refuse(`Refusing to restore PRODUCTION (${environment.database}).\n` +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      `\n\nA restore overwrites live customer data. Both gates exist so that no single reflex can start one.`);
  }
  return { gated: true };
}

/** A drill must not quietly become a production incident. */
export function assertDrillAllowed(environment) {
  if (!environment.destructiveDrillAllowed) {
    refuse(`Refusing to run a destructive drill against ${environment.database}. ` +
      `Time-travel restores in place, so a drill here would overwrite live data. ` +
      `Drill the time-travel path on staging; drill the file path into a scratch database (see ops/database-restore-runbook.md).`);
  }
  return true;
}

/**
 * RPO is the age of the recovery point at the moment it is restored - how much work the restore
 * discards. It is a MEASUREMENT, not a target, and it is computed from real timestamps or not at all.
 */
export function computeRpoSeconds({ incidentAt, recoveryPointAt }) {
  /* null and undefined are checked BEFORE Number(), because Number(null) is 0 - so a missing recovery
   * point would otherwise be read as "the epoch" and reported as a definite, enormous RPO instead of
   * an unknown one. Unknown must stay unknown; it is the caller's job to notice it has no measurement. */
  if (incidentAt == null || recoveryPointAt == null) return null;
  const incident = Number(incidentAt), point = Number(recoveryPointAt);
  if (!Number.isFinite(incident) || !Number.isFinite(point)) return null;
  return Math.max(0, Math.round((incident - point) / 1000));
}
