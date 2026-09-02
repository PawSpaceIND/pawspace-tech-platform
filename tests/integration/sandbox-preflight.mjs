/**
 * Shared preflight for the sandbox contract suites.
 *
 * These suites are the one place in this repo that talks to somebody else's server. That makes them
 * valuable for exactly one thing the local suites cannot do — proving the third party still behaves the
 * way our code assumes — and unsuitable as a blocking gate, because they can go red for reasons that
 * have nothing to do with our change: an expired sandbox key, a provider's maintenance window, an
 * egress rule.
 *
 * So the default posture is SKIP WITH A DIAGNOSIS, not fail. A run that cannot reach the sandbox says
 * so in terms an operator can act on, names the exact environment variables involved, and exits green.
 * Set PAWSPACE_SANDBOX_TESTS_STRICT=true to invert that — in a pipeline whose whole job is to assert
 * the sandboxes are wired, a skip IS the failure.
 *
 * Nothing here ever prints a credential. Presence is reported by NAME, and an optional fingerprint is
 * the first 8 hex of a SHA-256 — enough to tell "my key rotated" from "my key is wrong", useless to
 * anyone who reads a log.
 */
import { createHash } from "node:crypto";

export const STRICT = String(process.env.PAWSPACE_SANDBOX_TESTS_STRICT || "").toLowerCase() === "true";
const DEFAULT_TIMEOUT_MS = Number(process.env.PAWSPACE_SANDBOX_PROBE_TIMEOUT_MS || 12_000);

const present = (name) => String(process.env[name] || "").trim().length > 0;

/** First 8 hex of SHA-256. Identifies which secret is loaded without disclosing any of it. */
export function fingerprint(name) {
  const value = String(process.env[name] || "");
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 8) : "absent";
}

/**
 * Reachability, classified into the three outcomes that need different operator responses.
 *
 * The distinction that matters is `credentials_rejected` vs `endpoint_unreachable`. Both look like "the
 * test did not run", and they have opposite fixes: rotate a key, or fix a network route. A probe that
 * collapsed them into one message would send somebody to the wrong dashboard.
 */
export async function probeEndpoint({ url, method = "GET", headers = {}, authenticated = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, signal: controller.signal, redirect: "manual" });
    if (authenticated && [401, 403].includes(response.status)) {
      return { kind: "credentials_rejected", status: response.status, detail: `the sandbox answered ${response.status} to an authenticated probe` };
    }
    // Any other answer means the route works and TLS completed, which is all a probe is for. A 400 to a
    // deliberately argument-free probe is a healthy endpoint, not a fault.
    return { kind: "ok", status: response.status, detail: `reachable (HTTP ${response.status})` };
  } catch (error) {
    const aborted = controller.signal.aborted;
    // undici collapses every transport failure into "TypeError: fetch failed" and puts the useful part
    // in `cause` — the DNS miss, the refused connection, the certificate rejection. A diagnostic that
    // stops at "fetch failed" cannot tell an operator whether to look at DNS, a firewall or a proxy, so
    // the cause chain is unwrapped here.
    const cause = error?.cause;
    const causeDetail = cause ? ` (${[cause.code, cause.syscall, cause.hostname, cause.message].filter(Boolean).join(" ")})`.slice(0, 160) : "";
    return {
      kind: "endpoint_unreachable",
      status: null,
      detail: aborted ? `no response within ${timeoutMs}ms` : `${error?.name || "Error"}: ${String(error?.message || error).slice(0, 120)}${causeDetail}`,
    };
  } finally { clearTimeout(timer); }
}

/**
 * Decide whether a suite can run, and produce the diagnosis if not.
 *
 * `required` is checked before any network call: there is no point probing an authenticated endpoint
 * with no credential, and doing so would report `credentials_rejected` for what is really
 * `credentials_absent`.
 */
export async function preflight({ suite, required = [], probe = null, ownerAction = null }) {
  const missing = required.filter(entry => !present(entry.name));
  if (missing.length) {
    return finalise({ suite, ready: false, kind: "credentials_absent", detail: null, required, missing, ownerAction });
  }
  if (probe) {
    const result = await probeEndpoint(probe);
    if (result.kind !== "ok") {
      return finalise({ suite, ready: false, kind: result.kind, detail: result.detail, required, missing: [], ownerAction, probe });
    }
    return finalise({ suite, ready: true, kind: "ready", detail: result.detail, required, missing: [], ownerAction, probe });
  }
  return finalise({ suite, ready: true, kind: "ready", detail: "no probe configured", required, missing: [], ownerAction });
}

const REASONS = {
  credentials_absent: "sandbox credentials are not configured in this environment",
  credentials_rejected: "the sandbox rejected the configured credentials (expired, revoked or wrong environment)",
  endpoint_unreachable: "the sandbox endpoint could not be reached from this environment",
};

function finalise(state) {
  const line = "─".repeat(78);
  const rows = [];
  rows.push(line);
  rows.push(`SANDBOX PREFLIGHT · ${state.suite}  →  ${state.ready ? "READY" : STRICT ? "FAILING (strict mode)" : "NOT RUN"}`);
  if (state.ready) {
    rows.push(`  endpoint:      ${state.probe?.url ?? "(none)"} — ${state.detail}`);
    rows.push(`  credentials:   ${state.required.map(entry => `${entry.name}=${fingerprint(entry.name)}`).join("  ") || "(none required)"}`);
  } else {
    rows.push(`  reason:        ${state.kind} — ${REASONS[state.kind] ?? "unknown"}`);
    if (state.detail) rows.push(`  detail:        ${state.detail}`);
    if (state.missing.length) {
      rows.push(`  missing:       ${state.missing.map(entry => entry.name).join(", ")}`);
      for (const entry of state.missing) if (entry.hint) rows.push(`    ${entry.name}: ${entry.hint}`);
    }
    if (state.probe?.url) rows.push(`  endpoint:      ${state.probe.url}`);
    if (state.ownerAction) rows.push(`  owner action:  ${state.ownerAction}`);
    rows.push(`  strict mode:   ${STRICT ? "ON — this run FAILS" : "off — set PAWSPACE_SANDBOX_TESTS_STRICT=true to make this a failure"}`);
    rows.push(`  to run:        supply the variables above, then \`npm run test:integration\``);
  }
  rows.push(line);
  const diagnostics = rows.join("\n");

  // Printed once at import, so the diagnosis is in the log even when every case below is skipped and
  // the runner reports nothing but "ok ... # SKIP".
  console.log(diagnostics);

  return {
    ...state,
    diagnostics,
    reason: state.ready ? null : `${state.kind}: ${REASONS[state.kind] ?? "unknown"}`,
    /**
     * Spread into a node:test call: `test(name, gate(state), fn)`.
     *
     * In strict mode this deliberately returns no skip, so the body runs, throws on the unconfigured
     * client and reports a real failure — rather than a passing skip that a pipeline would read as
     * "the sandbox is fine".
     */
    gate() { return state.ready || STRICT ? {} : { skip: this.reason }; },
  };
}
