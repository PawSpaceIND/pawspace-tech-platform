import { writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import {
  runGate as legacyRunGate,
  assertRunTag,
  ddlFromCheckout,
  sanitizeEvidenceDetail,
} from "./release-preview-gate-legacy.mjs";

export * from "./release-preview-gate-legacy.mjs";

/**
 * The hosted preview gate was written before two now-enforced product contracts:
 *
 *  1. lifecycle GET is an operator surface and requires bookings.manage, not bookings.view;
 *  2. Pet Sitting confirmation requires a live server quote plus a server-confirmed sandbox capture.
 *
 * The legacy gate remains byte-for-byte available beside this file because its behavioural suite is a
 * useful regression oracle for snapshots, refusal writes, replay, convergence and concurrency. The
 * adapter below changes only the fixture setup needed to reach those same invariants through today's
 * product contracts. It never bypasses a product guard: quotes and captures are obtained through the
 * deployed HTTP routes, and the canonical booking is still accepted or refused by the deployed handler.
 */
export const CURRENT_PRODUCT_CONTRACT = "canonical-booking-2026-08-27-v2";

// Keep fail-closed evidence recording in the active wrapper too. This is deliberately a runtime helper,
// not a source-text compatibility shim: the current-contract adapter uses it whenever its own required
// setup evidence was not exercised, so an unavailable contract check can never soften into a pass.
const unavailable = (report, name, detail) => {
  report.checks.push({ name, ok: false, detail });
  report.failures++;
};
// No constant fallback or third "not run" state is allowed for required preview evidence.

function cookieFrom(headers) {
  return String(headers?.["set-cookie"] ?? headers?.get?.("set-cookie") ?? "").split(";")[0];
}

function safeHttpError(res) {
  const raw = res?.body?.error;
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 160);
}

function statusCount(bucket, status) {
  const key = String(Number(status) || 0);
  bucket[key] = Number(bucket[key] || 0) + 1;
}

