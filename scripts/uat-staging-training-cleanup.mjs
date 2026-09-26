// Founder-approved cleanup of STALE UAT Dog Training sessions on the isolated STAGING origin only.
//
// Founder approval (26 Sep 2026): "run a scripted cleanup of UAT test records only". Past Training
// sessions that never started stay scheduled/accepted forever, so the partner app keeps offering an
// Accept button on them and counts them as active jobs.
//
// Every change goes through the application's own governed staff API, never raw SQL:
//   POST /api/training-sessions {action:"cancel_session"} (app/api/training-sessions/route.ts ->
//   mutateTrainingSession in lib/training-session-lifecycle.ts). That action is staff-only
//   (bookings.manage), needs a written reason, runs the atomic provider-lifecycle transition, sets the
//   session to cancelled, releases its scheduling reservation (status cancelled), records the session as
//   NOT consumed, opens a "cancel" recovery case carrying the reason, writes a training_session_events row
//   keyed by our idempotency key and a security audit event. It creates no refund instruction, no credit
//   note and no trainer earning, and it does not change the booking or its payment.
//
// Deliberately NOT used:
//   no_show        - counts the session as used under the founder's policy (no_show_treatment chargeable),
//                    i.e. it moves money, and keeps the reservation and the partner-app job active.
//   /api/training-cancellation - the programme-level maker/checker refund workflow (refunds, credit notes,
//                    coupon restoration). Money-bearing, and it needs a second approver.
// Sessions that are on_the_way or arrived cannot be cancelled by the lifecycle (only no_show applies), so
// they are listed for manual review and left unchanged. Unpaid (payment_pending) Training bookings older
// than 7 days are only counted: Training has no governed expire/cancel-unpaid action.
//
// Default is a dry run. Only DRY_RUN=false applies changes. The script refuses any origin other than the
// staging worker. It never prints the access code or the session cookie.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const STAGING_HOST = "pawspace-staging.karthik-fce.workers.dev";
export const STAFF_EMAIL = "founder@pawspace.in";
export const CLEANUP_ACTION = "cancel_session";
export const CLEANUP_REASON = "UAT stale test data cleanup (founder-approved 26 Sep 2026)";
export const IDEMPOTENCY_PREFIX = "uat-stale-training-cleanup-2026-09-26";
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const UNPAID_REPORT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** The six seeded UAT trainers (scripts/uat-staging-provider-capacity.sql), always read even if inactive. */
export const UAT_TRAINER_IDS = ["uatcap_train_ft", "uatcap_train_east", "uatcap_train_south", "uatcap_train_north", "uatcap_train_west", "uatcap_train_central"];
/** Pre-start statuses cancel_session accepts (requireState in lib/training-session-lifecycle.ts). */
export const CANCELLABLE_STATUSES = ["locked", "scheduled", "accepted", "reschedule_requested"];
/** Pre-start statuses the lifecycle cannot cancel; the only terminal action there is the money-bearing no_show. */
export const REPORT_ONLY_STATUSES = ["on_the_way", "arrived"];
/** Booking statuses for which the lifecycle refuses every session action ("Training booking is no longer active"). */
export const INACTIVE_BOOKING_STATUSES = ["cancelled", "refunded", "failed", "expired", "completed"];
const LISTING_LIMIT = 200;

export class CleanupRefused extends Error {}

/** Hard guard: returns the staging origin, or throws for anything that is not exactly the staging worker. */
export function assertStagingTarget(baseUrl) {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) throw new CleanupRefused(`BASE_URL is required and must be https://${STAGING_HOST}`);
  let url;
  try { url = new URL(raw); } catch { throw new CleanupRefused("BASE_URL is not a valid URL"); }
  if (url.protocol !== "https:" || url.host !== STAGING_HOST || url.username || url.password) {
    throw new CleanupRefused(`Refusing to run: BASE_URL host must be exactly ${STAGING_HOST} over https (got ${url.protocol}//${url.host})`);
  }
  return url.origin;
}

/** Dry run unless DRY_RUN is exactly "false". */
export function resolveRunMode(env = {}) {
  return { dryRun: env.DRY_RUN !== "false" };
}

/** Same session -> same key, so a re-run replays instead of acting twice. */
export function cleanupIdempotencyKey(sessionId) {
  const id = String(sessionId ?? "").trim();
  if (!id) throw new Error("A session id is required for the idempotency key");
  return `${IDEMPOTENCY_PREFIX}:${CLEANUP_ACTION}:${id}`;
}

/**
 * Decide what to do with one session. Returns null when the session is out of scope (not stale, not
 * pre-start), otherwise { plan, note } where plan is cancel_session or "none" (listed, left unchanged).
 */
