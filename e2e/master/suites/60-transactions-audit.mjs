// Transactions audit — runs LAST in a staging run and is read-only apart from staff page views.
// It proves the money trail of every booking this run created (bookings.jsonl) is complete and consistent in
// staging D1, and that nothing staging-wide is broken in the last 7 days:
//  per booking  booking_payments · split / booking-fee schedules · Razorpay capture events (+ order intent, capture
//               journal, post-commit effects) · webhooks of the booking's orders · payment reconciliation ·
//               collection ledger (+ balanced journal lines) · refunds reversed in the books · booking timeline ·
//               invoices — one record() row per invariant, one finding per broken invariant (P0 money wrong or
//               lost, P1 state wrong), offending booking ids in the detail;
//  global       captured payments without capture evidence · collections vs captures (duplicate / missing) · open
//               over-collection / refund-overage exceptions · orphan gateway refunds · refunds not reversed ·
//               capture effects stuck · unbalanced journals · invoices for unpaid bookings / reused numbers ·
//               webhooks stuck since the live deploy (lib recordWebhookCheck);
//  staff UI     the Finance persona is refused by MFA (expected); as the founder every /team/finance page loads
//               without 5xx or page errors, the Boarding / Sitting / Taxi workspaces show this run's bookings with
//               the payment state D1 holds, and the Booking Command Center "Payments" tab agrees for one booking
//               of each service.
// The SQL and the rules live in _60-transactions-audit-helpers.mjs (proven locally against a SQLite built from
// drizzle/*.sql + the runtime ensure*() DDL, with rows written by the real capture and refund code).
import {
  BASE, launch, newFlow, settle, api, staffSession, dismissCookies, d1, readBookings, record, finding, writeJson,
  hasAccessCode, recordWebhookCheck, deployedSha,
} from "../lib.mjs";
import * as A from "./_60-transactions-audit-helpers.mjs";

const SUITE = "60-transactions-audit";
const FOUNDER = "founder@pawspace.in", FINANCE = "anjali.finance33@tkpetcare.in";
const EVIDENCE = ["transactions-audit.json"];
const out = { suite: SUITE, startedAt: new Date().toISOString(), base: BASE };
const clip = (value, n = 1800) => { const s = typeof value === "string" ? value : JSON.stringify(value); return s.length > n ? `${s.slice(0, n)}…` : s; };
const serviceOf = (value) => ({ sitting: "pet_sitting", pet_sitting: "pet_sitting", taxi: "pet_taxi", pet_taxi: "pet_taxi", boarding: "boarding" })[String(value || "").toLowerCase()] || String(value || "");
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const HARNESS_NO_D1 = "harness: staging D1 read credentials are not configured in this runner — not checked";
const HARNESS_NO_CODE = "harness: no UAT access code in this runner";

const saved = A.mergeSavedBookings(readBookings());
out.saved = saved.map(row => ({ bookingId: row.bookingId, suites: row.suites, service: row.service, total: row.total, dueNow: row.dueNow, paid: row.paid, balancePaid: row.balancePaid, paymentMode: row.paymentMode, nearTerm: row.nearTerm }));
const mix = (rows) => { const count = {}; for (const row of rows) { const key = serviceOf(row.service) || "unknown"; count[key] = (count[key] || 0) + 1; } return Object.entries(count).map(([key, n]) => `${n} ${key}`).join(", ") || "none"; };
const scope = `${saved.length} booking(s) of this run: ${mix(saved)}; ${saved.filter(row => row.paid).length} paid, ${saved.filter(row => row.balancePaid).length} balance paid`;
console.log(`[${SUITE}] ${scope}`);

// ---------------------------------------------------------------- D1: can we read staging at all?
const probe = await d1("SELECT COUNT(*) AS n FROM booking_payments WHERE updated_at > ?", [Date.now() - 3_600_000]);
const d1State = probe?.skipped ? "skipped" : Array.isArray(probe) ? "ok" : "error";
out.d1 = { state: d1State, probe: Array.isArray(probe) ? probe[0] : probe };
const d1Blocked = d1State === "skipped" ? HARNESS_NO_D1 : d1State === "error" ? `harness: staging D1 read failed: ${clip(probe, 300)}` : null;
const query = (sql, params) => d1(sql, params);