export function adaptCurrentProductContracts({ http, d1 }) {
  const sessionEmail = new Map();
  const preparedByIdentity = new Map();
  let preparationBlocked = false;
  let diagnosticsCollected = false;
  const metrics = {
    permissionRewrites: 0,
    bookerPermissionPreserved: 0,
    zoneRewrites: 0,
    quoteAttempts: 0,
    quotePreparations: 0,
    quoteFailures: 0,
    quoteFailureStatuses: {},
    captureAttempts: 0,
    captureFailures: 0,
    captureFailureStatuses: {},
    preparationSuppressions: 0,
    firstPreparationFailure: null,
    preparationDiagnostics: null,
  };

  const currentD1 = async (sql) => {
    let next = String(sql);
    if (/^INSERT OR REPLACE INTO role_definitions /i.test(next)) {
      // The lifecycle GET genuinely moved from bookings.view to bookings.manage. Only the dedicated
      // preview VIEWER needs that adaptation. The customer booker must NOT be promoted: production's
      // requireCustomerOwnership intentionally treats bookings.manage as a staff ownership bypass, so
      // rewriting preview_booker changes the security semantics and turns the wrong-owner 403 probe into
      // a later business-rule failure instead of testing ownership at all.
      if (next.includes("'preview_viewer'") && next.includes('[\"bookings.view\"]')) {
        const rewritten = next.replaceAll('[\"bookings.view\"]', '[\"bookings.manage\"]');
        if (rewritten !== next) metrics.permissionRewrites++;
        next = rewritten;
      }
      if (next.includes("'preview_booker'") && next.includes('[\"bookings.view\",\"scheduling.book\"]')) {
        metrics.bookerPermissionPreserved++;
      }
    }
    if (/^INSERT OR REPLACE INTO scheduling_reservations /i.test(next)) {
      const rewritten = next.replaceAll("'blr','koramangala'", "'blr','blr-east'");
      if (rewritten !== next) metrics.zoneRewrites++;
      next = rewritten;
    }
    return d1(next);
  };

  const applyPrepared = (body, quote) => ({
    ...body,
    cityId: "blr",
    zoneId: "blr-east",
    packageCode: quote.packageCode,
    packageName: quote.packageName,
    totalAmount: quote.totalAmount,
    amountDueNow: quote.amountDueNow,
    payment: { ...(body.payment || {}), mode: quote.paymentMode || "prepaid", status: "captured" },
    pricing: { ...(body.pricing || {}), sittingQuoteId: quote.quoteId },
  });

  const readColumns = async (table) => {
    try {
      const rows = await d1(`PRAGMA table_info(${table})`);
      return rows.map((row) => String(row.name || "")).filter(Boolean).sort();
    } catch {
      return ["<unavailable>"];
    }
  };

  const readOne = async (sql) => {
    try { return (await d1(sql))[0] ?? null; }
    catch { return null; }
  };

  const collectPreparationDiagnostics = async () => {
    if (diagnosticsCollected) return;
    diagnosticsCollected = true;
    const [sittingQuoteColumns, paymentColumns, pricingPackageColumns, pricingRuleColumns] = await Promise.all([
      readColumns("sitting_commercial_quotes"),
      readColumns("sitting_quote_payment_attestations"),
      readColumns("service_packages"),
      readColumns("dynamic_pricing_rules"),
    ]);
    const sittingPackage = await readOne("SELECT package_code,active,version,effective_from,effective_to FROM sitting_commercial_packages WHERE package_code='sitting-visit-60'");
    const pricingPackage = await readOne("SELECT package_code,service_code,active,version,effective_from,effective_to FROM service_packages WHERE package_code='sitting-visit-60'");
    let pricingRules = [];
    try {
      pricingRules = await d1("SELECT days_json FROM dynamic_pricing_rules WHERE status='published' AND service_code='pet_sitting'");
    } catch { /* table may be unavailable; the column list above records that */ }
    let invalidPublishedRuleDaysJson = 0;
    for (const row of pricingRules) {
      try {
        const parsed = JSON.parse(String(row.days_json ?? "[]"));
        if (!Array.isArray(parsed)) invalidPublishedRuleDaysJson++;
      } catch { invalidPublishedRuleDaysJson++; }
    }
    const packageShape = (row, includeService = false) => row ? {
      packageCode: String(row.package_code || ""),
      ...(includeService ? { serviceCode: String(row.service_code || "") } : {}),
      active: Number(row.active),
      version: Number(row.version),
      effectiveFrom: String(row.effective_from || ""),
      effectiveTo: row.effective_to == null ? null : String(row.effective_to),
    } : null;
    metrics.preparationDiagnostics = {
      sittingQuoteColumns,
      paymentColumns,
      pricingPackageColumns,
      pricingRuleColumns,
      sittingPackage: packageShape(sittingPackage),
      pricingPackage: packageShape(pricingPackage, true),
      publishedPricingRuleCount: pricingRules.length,
      invalidPublishedRuleDaysJson,
    };
  };

  const blockPreparation = async (phase, res) => {
    preparationBlocked = true;
    const message = safeHttpError(res);
    if (!metrics.firstPreparationFailure) {
      metrics.firstPreparationFailure = `${phase}:status=${res?.status ?? 0}${message ? `:error=${message}` : ""}`;
    }
    await collectPreparationDiagnostics();
    // This is a gate-internal dependency failure, not a response from the product. Returning a distinct
    // status keeps the legacy oracle fail-closed while preventing 75 more doomed quote/capture attempts.
    return { status: 424, body: { error: "PREVIEW_CONTRACT_PREPARATION_FAILED" }, headers: {} };
  };

  const currentHttp = async (method, requestPath, options = {}) => {
    if (requestPath === "/api/staging-login") {
      const res = await http(method, requestPath, options);
      if (res.status >= 200 && res.status < 400) {
        const cookie = cookieFrom(res.headers);
        if (cookie && options.body?.email) sessionEmail.set(cookie, String(options.body.email));
      }
      return res;
    }

    if (method === "POST" && requestPath === "/api/canonical-bookings" && options.body && typeof options.body === "object") {
      let body = { ...options.body };
      if (body.cityId === "blr" && body.zoneId === "koramangala") body.zoneId = "blr-east";

      const cacheKeys = [
        body.idempotencyKey ? `ik:${body.idempotencyKey}` : "",
        body.scheduleGroupId ? `sg:${body.scheduleGroupId}` : "",
      ].filter(Boolean);
      const cached = cacheKeys.map((key) => preparedByIdentity.get(key)).find(Boolean);
      if (cached) {
        body = applyPrepared(body, cached);
        return http(method, requestPath, { ...options, body });
      }

      const cookie = String(options.headers?.cookie ?? options.headers?.Cookie ?? "");
      const email = sessionEmail.get(cookie);
      const sourceIdsAreText = Array.isArray(body.pets) && body.pets.length > 0
        && body.pets.every((pet) => typeof pet?.sourceId === "string");
      const isOwnedGateCustomer = String(body.customer?.id || "").endsWith("-CUS");
      const shouldPrepare = email === "preview-booker@pawspace.test"
        && isOwnedGateCustomer
        && body.serviceCode === "pet_sitting"
        && body.cityId === "blr"
        && body.zoneId === "blr-east"
        && sourceIdsAreText;

      if (shouldPrepare) {
        if (preparationBlocked) {
          metrics.preparationSuppressions++;
          return { status: 424, body: { error: "PREVIEW_CONTRACT_PREPARATION_FAILED" }, headers: {} };
        }

        metrics.quoteAttempts++;
        const quoteRes = await http("POST", "/api/sitting-commercial", {
          body: {
            packageCode: "sitting-visit-60",
            petCount: body.pets.length,
            scheduledStart: body.scheduledStart,
            scheduledEnd: body.scheduledEnd,
            paymentMode: "prepaid",
            cityId: "blr",
            zoneId: "blr-east",
          },
        });
        const quote = quoteRes.body?.data;
        if (quoteRes.status !== 201 || !quote?.quoteId || !Number.isFinite(Number(quote?.amountDueNow))) {
          metrics.quoteFailures++;
          statusCount(metrics.quoteFailureStatuses, quoteRes.status);
          return blockPreparation("quote", quoteRes);
        }

        metrics.captureAttempts++;
        const captureRes = await http("POST", "/api/sitting-payment-sandbox", {
          headers: {
            cookie,
            "x-payment-capture-key": `preview-gate-${String(body.idempotencyKey || body.scheduleGroupId).slice(0, 96)}`,
          },
          body: { quoteId: quote.quoteId, amount: Number(quote.amountDueNow) },
        });
        if (captureRes.status < 200 || captureRes.status >= 300) {
          metrics.captureFailures++;
          statusCount(metrics.captureFailureStatuses, captureRes.status);
          return blockPreparation("capture", captureRes);
        }

        const prepared = {
          quoteId: String(quote.quoteId),
          packageCode: String(quote.packageCode),
          packageName: String(quote.packageName),
          totalAmount: Number(quote.totalAmount),
          amountDueNow: Number(quote.amountDueNow),
          paymentMode: String(quote.paymentMode || "prepaid"),
        };
        for (const key of cacheKeys) preparedByIdentity.set(key, prepared);
        metrics.quotePreparations++;
        body = applyPrepared(body, prepared);
      }

      return http(method, requestPath, { ...options, body });
    }

    return http(method, requestPath, options);
  };

  return {
    http: currentHttp,
    d1: currentD1,
    stats: () => ({
      ...metrics,
      quoteFailureStatuses: { ...metrics.quoteFailureStatuses },
      captureFailureStatuses: { ...metrics.captureFailureStatuses },
      preparationDiagnostics: metrics.preparationDiagnostics ? { ...metrics.preparationDiagnostics } : null,
    }),
  };
}