export function classifySession(session, { now, bookingStatus } = {}) {
  const start = Date.parse(String(session?.scheduled_start ?? ""));
  if (!Number.isFinite(start) || !Number.isFinite(now) || start > now - STALE_AFTER_MS) return null;
  const status = String(session?.status ?? "");
  const booking = String(bookingStatus ?? "");
  if (CANCELLABLE_STATUSES.includes(status)) {
    if (INACTIVE_BOOKING_STATUSES.includes(booking)) return { plan: "none", note: `booking is already ${booking}; the lifecycle refuses session actions on it` };
    return { plan: CLEANUP_ACTION, note: "" };
  }
  if (REPORT_ONLY_STATUSES.includes(status)) return { plan: "none", note: `no staff cancel from ${status}; only no_show applies and it counts the session as used (money) - manual review` };
  return null;
}

/** booking_id -> { bookingStatus, paymentStatus } from the /api/training-ops programme rows. */
export function bookingIndex(programmes = []) {
  const index = new Map();
  for (const programme of programmes) {
    const bookingId = String(programme?.booking_id ?? "");
    if (bookingId) index.set(bookingId, { bookingStatus: String(programme.booking_status ?? ""), paymentStatus: String(programme.payment_status ?? "") });
  }
  return index;
}

/** Every trainer whose sessions must be read: the seeded UAT trainers, the ops roster and any session owner. */
export function trainerProviderIds({ programmes = [], trainers = [] } = {}) {
  const ids = new Set(UAT_TRAINER_IDS);
  for (const trainer of trainers) if (trainer?.id) ids.add(String(trainer.id));
  for (const programme of programmes) for (const session of programme?.sessions ?? []) if (session?.provider_id) ids.add(String(session.provider_id));
  return [...ids].sort();
}

/** Stale pre-start sessions, de-duplicated and ordered by booking then sequence (so unlocks cascade in order). */
export function selectCandidates(sessions = [], { now, bookings = new Map() } = {}) {
  const byId = new Map();
  for (const session of sessions) {
    const id = String(session?.id ?? "");
    if (id && !byId.has(id)) byId.set(id, session);
  }
  const rows = [];
  for (const [sessionId, session] of byId) {
    const bookingId = String(session.booking_id ?? "");
    const booking = bookings.get(bookingId);
    const decision = classifySession(session, { now, bookingStatus: booking?.bookingStatus });
    if (!decision) continue;
    rows.push({
      sessionId,
      bookingId,
      programmeId: String(session.programme_id ?? ""),
      providerId: String(session.provider_id ?? ""),
      sequenceNo: Number(session.sequence_no ?? 0),
      scheduledStart: String(session.scheduled_start ?? ""),
      oldStatus: String(session.status ?? ""),
      bookingStatus: booking?.bookingStatus || "unknown",
      paymentStatus: booking?.paymentStatus || "unknown",
      action: decision.plan,
      note: decision.note,
      result: "",
    });
  }
  return rows.sort((a, b) => a.bookingId.localeCompare(b.bookingId) || a.sequenceNo - b.sequenceNo || a.scheduledStart.localeCompare(b.scheduledStart) || a.sessionId.localeCompare(b.sessionId));
}