// ---------------------------------------------------------------- per-booking money trail
let facts = [];
const recordedInvariants = new Set();
try {
  if (d1Blocked || !saved.length) {
    const why = d1Blocked || "harness: no bookings were saved to bookings.jsonl by the earlier suites of this run — nothing to audit";
    for (const inv of A.INVARIANTS) record({ suite: SUITE, journey: inv.journey, combo: scope, result: "BLOCKED", detail: why, evidence: [] });
  } else {
    const ids = saved.map(row => row.bookingId);
    const data = await A.collectAuditData(query, ids);
    facts = A.bookingFactsFor(saved, data, Date.now());
    const created = facts.map(fact => Number(fact.b?.created_at)).filter(Number.isFinite);
    const since = (created.length ? Math.min(...created) : Date.now() - 24 * 3_600_000) - 15 * 60_000;
    // Webhooks still in flight get the same two minutes lib unfinishedWebhooks gives them.
    for (const started = Date.now(); ;) {
      await A.collectWebhooks(query, data, facts, since);
      const inFlight = (data.webhookRows || []).filter(row => ["RECEIVED", "PROCESSING"].includes(String(row.processing_status)) && Date.now() - Number(row.received_at) < A.SETTLE_MS);
      if (!inFlight.length || Date.now() - started > A.SETTLE_MS) break;
      console.log(`[${SUITE}] ${inFlight.length} webhook(s) in flight, re-reading in 10 s`);
      await wait(10_000);
    }
    const now = Date.now();
    facts = A.bookingFactsFor(saved, data, now);
    A.attachWebhooks(facts, data.webhookRows);
    const results = A.evaluateBookings(facts, new Set(data.failed));
    out.reads = { failed: data.failed, errors: data.errors, missingTables: data.missingTables, webhookRows: (data.webhookRows || []).length };
    out.bookings = facts.map(A.factSummary);
    out.invariants = [];
    const audited = facts.filter(fact => fact.b);
    const combo = `${audited.length}/${saved.length} booking(s) found in D1: ${mix(audited.map(fact => ({ service: fact.service })))}; ${audited.filter(fact => fact.captures.length).length} with verified captures`;
    for (const inv of results) {
      const problems = [...new Map(inv.problems.map(item => [`${item.bookingId}|${item.msg}`, item])).values()];
      const offenders = [...new Set(problems.map(item => item.bookingId))];
      const notes = inv.notes.map(item => `${item.bookingId}: ${item.msg}`);
      const result = inv.blocked ? "BLOCKED" : problems.length ? "FAIL" : "PASS";
      const detail = inv.blocked ? `harness: ${inv.blocked}: ${clip(data.errors, 400)}`
        : problems.length ? `${problems.length} problem(s) on ${offenders.length} booking(s): ${problems.map(item => `${item.bookingId} [${item.sev}] ${item.msg}`).join(" · ")}${notes.length ? ` — notes: ${notes.join(" · ")}` : ""} — observed: ${A.observations(inv.key, facts).join(" · ") || "—"}`
        : `all ${inv.checked} booking(s) consistent; observed: ${A.observations(inv.key, facts).join(" · ") || "nothing of this kind on this run's bookings"}${notes.length ? ` — notes: ${notes.join(" · ")}` : ""}`;
      out.invariants.push({ key: inv.key, result, problems, notes: inv.notes });
      record({ suite: SUITE, journey: inv.journey, combo, result, detail: clip(detail), evidence: EVIDENCE });
      recordedInvariants.add(inv.key);
      if (result === "FAIL") finding({
        suite: SUITE, severity: A.worstSeverity(problems), area: "Payments", persona: "Finance", flow: `Money trail (staging D1 read-back): ${inv.key}`,
        title: `${A.onlyFlaggedOverCollection(problems) ? "Over-collection flagged correctly" : inv.title} (${offenders.length} booking${offenders.length === 1 ? "" : "s"}: ${offenders.slice(0, 4).join(", ")}${offenders.length > 4 ? ", …" : ""})`,
        steps: `Read staging D1 read-only for the ${saved.length} booking(s) this run saved (booking_payments, schedules, payment_gateway_events, payment_intents, gateway_webhook_events, payment_reconciliation_records, collection_ledger_postings + finance_journal_entries, journal_transactions, booking_refund_cases + service refund ledgers, booking_lifecycle_events, booking_invoices / finance_invoices)`,
        expected: inv.expected, actual: clip(problems.map(item => `${item.bookingId} [${item.sev}] ${item.msg}`).join(" · "), 1200), evidence: EVIDENCE,
      });
    }
  }
} catch (error) {
  out.bookingAuditError = String(error?.stack || error).slice(0, 800);
  for (const inv of A.INVARIANTS.filter(item => !recordedInvariants.has(item.key))) record({ suite: SUITE, journey: inv.journey, combo: scope, result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] });
}

