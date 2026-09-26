// Live checks for the PR #1103 fixes that staging can exercise. Runs after 06 (and 08, which reads the same stay):
//  - STAFF-05: a Boarding refund reaches the books. On 06's paid split stay the customer asks to cancel, Finance
//    approves ₹500 and records the refund reference; staging D1 (read-only) must show the canonical refund case
//    processed, reconciliation refunded ₹500, the booking payment partially refunded, the collection reversal
//    posted and the refund on the booking timeline, and the customer's manage page must show the refund.
//  - STAFF-02: the cancellation waits in Finance's Boarding queue, and /team/finance/boarding opens on it.
//  - SIT-04: a Pet Sitting Home Visit quotes ₹399 for 60 minutes and is refused for 2 hours.
//  - STAFF-03: the public relocation enquiry form submits through the screen (the Domestic/International choice).
// Only this run's own synthetic booking and a clearly labelled synthetic enquiry are touched.
import { BASE, launch, newFlow, settle, api, otpCustomerSession, staffSession, runPhone, dismissCookies, readBookings, record, finding, writeJson, d1, isoDay } from "../lib.mjs";

const SUITE = "10-refund-and-staff-fixes";
// The Finance role is MFA-gated on staging (lib/admin-mfa.ts: admin and finance are privileged) and the seeded Finance
// persona has no MFA enrolment, so the founder (permissions ["*"], not privileged) takes the Finance actions. The Finance
// persona is only checked for the MFA refusal.
const FINANCE = "founder@pawspace.in", FINANCE_PERSONA = "anjali.finance33@tkpetcare.in";
const out = { suite: SUITE };
const browser = await launch();
try {
  // STAFF-05 — the Boarding refund chain.
  const stay = readBookings(row => row.suite === "06-money-and-maps" && row.service === "boarding" && row.paid).at(-1);
  const customer = await newFlow(browser, "10-refund-customer");
  const finance = await newFlow(browser, "10-refund-finance");
  try {
    if (!stay?.bookingId) throw new Error("no paid Boarding stay from 06 in this run");
    const bookingId = stay.bookingId, reference = `rfnd_master_${runPhone(10)}`;
    const act = (context, action, extra = {}) => api(context, "POST", "/api/boarding-finance", { bookingId, action, idempotencyKey: `m10-${action}-${bookingId}`, reason: "Master E2E refund chain check", ...extra });
    await otpCustomerSession(customer.context, runPhone(6), "Master E2E Money");
    const requested = await act(customer.context, "request_cancel");
    await staffSession(finance.context, FINANCE);
    // STAFF-02: the request is waiting in Finance's Boarding queue, and the workspace opens on it.
    const queue = await api(finance.context, "GET", "/api/boarding-finance?view=queue");
    const listed = JSON.stringify(queue.body?.data ?? queue.body).includes(bookingId);
    const workspace = await finance.page.goto(`${BASE}/team/finance/boarding?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" }).catch(() => null);
    await dismissCookies(finance.page); await settle(finance.page, 4000);
    const workspaceText = (await finance.page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
    const workspaceShot = await finance.shot("boarding-finance-workspace");
    record({ suite: SUITE, journey: "Boarding finance workspace (STAFF-02)", combo: `${bookingId} waiting on Finance`, result: queue.status === 200 && listed && workspace?.status() === 200 && workspaceText.includes(bookingId) ? "PASS" : "FAIL", detail: JSON.stringify({ queue: queue.status, listed, page: workspace?.status() ?? null, text: workspaceText.slice(0, 300) }), evidence: [workspaceShot] });
    // The Finance persona itself is refused until it enrols in MFA (a security control, not a defect).
    const persona = await newFlow(browser, "10-refund-finance-persona");
    try {
      await staffSession(persona.context, FINANCE_PERSONA);
      const refused = await api(persona.context, "GET", "/api/boarding-finance?view=queue");
      record({ suite: SUITE, journey: "Finance persona needs MFA", combo: FINANCE_PERSONA, result: refused.status === 403 && /MFA/.test(JSON.stringify(refused.body)) ? "PASS" : "FAIL", detail: `HTTP ${refused.status} ${JSON.stringify(refused.body).slice(0, 200)}`, evidence: [] });
    } catch (e) { record({ suite: SUITE, journey: "Finance persona needs MFA", combo: FINANCE_PERSONA, result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 200)}`, evidence: [] }); }
    await persona.close();
    const approved = await act(finance.context, "approve_cancel", { approvedRefundAmount: 500 });
    const recorded = await act(finance.context, "record_refund", { refundReference: reference });
    out.refund = { bookingId, request: { status: requested.status, body: requested.body?.data?.status ?? requested.body }, approve: { status: approved.status, body: approved.body?.data ?? approved.body }, record: { status: recorded.status, body: recorded.body?.data ?? recorded.body } };
    const books = {
      refundCase: await d1("SELECT status, gateway_reference, amount FROM booking_refund_cases WHERE booking_id=?", [bookingId]),
      reconciliation: await d1("SELECT refunded_amount, gateway_status, reconciliation_status FROM payment_reconciliation_records WHERE booking_id=?", [bookingId]),
      payment: await d1("SELECT status FROM booking_payments WHERE booking_id=?", [bookingId]),
      reversal: await d1("SELECT amount, verification_status FROM collection_ledger_postings WHERE group_key=?", [`COLL-refund_completed-${reference}`]),
      timeline: await d1("SELECT COUNT(*) AS n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='refund_processed'", [bookingId]),
    };
    out.refund.books = books;
    const first = value => Array.isArray(value) ? value[0] : null;
    const reachedBooks = first(books.refundCase)?.status === "processed" && first(books.refundCase)?.gateway_reference === reference
      && Number(first(books.reconciliation)?.refunded_amount) === 500 && first(books.payment)?.status === "partially_refunded"
      && Number(first(books.reversal)?.amount) === 500 && Number(first(books.timeline)?.n) === 1;
    const stepsOk = [200, 202].includes(requested.status) && approved.status === 200 && recorded.status === 200 && recorded.body?.data?.refundPosted === true;
    record({ suite: SUITE, journey: "Boarding refund reaches the books (STAFF-05)", combo: `${bookingId}: approve ₹500, record ${reference}`, result: stepsOk && reachedBooks ? "PASS" : (stepsOk || approved.status === 200 ? "FAIL" : "BLOCKED"), detail: JSON.stringify({ books, reachedBooks, request: out.refund.request, approve: approved.status, record: recorded.status, refundPosted: recorded.body?.data?.refundPosted ?? null }).slice(0, 900), evidence: [] });
    if (stepsOk && !reachedBooks) finding({ suite: SUITE, severity: "P1", area: "Payments", persona: "Finance", flow: "Boarding refund", title: "A recorded Boarding refund did not reach the canonical books on staging", steps: `request_cancel, approve_cancel ₹500, record_refund ${reference} on ${bookingId}`, expected: "refund case processed, reconciliation refunded 500, payment partially_refunded, reversal posted, timeline event", actual: JSON.stringify(books).slice(0, 400), evidence: [] });

    // What the customer sees on the manage page.
    let seen = "", shot = null;
    for (const path of [`/v2/boarding/manage?bookingId=${encodeURIComponent(bookingId)}`, `/boarding/manage?bookingId=${encodeURIComponent(bookingId)}`]) {
      const response = await customer.page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" }).catch(() => null);
      if (!response || response.status() >= 400) continue;
      await dismissCookies(customer.page); await settle(customer.page, 3000);
      await customer.page.getByText("Loading stay status").first().waitFor({ state: "detached", timeout: 45_000 }).catch(() => {});
      seen = (await customer.page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
      shot = await customer.shot("manage-after-refund");
      if (seen) break;
    }
    const shows = /refund of ₹500\.00 has been paid back/.test(seen);
    record({ suite: SUITE, journey: "Customer sees the Boarding refund (STAFF-05)", combo: "manage page after the refund", result: shows ? "PASS" : (seen ? "FAIL" : "BLOCKED"), detail: (seen.match(/The stay is cancelled[^.]*\.[^.]*\./)?.[0] || seen).slice(0, 400), evidence: shot ? [shot] : [] });
  } catch (e) { record({ suite: SUITE, journey: "Boarding refund reaches the books (STAFF-05)", combo: "06 split stay", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await customer.close(); await finance.close();

  // SIT-04 — a Home Visit is one 60-minute visit (owner decision): 60 minutes quotes ₹399, 2 hours is refused.
  const quoter = await newFlow(browser, "10-sitting-visit-quote");
  try {
    const day = isoDay(125), at = (hhmm) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
    const zone = (await api(quoter.context, "GET", "/api/service-zone?pincode=560038")).body?.data?.assignment || {};
    const quote = (end) => api(quoter.context, "POST", "/api/sitting-commercial", { packageCode: "sitting-visit-60", petCount: 1, scheduledStart: at("10:00"), scheduledEnd: at(end), paymentMode: "prepaid", cityId: zone.cityId, zoneId: zone.zoneId });
    const hour = await quote("11:00"), twoHours = await quote("12:00");
    out.sittingVisit = { hour: { status: hour.status, total: hour.body?.data?.totalAmount ?? null, error: hour.body?.error ?? null }, twoHours: { status: twoHours.status, error: twoHours.body?.error ?? null } };
    const ok = hour.status < 300 && Number(out.sittingVisit.hour.total) === 399 && twoHours.status === 409 && /Home Visit is 60 minutes/.test(String(out.sittingVisit.twoHours.error || ""));
    record({ suite: SUITE, journey: "Pet Sitting Home Visit is 60 minutes (SIT-04)", combo: "1 pet: 60 min vs 2 h", result: ok ? "PASS" : "FAIL", detail: JSON.stringify(out.sittingVisit), evidence: [] });
  } catch (e) { record({ suite: SUITE, journey: "Pet Sitting Home Visit is 60 minutes (SIT-04)", combo: "quote", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await quoter.close();

  // STAFF-03 — the relocation enquiry form, through the screen.
  const visitor = await newFlow(browser, "10-relocation-enquiry");
  try {
    await visitor.page.goto(`${BASE}/relocation-enquiry`, { waitUntil: "domcontentloaded" });
    await dismissCookies(visitor.page); await settle(visitor.page, 1500);
    const page = visitor.page, byLabel = (label) => page.getByLabel(label, { exact: false }).first();
    await byLabel("Customer name").fill("Master E2E Relocation");
    await byLabel("Primary phone").fill(`9${runPhone(3).slice(-9)}`);
    await page.locator("input[type='email']").first().fill(`master-e2e+${runPhone(3)}@pawspace.test`);
    await page.getByRole("radio", { name: /Domestic/ }).check();
    const dates = page.locator("input[type='date']");
    await dates.nth(0).fill(isoDay(120)); await dates.nth(1).fill(isoDay(121));
    await page.locator("input[type='time']").first().fill("10:00");
    await byLabel("pickup location").fill("Indiranagar, Bengaluru 560038");
    await byLabel("drop location").fill("Bandra West, Mumbai 400050");
    const before = await visitor.shot("relocation-filled");
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().includes("/api/relocation-enquiry") && r.request().method() === "POST", { timeout: 20_000 }),
      page.getByRole("button", { name: /submit|send|request/i }).first().click(),
    ]);
    await settle(page, 1500);
    const after = await visitor.shot("relocation-submitted");
    const body = await response.json().catch(() => ({}));
    out.relocation = { status: response.status(), id: body?.data?.id || null, kind: body?.data?.relocationKind || null, error: body?.error || null };
    record({ suite: SUITE, journey: "Relocation enquiry form submits (STAFF-03)", combo: "public form, Domestic", result: response.status() < 300 && out.relocation.kind === "domestic" ? "PASS" : "FAIL", detail: JSON.stringify(out.relocation), evidence: [before, after] });
  } catch (e) { record({ suite: SUITE, journey: "Relocation enquiry form submits (STAFF-03)", combo: "public form", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await visitor.close();
} finally {
  writeJson("refund-and-staff-fixes.json", out);
  await browser.close();
}