/** Unpaid Training bookings older than 7 days (reported only; there is no governed expiry action). */
export function selectStaleUnpaidBookings(programmes = [], { now } = {}) {
  return programmes
    .filter(p => String(p?.booking_status ?? "") === "payment_pending" && Number.isFinite(Number(p?.created_at)) && Number(p.created_at) < now - UNPAID_REPORT_AFTER_MS)
    .map(p => ({ bookingId: String(p.booking_id), programmeId: String(p.id ?? ""), planCode: String(p.plan_code ?? ""), createdAt: new Date(Number(p.created_at)).toISOString(), paymentStatus: String(p.payment_status ?? "none") }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Replaces every known secret (access code, cookie) before anything is printed or written. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) if (secret && String(secret).length >= 4) out = out.split(String(secret)).join("[redacted]");
  return out;
}

/** The name=value pair of the UAT staff session cookie from a /api/staging-login response. */
export function uatSessionCookie(headers) {
  const list = typeof headers?.getSetCookie === "function" ? headers.getSetCookie() : [String(headers?.get?.("set-cookie") ?? "")];
  for (const raw of list) {
    const pair = String(raw).split(";")[0].trim();
    if (pair.startsWith("pawspace_uat=") && pair.length > "pawspace_uat=".length) return pair;
  }
  return "";
}

export function formatTable(rows, columns) {
  const widths = columns.map(([key, title]) => Math.max(title.length, ...rows.map(row => String(row[key] ?? "").length)));
  const line = values => values.map((value, i) => String(value).padEnd(widths[i])).join(" | ").trimEnd();
  return [line(columns.map(([, title]) => title)), widths.map(w => "-".repeat(w)).join("-+-"), ...rows.map(row => line(columns.map(([key]) => row[key] ?? "")))].join("\n");
}

const TABLE_COLUMNS = [["sessionId", "session id"], ["bookingId", "booking id"], ["providerId", "provider"], ["scheduledStart", "scheduled start"], ["oldStatus", "old status"], ["action", "action"], ["result", "result"]];

function createClient(origin, fetcher) {
  let cookie = "";
  return {
    setCookie(value) { cookie = value; },
    async request(path, { method = "GET", body, timeoutMs = 60_000 } = {}) {
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new CleanupRefused("Refusing a request outside the staging origin");
      const headers = { accept: "application/json", "user-agent": "pawspace-uat-staging-training-cleanup" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (method !== "GET") headers.origin = origin;
      if (cookie) headers.cookie = cookie;
      const response = await fetcher(url.href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text().catch(() => "");
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: response.status, body: json, text: json ? "" : text, headers: response.headers };
    },
  };
}

const errorText = res => `HTTP ${res.status}: ${String((res.body && typeof res.body.error === "string" && res.body.error) || res.text || "no error message").replace(/\s+/g, " ").slice(0, 160)}`;

async function readSessions(client, providerIds, warnings) {
  const sessions = [];
  for (const providerId of providerIds) {
    const res = await client.request(`/api/training-sessions?providerId=${encodeURIComponent(providerId)}`);
    if (res.status !== 200) { warnings.push(`sessions for ${providerId} could not be read: ${errorText(res)}`); continue; }
    const data = Array.isArray(res.body?.data) ? res.body.data : [];
    if (data.length >= LISTING_LIMIT) warnings.push(`sessions for ${providerId} hit the ${LISTING_LIMIT}-row listing limit; sessions beyond it were not examined`);
    sessions.push(...data);
  }
  return sessions;
}

/** Signs in, lists, applies (only when DRY_RUN=false), prints the summary. Returns the report. */
export async function runCleanup({ env = process.env, fetcher = globalThis.fetch, log = console.log, now = Date.now() } = {}) {
  const origin = assertStagingTarget(env.BASE_URL);
  const { dryRun } = resolveRunMode(env);
  const code = String(env.PAWSPACE_UAT_ACCESS_CODE || "").trim();
  if (!code) throw new CleanupRefused("PAWSPACE_UAT_ACCESS_CODE is not set; staff sign-in is impossible");
  const secrets = [code];
  const markdown = [];
  const say = (line = "") => { const safe = redact(line, secrets); markdown.push(safe); log(safe); };
  const sayTable = table => { const safe = redact(table, secrets); markdown.push("```", safe, "```"); log(safe); };
  const client = createClient(origin, fetcher);

  const login = await client.request("/api/staging-login", { method: "POST", body: { code, email: STAFF_EMAIL } });
  if (login.status !== 200) throw new CleanupRefused(`Staff sign-in for ${STAFF_EMAIL} returned ${redact(errorText(login), secrets)}`);
  const cookie = uatSessionCookie(login.headers);
  if (!cookie) throw new CleanupRefused("Staff sign-in returned no UAT session cookie");
  secrets.push(cookie, cookie.slice(cookie.indexOf("=") + 1));
  client.setCookie(cookie);
  const who = await client.request("/api/staging-login");
  if (who.status !== 200 || who.body?.signedInAs?.email !== STAFF_EMAIL) throw new CleanupRefused(`The UAT session is not ${STAFF_EMAIL} (${redact(errorText(who), secrets)})`);

  const ops = await client.request("/api/training-ops", { timeoutMs: 120_000 });
  if (ops.status !== 200) throw new CleanupRefused(`Training operations could not be read: ${redact(errorText(ops), secrets)}`);
  const programmes = Array.isArray(ops.body?.data?.programmes) ? ops.body.data.programmes : [];
  const trainers = Array.isArray(ops.body?.data?.trainers) ? ops.body.data.trainers : [];
  const bookings = bookingIndex(programmes);
  const providerIds = trainerProviderIds({ programmes, trainers });
  const warnings = [];
  if (programmes.length >= 150) warnings.push("/api/training-ops returned its 150-programme limit; booking and unpaid-booking details cover only the most recently updated programmes");
  const opsSessions = programmes.flatMap(p => (p?.sessions ?? []).map(s => ({ ...s, programme_id: s.programme_id ?? p.id, booking_id: s.booking_id ?? p.booking_id })));
  const sessions = [...await readSessions(client, providerIds, warnings), ...opsSessions];
  const rows = selectCandidates(sessions, { now, bookings });

  const counts = { listed: rows.length, eligible: 0, cancelled: 0, replayed: 0, failed: 0, reportOnly: 0 };
  const unlocked = new Set();
  for (const row of rows) {
    if (row.action !== CLEANUP_ACTION) { counts.reportOnly++; row.result = `left unchanged: ${row.note}`; continue; }
    counts.eligible++;
    if (dryRun) { row.result = "would cancel (dry run)"; continue; }
    let res;
    try {
      res = await client.request("/api/training-sessions", { method: "POST", body: { sessionId: row.sessionId, action: CLEANUP_ACTION, idempotencyKey: cleanupIdempotencyKey(row.sessionId), reason: CLEANUP_REASON } });
    } catch (error) {
      counts.failed++; row.result = `FAILED request error: ${error instanceof Error ? error.name : "unknown"} (re-run is safe: same idempotency key)`; continue;
    }
    if (res.status !== 200) { counts.failed++; row.result = `FAILED ${errorText(res)}`; continue; }
    const data = res.body?.data ?? {};
    const parts = [data.duplicatePrevented ? "already cancelled by an earlier run (idempotent replay)" : "cancelled"];
    if (data.duplicatePrevented) counts.replayed++; else counts.cancelled++;
    if (unlocked.has(row.sessionId)) parts.push("was unlocked by the previous cancellation");
    if (data.caseId) parts.push(`recovery case ${data.caseId}`);
    if (data.nextSession?.sessionId) { unlocked.add(String(data.nextSession.sessionId)); parts.push(`unlocked next session ${data.nextSession.sessionId}`); }
    row.result = parts.join("; ");
  }

  const unpaid = selectStaleUnpaidBookings(programmes, { now });
  say(`# UAT staging stale Training session cleanup (${dryRun ? "DRY RUN - nothing changed" : "APPLY"})`);
  say("");
  say(`- Origin: ${origin}`);
  say(`- Signed in as: ${STAFF_EMAIL} (UAT staging login)`);
  say(`- Governed action: POST /api/training-sessions action=${CLEANUP_ACTION}, reason "${CLEANUP_REASON}"`);
  say(`- Idempotency key: ${IDEMPOTENCY_PREFIX}:${CLEANUP_ACTION}:<session id>`);
  say(`- Scope: scheduled start before ${new Date(now - STALE_AFTER_MS).toISOString()} and status ${[...CANCELLABLE_STATUSES, ...REPORT_ONLY_STATUSES].join("/")}`);
  say(`- Trainers read: ${providerIds.join(", ")}`);
  say(`- Run at: ${new Date(now).toISOString()}`);
  say("");
  if (rows.length) sayTable(formatTable(rows, TABLE_COLUMNS)); else say("No stale pre-start Training sessions found.");
  say("");
  say(`Summary: ${counts.listed} stale pre-start session(s); ${counts.eligible} eligible for ${CLEANUP_ACTION}; ${dryRun ? `${counts.eligible} would be cancelled` : `${counts.cancelled} cancelled, ${counts.replayed} idempotent replay(s), ${counts.failed} failed`}; ${counts.reportOnly} left unchanged for manual review.`);
  say("Money: cancel_session creates no refund, credit note, payout or earning and leaves the booking and its payment unchanged; each cancelled session is recorded as not consumed.");
  say("");
  say(`Unpaid (payment_pending) Training bookings older than 7 days: ${unpaid.length}. Left unchanged - Training has no governed expire/cancel-unpaid action (the only booking-level route, /api/training-cancellation, is the maker/checker refund workflow).`);
  if (unpaid.length) sayTable(formatTable(unpaid, [["bookingId", "booking id"], ["programmeId", "programme"], ["planCode", "plan"], ["createdAt", "created"], ["paymentStatus", "payment"]]));

  if (!dryRun) {
    const after = selectCandidates(await readSessions(client, providerIds, []), { now, bookings }).filter(row => row.action === CLEANUP_ACTION);
    counts.remaining = after.length;
    say("");
    say(`Verification re-read: ${after.length} stale session(s) still eligible for ${CLEANUP_ACTION}.`);
  }
  if (warnings.length) { say(""); for (const warning of warnings) say(`WARNING: ${warning}`); }

  const reportPath = String(env.CLEANUP_REPORT || "").trim();
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${markdown.join("\n")}\n`);
  }
  return { dryRun, origin, rows, counts, unpaid, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCleanup().then(report => {
    if (!report.dryRun && (report.counts.failed > 0 || report.counts.remaining > 0)) process.exitCode = 1;
  }).catch(error => {
    console.error(`Cleanup refused: ${redact(error instanceof Error ? error.message : "unexpected error", [String(process.env.PAWSPACE_UAT_ACCESS_CODE || "").trim()])}`);
    process.exitCode = 1;
  });
}