// ---------------------------------------------------------------- staging-wide invariants (7 days, read-only)
const runIds = new Set(saved.map(row => row.bookingId));
const GLOBAL_CHECKS = [
  { journey: "Global: captured payments carry gateway capture evidence (7 days)", parts: [["capturedWithoutEvidence", "P0"]],
    title: "Razorpay-gateway payments marked captured without a processed capture event or reconciliation record", expected: "every captured/refunded booking payment on a Razorpay gateway has a processed payment.captured event and a reconciliation record with captured_amount > 0",
    fmt: row => `${row.booking_id} ${row.status} (${row.gateway}) capture events ${row.capture_events}, reconciliation captured ${row.captured_amount ?? "none"}` },
  { journey: "Global: one collection posting per gateway capture — none duplicated, none missing (7 days)", parts: [["duplicateCollections", "P0"], ["capturesWithoutCollection", "P1"]],
    title: "Collection ledger postings do not match Razorpay captures", expected: "online_payment_captured postings per payment = distinct captures and never more than reconciliation captured_amount; every capture older than 10 minutes posted",
    fmt: row => row.postings !== undefined ? `${row.booking_id || row.payment_id}: ${row.postings} posting(s) ₹${row.posted} [${row.settlements}] for ${row.captures} capture(s), captured ₹${row.captured_amount ?? "—"}` : `${row.booking_id || row.payment_id}: capture ${row.capture_ref} ₹${Number(row.amount_subunits) / 100} has no collection posting` },
  { journey: "Global: open over-collection / refund-overage exceptions (7 days)", parts: [["moneyExceptions", "P1"]], runSeverity: "P0",
    title: "Open over-collection / refund-overage exceptions on staging", expected: "none open: every over-collection or refund overage resolved by Finance",
    fmt: row => `${row.booking_id} ${row.exception_type} (${row.severity}) captured ₹${row.captured_amount ?? row.captured ?? "—"} excess ₹${row.excess_amount ?? "—"}${row.refunded !== null && row.refunded !== undefined ? ` refunded ₹${row.refunded}` : ""}` },
  { journey: "Global: orphan gateway refunds (7 days)", parts: [["orphanRefunds", "P1"]],
    title: "Gateway refunds with no matching internal refund case", expected: "no open orphan_gateway_refund / refund_amount_mismatch exception, no refund.* gateway event left unprocessed",
    fmt: row => `${row.source} ${row.kind} ${row.status} booking ${row.booking_id || "—"} event ${row.event_id || "—"}` },
  { journey: "Global: recorded refunds reversed in the collection ledger (7 days)", parts: [["refundsWithoutReversal", "P1"], ["serviceRefundsNotInBooks", "P1"]],
    title: "Recorded refunds that never reached the canonical books", expected: "every processed/completed refund case has COLL-refund_completed-<reference>; every service-ledger refund marked sandbox_recorded has its processed canonical refund case",
    fmt: row => row.ledger ? `${row.booking_id} ${row.ledger} ${row.reference} ₹${row.amount} recorded, no processed canonical refund case` : `${row.booking_id} refund ${row.gateway_reference || "(no reference)"} ₹${row.amount} ${row.status}, no reversal posting` },
  { journey: "Global: capture post-commit effects completed (7 days)", parts: [["captureEffectsPending", "P1"]],
    title: "Razorpay capture post-commit effects (ledger, timeline, confirmation) not completed", expected: "every RAZORPAY_CAPTURE_POST_COMMIT outbox row older than 10 minutes SUCCEEDED",
    fmt: row => `${row.booking_id || row.aggregate_id} ${row.status} after ${row.attempts} attempt(s): ${String(row.last_error || "").slice(0, 100)}` },
  { journey: "Global: collection and capture journals balanced (7 days)", parts: [["unbalancedCollectionJournals", "P0"], ["unbalancedCaptureJournals", "P0"], ["collectionMarkersWithoutJournal", "P1"]],
    title: "Unbalanced or missing collection / capture journals", expected: "every collection journal group and razorpay_capture journal transaction has ≥2 lines with debits = credits; every collection marker has its journal",
    fmt: row => row.source_event_id !== undefined ? `capture journal ${row.source_event_id} ${row.status} ${row.lines} line(s) debit ${row.debit_paise} / credit ${row.credit_paise} paise` : row.group_key ? `${row.group_key} ₹${row.amount} has no journal lines` : `${row.source_type} ${row.source_id}: ${row.lines} line(s) debit ₹${row.debit} / credit ₹${row.credit}` },
  { journey: "Global: invoices only for paid bookings, numbers unique (7 days)", parts: [["invoicesForUnpaid", "P1"], ["duplicateInvoiceNumbers", "P1"]],
    title: "Invoice issued for an unpaid booking or invoice number reused", expected: "no booking invoice while the payment is uncollected; no invoice number used twice across booking and finance invoices",
    fmt: row => row.n !== undefined ? `${row.invoice_number} used ${row.n} times` : `${row.invoice_number} for ${row.booking_id} (payment ${row.payment_status || "missing"})` },
];
out.global = [];
// Rows written before the live deploy came from an earlier build: listed, but told apart from regressions.
const deploy = d1Blocked ? null : await deployedSha().catch(error => ({ error: String(error) }));
const liveSince = Date.parse(deploy?.createdOn || "") || null;
out.deploy = { liveSince: liveSince && new Date(liveSince).toISOString(), sha: deploy?.sha || null, error: deploy?.error || deploy?.skipped || null };
const rowTime = (row) => Number(row.updated_at || row.created_at || row.first_seen || row.at || 0) || null;
const when = (row) => { const at = rowTime(row); return at ? ` @${new Date(at).toISOString().slice(0, 16)}Z${liveSince ? (at > liveSince + 60_000 ? " (after deploy)" : " (before deploy)") : ""}` : ""; };
for (const check of GLOBAL_CHECKS) {
  try {
    if (d1Blocked) { record({ suite: SUITE, journey: check.journey, combo: "staging D1, last 7 days", result: "BLOCKED", detail: d1Blocked, evidence: [] }); continue; }
    const now = Date.now(), rows = [], errors = [], missing = [];
    let severity = "P1";
    for (const [name, sev] of check.parts) {
      const def = A.GLOBAL_SQL[name];
      for (const item of Array.isArray(def) ? def : [def]) {
        let result = await d1(item.sql, item.params(...A.globalBounds(item, now)));
        const message = Array.isArray(result) ? "" : String(result?.detail || result?.error || "");
        if (!Array.isArray(result) && /no such table/i.test(message) && name === "duplicateInvoiceNumbers") result = await d1(A.GLOBAL_SQL.duplicateBookingInvoiceNumbers.sql, A.GLOBAL_SQL.duplicateBookingInvoiceNumbers.params(...A.globalBounds(A.GLOBAL_SQL.duplicateBookingInvoiceNumbers, now)));
        if (Array.isArray(result)) rows.push(...result.map(row => ({ ...row, __part: name, __sev: sev })));
        else if (/no such table/i.test(String(result?.detail || result?.error || ""))) missing.push(item.table || name);
        else errors.push(`${name}: ${clip(result, 200)}`);
      }
    }
    const ours = rows.filter(row => runIds.has(String(row.booking_id || "")));
    const afterDeploy = liveSince ? rows.filter(row => !rowTime(row) || rowTime(row) > liveSince + 60_000) : rows;
    if (afterDeploy.some(row => row.__sev === "P0")) severity = "P0";
    if (afterDeploy.some(row => runIds.has(String(row.booking_id || ""))) && check.runSeverity) severity = check.runSeverity;
    const list = rows.map(row => `${runIds.has(String(row.booking_id || "")) ? "[this run] " : ""}${check.fmt(row)}${when(row)}`);
    // Decision (main session): rows written before the live deploy are information only (PARTIAL, no finding).
    const result = errors.length && !rows.length ? "BLOCKED" : afterDeploy.length ? "FAIL" : rows.length ? "PARTIAL" : "PASS";
    const since = liveSince ? `; live deploy ${new Date(liveSince).toISOString().slice(0, 16)}Z (${String(deploy?.sha || "").slice(0, 8)}): ${afterDeploy.length} after, ${rows.length - afterDeploy.length} before` : "";
    const detail = result === "BLOCKED" ? `harness: D1 read failed: ${errors.join(" · ")}` : result === "PARTIAL" ? `before deploy: ${rows.length} row(s) left by the earlier build${since}: ${list.join(" · ")}` : rows.length ? `${rows.length} offending row(s)${ours.length ? ` (${ours.length} from this run)` : ""}${since}: ${list.join(" · ")}` : `none${missing.length ? ` (tables not created yet: ${missing.join(", ")})` : ""}${errors.length ? `; partial read errors: ${errors.join(" · ")}` : ""}`;
    out.global.push({ journey: check.journey, result, rows, errors, missing, afterDeploy: afterDeploy.length });
    record({ suite: SUITE, journey: check.journey, combo: "staging D1, last 7 days", result, detail: clip(detail), evidence: EVIDENCE });
    const oursAfter = afterDeploy.filter(row => runIds.has(String(row.booking_id || ""))).length;
    const afterList = afterDeploy.map(row => `${runIds.has(String(row.booking_id || "")) ? "[this run] " : ""}${check.fmt(row)}${when(row)}`);
    if (result === "FAIL") finding({ suite: SUITE, severity, area: "Payments", persona: "Finance", flow: "Staging-wide money invariants (D1 read-back)", title: `${check.title}: ${afterDeploy.length} row(s) since the live deploy${oursAfter ? `, ${oursAfter} from this run` : ""}`, steps: `Read-only D1 query over the last 7 days (${check.parts.map(([name]) => name).join(", ")})`, expected: check.expected, actual: clip(afterList.join(" · "), 1200), evidence: EVIDENCE });
  } catch (error) { record({ suite: SUITE, journey: check.journey, combo: "staging D1, last 7 days", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] }); }
}
// Webhooks stuck since the live deploy (records its own row and P1 finding; BLOCKED without D1).
try { out.webhooksSinceDeploy = await recordWebhookCheck(SUITE); } catch (error) { record({ suite: SUITE, journey: "Razorpay webhooks since the live deploy (PAY-01)", combo: "staging D1", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] }); }