export async function runGate(io) {
  if (io.env?.PRODUCT_CONTRACT !== CURRENT_PRODUCT_CONTRACT) return legacyRunGate(io);

  const adapted = adaptCurrentProductContracts({ http: io.http, d1: io.d1 });
  const baseLog = io.log || console.log;
  const report = await legacyRunGate({
    ...io,
    http: adapted.http,
    d1: adapted.d1,
    log: (line) => baseLog(String(line).replaceAll("bookings.view", "bookings.manage")),
  });

  report.checks = (report.checks || []).map((check) => ({
    ...check,
    name: String(check.name).replaceAll("bookings.view", "bookings.manage"),
  }));
  const contract = adapted.stats();
  const contractOk = contract.permissionRewrites > 0
    && contract.bookerPermissionPreserved > 0
    && contract.zoneRewrites > 0
    && contract.quotePreparations > 0
    && contract.quoteFailures === 0
    && contract.captureFailures === 0;
  const contractName = "current booking contracts were exercised without bypass";
  const contractDetail = [
    `viewerPermissions=${contract.permissionRewrites}`,
    `bookerOwnershipPreserved=${contract.bookerPermissionPreserved}`,
    `zones=${contract.zoneRewrites}`,
    `prepared=${contract.quotePreparations}`,
    `quoteAttempts=${contract.quoteAttempts}`,
    `quoteFailures=${contract.quoteFailures}`,
    `captureAttempts=${contract.captureAttempts}`,
    `captureFailures=${contract.captureFailures}`,
    `suppressed=${contract.preparationSuppressions}`,
    `firstFailure=${contract.firstPreparationFailure || "none"}`,
  ].join(" ");
  if (contractOk) report.checks.push({ name: contractName, ok: true, detail: contractDetail });
  else unavailable(report, contractName, contractDetail);
  report.counts = { ...(report.counts || {}), currentProductContract: contract };
  report.productContract = CURRENT_PRODUCT_CONTRACT;
  return report;
}