// ---------------------------------------------------------------- staff UI (runner only)
out.ui = [];
const bookingsFor = (service) => {
  const list = facts.length ? facts.filter(fact => fact.b && fact.service === service).map(fact => ({ id: fact.id, fact })) : saved.filter(row => serviceOf(row.service) === service).map(row => ({ id: row.bookingId, fact: null }));
  return list.sort((a, b) => Number(Boolean(b.fact?.captures?.length ?? saved.find(row => row.bookingId === b.id)?.paid)) - Number(Boolean(a.fact?.captures?.length ?? saved.find(row => row.bookingId === a.id)?.paid)));
};
const newErrors = (flow, before) => ({
  api5xx: flow.log.apiFailures.slice(before.api).filter(item => item.status >= 500),
  api4xx: flow.log.apiFailures.slice(before.api).filter(item => item.status >= 400 && item.status < 500),
  pageErrors: flow.log.pageErrors.slice(before.page),
});
async function openPage(flow, path, heading, { settleMs = 3500 } = {}) {
  const before = { api: flow.log.apiFailures.length, page: flow.log.pageErrors.length };
  const response = await flow.page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(error => ({ error }));
  await dismissCookies(flow.page); await settle(flow.page, settleMs);
  const headingSeen = heading ? await flow.page.getByRole("heading", { name: heading }).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false) : true;
  const text = (await flow.page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
  const shot = await flow.shot(path.replace(/\?.*$/, "").replace(/[^a-z0-9]+/gi, "-") + (path.includes("bookingId=") ? `-${path.split("bookingId=")[1].slice(-10)}` : ""));
  return { path, status: typeof response?.status === "function" ? response.status() : null, navError: response?.error ? String(response.error.message || response.error).slice(0, 200) : null, headingSeen, text, shot, ...newErrors(flow, before) };
}
function uiDefects(view, area) {
  for (const failure of view.api5xx) finding({ suite: SUITE, severity: /finance|payment|booking-command-center|reconciliation/i.test(failure.url) ? "P1" : "P2", area, persona: "Founder", flow: `Open ${view.path}`, title: `${failure.method} ${failure.url.split("?")[0]} → HTTP ${failure.status} on ${view.path.split("?")[0]}`, steps: `Sign in as ${FOUNDER}, open ${view.path}`, expected: "the page's API calls succeed", actual: clip(failure.body, 400), evidence: [view.shot] });
  for (const error of view.pageErrors) finding({ suite: SUITE, severity: "P2", area, persona: "Founder", flow: `Open ${view.path}`, title: `Uncaught page error on ${view.path.split("?")[0]}`, steps: `Sign in as ${FOUNDER}, open ${view.path}`, expected: "no uncaught page error", actual: clip(error.text, 300), evidence: [view.shot] });
}
const loadOk = (view) => view.status !== null && view.status < 400 && !view.navError && view.headingSeen && !view.api5xx.length && !view.pageErrors.length;
const errorText = (view) => (view.text.match(/[^.]{0,60}(Application error|Something went wrong|Unable to load|Unable to|not found|required)[^.]{0,80}/i) || [""])[0].trim();
const loadDetail = (view) => `HTTP ${view.status}${view.navError ? ` nav error ${view.navError}` : ""}; heading ${view.headingSeen ? "shown" : "missing"}; 5xx ${view.api5xx.map(item => `${item.method} ${item.url.split("?")[0]} ${item.status}`).join(", ") || "none"}; 4xx ${view.api4xx.map(item => `${item.url.split("?")[0]} ${item.status}`).join(", ") || "none"}; page errors ${view.pageErrors.length}${errorText(view) ? `; on screen: "${errorText(view).slice(0, 140)}"` : ""}`;

const browser = hasAccessCode() ? await launch() : null;
try {
  if (!hasAccessCode()) {
    for (const journey of ["Finance persona is refused without MFA (expected)", "Finance hub /team/finance (founder)", "Boarding finance workspace shows this run's stays (founder)", "Sitting finance workspace shows this run's bookings (founder)", "Taxi finance workspace shows this run's rides (founder)", "Other finance pages load (founder)", "Booking Command Center — Payments tab (founder)"])
      record({ suite: SUITE, journey, combo: "staff UI on staging", result: "BLOCKED", detail: HARNESS_NO_CODE, evidence: [] });
  } else {
    // 1) The Finance role is MFA-protected on staging (lib/server-auth requirePrivilegedMfa): refused, by design.
    const fin = await newFlow(browser, "60-finance-persona");
    try {
      await staffSession(fin.context, FINANCE);
      const r = await api(fin.context, "GET", "/api/payment-reconciliation?status=open");
      const refused = r.status === 403 && /MFA enrollment required/i.test(JSON.stringify(r.body));
      const result = refused || r.status === 200 ? "PASS" : "FAIL";
      out.ui.push({ view: "finance persona", status: r.status, refused });
      record({ suite: SUITE, journey: "Finance persona is refused without MFA (expected)", combo: `${FINANCE} → GET /api/payment-reconciliation`, result, detail: refused ? "HTTP 403 \"MFA enrollment required\" — finance is a privileged role (lib/admin-mfa PRIVILEGED); the Finance pages below are audited as the founder" : `HTTP ${r.status} ${clip(r.body, 300)}`, evidence: [] });
      if (r.status >= 500) finding({ suite: SUITE, severity: "P1", area: "Finance", persona: "Finance", flow: "Payment exceptions API", title: `GET /api/payment-reconciliation → HTTP ${r.status} for the Finance role`, steps: `Sign in as ${FINANCE}, GET /api/payment-reconciliation?status=open`, expected: "403 MFA enrollment required (or 200 with an MFA session)", actual: clip(r.body, 400), evidence: [] });
    } catch (error) {
      const message = String(error?.message || error);
      const refusedAtSignIn = /MFA enrollment required/i.test(message);
      record({ suite: SUITE, journey: "Finance persona is refused without MFA (expected)", combo: FINANCE, result: refusedAtSignIn ? "PASS" : "BLOCKED", detail: refusedAtSignIn ? `sign-in refused: ${message.slice(0, 200)} (expected for the MFA-protected finance role)` : `harness: ${message.slice(0, 300)}`, evidence: [] });
    }
    await fin.close();

    // 2) Every Finance page as the founder.
    const staff = await newFlow(browser, "60-finance-founder");
    try {
      await staffSession(staff.context, FOUNDER);
      // Hub + the payment exceptions list it summarises (the only reconciliation/exceptions surface in app/team/finance).
      try {
        const view = await openPage(staff, "/team/finance", /Service finance & reconciliation/i);
        const exceptions = await api(staff.context, "GET", "/api/payment-reconciliation?status=open");
        const listed = Array.isArray(exceptions.body?.data?.exceptions) ? exceptions.body.data.exceptions : null;
        const d1Money = (out.global.find(row => /over-collection/.test(row.journey))?.rows || []);
        const missingFromApi = listed ? d1Money.filter(row => !listed.some(item => item.id === row.id)).map(row => row.id) : [];
        const ok = loadOk(view) && !/Finance ledger unavailable/i.test(view.text) && exceptions.status === 200 && Boolean(listed) && !missingFromApi.length;
        out.ui.push({ view: view.path, ok, openExceptions: listed?.length ?? null, missingFromApi });
        record({ suite: SUITE, journey: "Finance hub /team/finance (founder)", combo: "hub + GET /api/payment-reconciliation?status=open", result: ok ? "PASS" : "FAIL", detail: `${loadDetail(view)}; exceptions API HTTP ${exceptions.status}, ${listed ? `${listed.length} open (${[...new Set(listed.map(item => item.type))].join(", ") || "none"})` : clip(exceptions.body, 200)}${missingFromApi.length ? `; D1 open money exceptions missing from the API: ${missingFromApi.join(", ")}` : ""}`, evidence: [view.shot] });
        uiDefects(view, "Finance");
        if (missingFromApi.length) finding({ suite: SUITE, severity: "P2", area: "Finance", persona: "Founder", flow: "Payment exceptions", title: "Open over-collection / refund-overage exceptions in D1 are missing from the Finance exceptions API", steps: "GET /api/payment-reconciliation?status=open as the founder; compare with D1", expected: "every open exception listed", actual: missingFromApi.join(", "), evidence: [view.shot] });
      } catch (error) { record({ suite: SUITE, journey: "Finance hub /team/finance (founder)", combo: "hub", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] }); }

      // Service workspaces with this run's bookings (paid ones first, at most 4 per service).
      const workspaces = [
        { service: "boarding", path: "/team/finance/boarding", heading: /Boarding finance & reconciliation/i, journey: "Boarding finance workspace shows this run's stays (founder)", apiPath: id => `/api/boarding-finance?bookingId=${encodeURIComponent(id)}`,
          expect: (fact, body) => { const status = fact?.paymentStatus ?? body?.data?.stay?.payment_status; return [[`Payment ${A.label(status)}`, new RegExp(`Payment\\s+${A.label(status).replace(/ /g, "\\s+")}`, "i")], [`Booking total ${A.inr0(fact?.b?.booking_total ?? body?.data?.stay?.total_amount)}`, null]]; },
          apiCheck: (fact, body) => fact && body?.data?.stay && String(body.data.stay.payment_status) !== fact.paymentStatus ? `API payment_status ${body.data.stay.payment_status} ≠ D1 ${fact.paymentStatus}` : null },
        { service: "pet_sitting", path: "/team/finance/sitting", heading: /Sitting finance & reconciliation/i, journey: "Sitting finance workspace shows this run's bookings (founder)", apiPath: id => `/api/sitting-finance?bookingId=${encodeURIComponent(id)}`,
          expect: (fact, body) => { const status = fact?.paymentStatus ?? body?.data?.booking?.payment_status; const captured = body?.data?.booking?.captured_amount ?? fact?.recon?.captured_amount ?? 0; return [[`Payment ${A.label(status)}`, new RegExp(`Payment\\s+${A.label(status).replace(/ /g, "\\s+")}`, "i")], [`Captured ${A.inr0(captured)}`, null]]; },
          apiCheck: (fact, body) => { if (!fact || !body?.data?.booking) return null; const collected = A.COLLECTED_STATUSES.includes(fact.paymentStatus) ? Number(fact.recon?.captured_amount ?? fact.capturedSum) : 0; return A.same(body.data.booking.captured_amount, collected) ? null : `Finance shows captured ₹${body.data.booking.captured_amount}, D1 reconciliation ₹${collected}`; } },
        { service: "pet_taxi", path: "/team/finance/taxi", heading: /Taxi payment & reconciliation/i, journey: "Taxi finance workspace shows this run's rides (founder)", apiPath: id => `/api/taxi-finance?bookingId=${encodeURIComponent(id)}`,
          expect: (fact, body) => { const status = fact?.b?.booking_status ?? body?.data?.booking?.status; return [[`Booking ${A.label(status)}`, new RegExp(`Booking\\s+${A.label(status).replace(/ /g, "\\s+")}`, "i")], [`Booking value ${A.inr0(fact?.b?.booking_total ?? body?.data?.booking?.total_amount)}`, null]]; },
          apiCheck: (fact, body) => fact && body?.data?.booking && String(body.data.booking.payment_status) !== fact.paymentStatus ? `API payment_status ${body.data.booking.payment_status} ≠ D1 ${fact.paymentStatus}` : null },
      ];
      for (const ws of workspaces) {
        try {
          const targets = bookingsFor(ws.service).slice(0, 4);
          const views = [], problems = [], evidence = [];
          if (!targets.length) {
            const view = await openPage(staff, ws.path, ws.heading);
            evidence.push(view.shot); uiDefects(view, "Finance");
            record({ suite: SUITE, journey: ws.journey, combo: "no booking of this service in this run — page load only", result: loadOk(view) ? "PASS" : "FAIL", detail: loadDetail(view), evidence });
            out.ui.push({ view: ws.path, ok: loadOk(view) });
            continue;
          }
          for (const target of targets) {
            const body = (await api(staff.context, "GET", ws.apiPath(target.id))).body;
            const view = await openPage(staff, `${ws.path}?bookingId=${encodeURIComponent(target.id)}`, ws.heading, { settleMs: 4500 });
            evidence.push(view.shot); uiDefects(view, "Finance"); views.push(view);
            // A 5xx / page error already raised its own finding (uiDefects); a page that simply did not render gets one here.
            if (!loadOk(view)) { problems.push({ id: target.id, sev: "P1", msg: `workspace did not load: ${loadDetail(view)}`, reported: Boolean(view.api5xx.length || view.pageErrors.length) }); continue; }
            if (ws.service === "boarding" && !view.text.includes(target.id)) problems.push({ id: target.id, sev: "P1", msg: "the workspace did not open this booking" });
            for (const [expectedText, pattern] of ws.expect(target.fact, body)) {
              const shown = pattern ? pattern.test(view.text) : view.text.toLowerCase().includes(expectedText.toLowerCase().replace(/\s+/g, " "));
              if (!shown) problems.push({ id: target.id, sev: "P2", msg: `expected "${expectedText}" on screen` });
            }
            const mismatch = ws.apiCheck(target.fact, body);
            if (mismatch) problems.push({ id: target.id, sev: "P2", msg: mismatch });
          }
          // Boarding: this run's stays waiting on Finance (cancellation or refund to record) are in the queue.
          if (ws.service === "boarding" && facts.length) {
            const queue = await api(staff.context, "GET", "/api/boarding-finance?view=queue");
            const queued = new Set((queue.body?.data?.items || []).map(item => String(item.booking_id)));
            const waiting = facts.filter(fact => fact.service === "boarding" && (fact.serviceRefunds.some(row => row.ledger === "boarding" && row.status === "sandbox_pending") || fact.boardingCancellations.some(row => row.status === "policy_review_required")));
            for (const fact of waiting) if (!queued.has(fact.id)) problems.push({ id: fact.id, sev: "P1", msg: `cancellation or refund waiting on Finance but not in the Boarding finance queue (HTTP ${queue.status})` });
            if (waiting.length) out.ui.push({ view: "boarding queue", waiting: waiting.map(fact => fact.id), queued: waiting.filter(fact => queued.has(fact.id)).map(fact => fact.id) });
          }
          const result = problems.length ? "FAIL" : "PASS";
          out.ui.push({ view: ws.path, targets: targets.map(target => target.id), problems });
          record({ suite: SUITE, journey: ws.journey, combo: `${targets.length} booking(s): ${targets.map(target => target.id).join(", ")}`, result, detail: clip(problems.length ? problems.map(item => `${item.id} [${item.sev}] ${item.msg}`).join(" · ") : `each workspace opened the booking and showed the D1 payment state (${views.map(view => loadDetail(view)).slice(0, 1).join("")})`), evidence });
          const defects = problems.filter(item => !item.reported);
          if (defects.length) finding({ suite: SUITE, severity: defects.some(item => item.sev === "P1") ? "P1" : "P2", area: "Finance", persona: "Founder", flow: ws.path, title: `${ws.path} does not show this run's ${ws.service} bookings as D1 records them`, steps: `Sign in as ${FOUNDER}, open ${ws.path}?bookingId=<id> for ${targets.map(target => target.id).join(", ")}`, expected: "the booking opens with its D1 payment status and amounts", actual: clip(defects.map(item => `${item.id}: ${item.msg}`).join(" · "), 800), evidence });
        } catch (error) { record({ suite: SUITE, journey: ws.journey, combo: ws.path, result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] }); }
      }

      // Every other Finance page in app/team/finance loads cleanly.
      try {
        const others = [["/team/finance/cash-flow", /Cash flow & earned revenue/i], ["/team/finance/partners", /Provider compensation/i], ["/team/finance/statutory", /GST, Accounting & Statutory Control/i], ["/team/finance/unit-economics", /Unit economics/i], ["/team/finance/training", /Training finance/i], ["/team/finance/walking", /Walking payment & reconciliation/i], ["/team/finance/food", /Food payment & reconciliation/i], ["/team/finance/relocation", /Relocation Finance/i], ["/team/finance/funeral-memorial", /Payment and refund evidence/i]];
        const views = [];
        for (const [path, heading] of others) { const view = await openPage(staff, path, heading); views.push(view); uiDefects(view, "Finance"); }
        const bad = views.filter(view => !loadOk(view));
        out.ui.push({ view: "other finance pages", bad: bad.map(view => ({ path: view.path, detail: loadDetail(view) })) });
        record({ suite: SUITE, journey: "Other finance pages load (founder)", combo: views.map(view => view.path.replace("/team/finance/", "")).join(", "), result: bad.length ? "FAIL" : "PASS", detail: clip(bad.length ? bad.map(view => `${view.path}: ${loadDetail(view)}`).join(" · ") : `all ${views.length} pages loaded with their heading, no 5xx, no page errors`), evidence: views.map(view => view.shot) });
        const headingOnly = bad.filter(view => !view.api5xx.length && !view.pageErrors.length);
        if (headingOnly.length) finding({ suite: SUITE, severity: "P2", area: "Finance", persona: "Founder", flow: "Finance pages", title: `${headingOnly.length} finance page(s) did not render for the founder`, steps: `Sign in as ${FOUNDER} and open ${headingOnly.map(view => view.path).join(", ")}`, expected: "each page renders its heading", actual: clip(headingOnly.map(view => `${view.path}: ${loadDetail(view)} :: ${view.text.slice(0, 120)}`).join(" · "), 800), evidence: headingOnly.map(view => view.shot) });
      } catch (error) { record({ suite: SUITE, journey: "Other finance pages load (founder)", combo: "app/team/finance/**", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] }); }

      // 3) Booking Command Center — Payments tab for one booking of each service (paid first).
      for (const service of ["boarding", "pet_sitting", "pet_taxi"]) {
        const journey = "Booking Command Center — Payments tab (founder)";
        const target = bookingsFor(service)[0];
        if (!target) { record({ suite: SUITE, journey, combo: service, result: "SKIPPED", detail: `no ${service} booking in this run`, evidence: [] }); continue; }
        try {
          const snapshot = await api(staff.context, "GET", `/api/booking-command-center?q=${encodeURIComponent(target.id)}`);
          const row = (snapshot.body?.bookings || []).find(item => item.id === target.id);
          const view = await openPage(staff, `/booking-command-center?bookingId=${encodeURIComponent(target.id)}`, /Booking Command Center/i, { settleMs: 4000 });
          await staff.page.getByText(target.id).first().waitFor({ timeout: 20_000 }).catch(() => {});
          const tab = staff.page.getByRole("button", { name: "Payments", exact: true });
          const clicked = await tab.click({ timeout: 10_000 }).then(() => true).catch(() => false);
          await staff.page.waitForTimeout(800);
          const text = (await staff.page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
          const shot = await staff.shot(`bcc-payments-${service}`);
          uiDefects({ ...view, shot }, "Operations");
          const fact = target.fact;
          const status = fact?.paymentStatus ?? row?.payment_status, amount = fact?.b?.payment_amount ?? row?.payment_amount, due = fact?.b?.amount_due_now ?? row?.amount_due_now;
          const refundCount = fact ? fact.refundCases.length : (row?.refunds || []).length;
          const checks = [
            [`PAYMENT STATUS ${A.pretty(status)}`, new RegExp(`PAYMENT STATUS\\s+${A.pretty(status).replace(/ /g, "\\s+")}`, "i")],
            [`amount ${A.inr0(amount)}`, new RegExp(A.inr0(amount).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
            [`Due now ${A.inr0(due)}`, new RegExp(`Due now\\s+${A.inr0(due).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")],
            [`Refund cases ${refundCount}`, new RegExp(`Refund cases\\s+${refundCount}\\b`, "i")],
          ];
          const missing = checks.filter(([, pattern]) => !pattern.test(text)).map(([expectedText]) => expectedText);
          const apiMismatch = fact && row && (String(row.payment_status) !== fact.paymentStatus || !A.same(row.payment_amount, fact.b.payment_amount)) ? `BCC API payment ${row.payment_status} ₹${row.payment_amount} ≠ D1 ${fact.paymentStatus} ₹${fact.b.payment_amount}` : null;
          const ok = loadOk(view) && clicked && Boolean(row) && !missing.length && !apiMismatch;
          out.ui.push({ view: "booking-command-center", service, bookingId: target.id, ok, missing, apiMismatch, found: Boolean(row) });
          record({ suite: SUITE, journey, combo: `${service}: ${target.id}`, result: ok ? "PASS" : "FAIL", detail: clip(`${loadDetail(view)}; API ${snapshot.status} ${row ? "found" : "not found"}; Payments tab ${clicked ? "opened" : "not clickable"}; expected ${checks.map(([t]) => t).join(" · ")}${missing.length ? `; missing on screen: ${missing.join(" · ")}` : ""}${apiMismatch ? `; ${apiMismatch}` : ""}`), evidence: [view.shot, shot] });
          if (row && (missing.length || apiMismatch) && clicked) finding({ suite: SUITE, severity: apiMismatch ? "P1" : "P2", area: "Operations", persona: "Founder", flow: "Booking Command Center — Payments", title: `Booking Command Center Payments tab disagrees with D1 for ${service} booking ${target.id}`, steps: `Sign in as ${FOUNDER}, open /booking-command-center?bookingId=${target.id}, Payments tab`, expected: checks.map(([t]) => t).join(" · "), actual: clip(`${missing.length ? `missing: ${missing.join(" · ")}` : ""} ${apiMismatch || ""} :: ${text.slice(text.search(/PAYMENT STATUS/i), text.search(/PAYMENT STATUS/i) + 200)}`, 600), evidence: [shot] });
          if (!row && snapshot.status === 200) finding({ suite: SUITE, severity: "P1", area: "Operations", persona: "Founder", flow: "Booking Command Center search", title: `Booking Command Center search does not find ${service} booking ${target.id}`, steps: `GET /api/booking-command-center?q=${target.id} as ${FOUNDER}`, expected: "the booking is returned", actual: `HTTP 200, ${(snapshot.body?.bookings || []).length} booking(s), none with this id`, evidence: [shot] });
        } catch (error) { record({ suite: SUITE, journey, combo: `${service}: ${target.id}`, result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] }); }
      }
    } catch (error) {
      record({ suite: SUITE, journey: "Finance hub /team/finance (founder)", combo: FOUNDER, result: "BLOCKED", detail: `harness: founder sign-in: ${String(error?.message || error).slice(0, 300)}`, evidence: [] });
    }
    await staff.close();
  }
} finally {
  out.finishedAt = new Date().toISOString();
  writeJson("transactions-audit.json", out);
  if (browser) await browser.close();
}