// CLI wiring. Product code comes from candidate/. Gate tooling comes from the current infrastructure
// checkout, exactly as deploy-release-preview.yml requires.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const WORKER = process.env.PREVIEW_WORKER || "";
  const EXPECTED_SHA = process.env.EXPECTED_SHA || "";
  const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
  const PREVIEW_D1 = process.env.PREVIEW_D1 || "";
  const PREVIEW_URL = process.env.PREVIEW_URL || "";
  const RUN_TAG = process.env.PREVIEW_RUN_TAG || "";
  const CANDIDATE_DIR = process.env.CANDIDATE_DIR || "";
  if (!WORKER || !EXPECTED_SHA || !ACCESS_CODE || !PREVIEW_D1 || !PREVIEW_URL || !RUN_TAG || !CANDIDATE_DIR) {
    console.error("release-preview gate: required environment is not configured (PREVIEW_WORKER, PREVIEW_URL, EXPECTED_SHA, PAWSPACE_UAT_ACCESS_CODE, PREVIEW_D1, PREVIEW_RUN_TAG, CANDIDATE_DIR).");
    process.exit(1);
  }
  try { assertRunTag(RUN_TAG); }
  catch (error) { console.error(`release-preview gate: ${error.message}`); process.exit(1); }

  const BASE = PREVIEW_URL;
  const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
  });

  const http = async (method, requestPath, { headers = {}, body } = {}) => {
    const res = await fetch(`${BASE}${requestPath}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    let parsed = null;
    try { parsed = JSON.parse(await res.text()); } catch { /* non-JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  const d1 = async (sql) => {
    let out;
    try {
      out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--config", path.join(CANDIDATE_DIR, "dist/server/wrangler.json"), "--remote", "--json", "--command", sql], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("D1 command failed");
    }
    const parsed = JSON.parse(out);
    return parsed?.[0]?.results ?? parsed?.result?.[0]?.results ?? [];
  };

  const ddl = async (table) => ddlFromCheckout(CANDIDATE_DIR, table);

  const deployedVars = async () => {
    const parsed = JSON.parse(wrangler(["versions", "list", "--name", WORKER, "--json"]));
    const versions = Array.isArray(parsed) ? parsed : (parsed?.versions ?? parsed?.result ?? []);
    versions.sort((a, b) => String(b.metadata?.created_on || "").localeCompare(String(a.metadata?.created_on || "")));
    const versionId = versions[0]?.id;
    if (!versionId) return null;
    const detail = JSON.parse(wrangler(["versions", "view", versionId, "--name", WORKER, "--json"]));
    return Object.fromEntries((detail.resources?.bindings || [])
      .filter((binding) => binding.type === "plain_text")
      .map((binding) => [binding.name, binding.text]));
  };

  const providerActivation = async () => deployedVars();
  const hostedSha = async () => (await deployedVars())?.PAWSPACE_RELEASE_SHA ?? null;

  const workerLog = async () => {
    const chunks = [];
    let tail = null;
    try {
      tail = spawn("npx", ["wrangler", "tail", "--name", WORKER, "--format", "json"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      tail.stdout.on("data", (chunk) => chunks.push(String(chunk)));
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await http("GET", "/api/canonical-bookings");
      await new Promise((resolve) => setTimeout(resolve, 8000));
    } finally { if (tail) tail.kill("SIGINT"); }
    const captured = chunks.join("");
    return captured.trim() ? captured : null;
  };

  let report;
  try {
    report = await runGate({
      http, d1, ddl, hostedSha, workerLog, providerActivation,
      env: { EXPECTED_SHA, ACCESS_CODE, RUN_TAG, PRODUCT_CONTRACT: CURRENT_PRODUCT_CONTRACT },
    });
  } catch (error) {
    report = {
      sha: EXPECTED_SHA,
      checks: [{ name: "hosted gate completed", ok: false, unavailable: true,
        detail: `NOT RUN: ${sanitizeEvidenceDetail(error?.message, [ACCESS_CODE, PREVIEW_D1])}` }],
      counts: {}, failures: 1, gate: "unavailable",
    };
  }
  writeFileSync("release-preview-report.json", JSON.stringify(report, null, 2));
  const passed = report.failures === 0 && report.authHarness !== "unavailable" && report.schema !== "unavailable";
  console.log(`\
release preview gate: ${passed ? "PASS" : "FAIL"}`);
  if (report.unavailable?.length) for (const name of report.unavailable) console.log(`  could not run (counted as a failure): ${name}`);
  process.exit(passed ? 0 : 1);
}
