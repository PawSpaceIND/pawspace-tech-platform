// 50-leads-crm — the lead journey for Boarding, Pet Sitting and Pet Taxi, from first contact to a booked customer.
//
// Lead lifecycle as the product implements it (read from app/crm, app/api/crm, app/api/revenue-crm,
// app/api/public-contact, app/api/ai-web-chat, lib/lead-*.ts, app/assisted-booking, lib/lead-conversion-attribution.ts):
//  intake   staff "＋ Add lead" (/crm, POST /api/crm: crm_contacts CU-xxxxx + lead_work_items LEAD-<ts>, owner from the
//           assignment members, first-response task 10 min) · public /contact form and the signed-out /v2/chat bot
//           (POST /api/public-contact: CRM contact + lead owned by "AI Orchestrator", plus a canonical customer for the
//           phone) · /relocation-enquiry (relocation_enquiries only, listed at /team/relocation-enquiries, not a CRM lead)
//  work     /crm "Revenue & CX engine": Lead lifecycle (Rotate day = advance_day -> assignment/SLA rotation) and Mandatory
//           RNR (Log RNR call, Queue WhatsApp, Connected, Cold + recycle); callbacks and assignment are API-only
//  convert  "Book this customer →" -> /assisted-booking (Grooming order, or the Pet Taxi panel); Training has a booking
//           link. A lead converts when a booking for the SAME customer id and service is created (attribution "lead")
//           and its payment is captured (lead_work_items.converted_booking_id).
//  360      /team/sales (Customer 360: canonical customers merged with CRM contacts).
//
// Journeys: L1 staff intake + work + manager view · L2 staff conversion per service, the self-booking alternative, a
// public lead that books Boarding itself and gets a staff-assisted Pet Taxi (both paid) · L3 relocation enquiry ·
// L4 signed-out web chat (Boarding enquiry, Request a call) · L5 Customer 360 of the converted lead · entry points.
// Everything created is synthetic ("Master E2E Lead …"). Leads use their own phone space: 96 + the run digits + slot
// (derived from runPhone) so a lead never matches a customer another suite signs in with runPhone(slot) in the same
// run (every suite shares GITHUB_RUN_ID). WhatsApp consent is never given and no WhatsApp/SMS button is pressed.
import {
  BASE, launch, newFlow, settle, api, staffSession, runPhone, dismissCookies, hasAccessCode, d1, isoDay,
  record, finding, saveBooking, writeJson,
} from "../lib.mjs";
import {
  clip, mainText, withResponse, otpProbe, chatScript, conversationText, openCrm, addLeadUI, searchCrm, openRevenueEngine,
  revenueTab, leadCardAction, openAssisted, assistedTaxi, payFromBookingPage, flowProblems,
} from "./_50-leads-crm-helpers.mjs";

const SUITE = "50-leads-crm";
const RUN = String(process.env.GITHUB_RUN_ID || process.env.MASTER_RUN_ID || "0000000").slice(-7).padStart(7, "0");
const SEED = Number(RUN) || 0;
const leadPhone = (slot) => `96${runPhone(slot).slice(2)}`;
// The chat bot accepts letters only in a name, so the run id is spelled with letters there (0->a … 9->j).
const RUN_LETTERS = RUN.split("").map((d) => String.fromCharCode(97 + Number(d))).join("");
const DAY = 111 + (SEED % 18); // Leads window: days 111–130 (Taxi rides use DAY+1 / DAY+2)
const TAXI_TIME = ["09:00", "12:00", "15:00", "18:00"][Math.floor(SEED / 20) % 4];
const ONRUNNER = Boolean(process.env.GITHUB_RUN_ID);
const PAY = ONRUNNER ? process.env.LEADS_PAY !== "0" : process.env.LEADS_PAY === "1";
const ONLY = new Set(String(process.env.LEADS_ONLY || "reloc,entry,contact,chat,book,staff").split(",").map((s) => s.trim()));
const STAFF = { founder: "founder@pawspace.in", manager: "jyoti.manager39@tkpetcare.in", salesManager: "uat.demo.manager@tkpetcare.in", associate: "anita.associate17@tkpetcare.in" };
const SERVICES = [{ key: "boarding", label: "Boarding", slot: 1 }, { key: "sitting", label: "Pet Sitting", slot: 2 }, { key: "taxi", label: "Pet Taxi", slot: 3 }];
const ADDRESS = { label: "Home", line1: "100 Feet Road, HAL 2nd Stage, Indiranagar", area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true };
const istIso = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const NO_CODE = "harness: no UAT access code in this runner";
const masked = (v) => /•|\*{2,}/.test(String(v ?? ""));

const out = { suite: SUITE, run: RUN, day: isoDay(DAY), pay: PAY, public: {}, leads: {}, staff: {}, d1: {} };
const flows = [];
const booked = {};
const rec = (journey, combo, result, detail, evidence = []) => record({ suite: SUITE, journey, combo, result, detail: typeof detail === "string" ? detail.slice(0, 900) : clip(detail, 900), evidence });
const fail = (journey, combo, e, evidence = []) => rec(journey, combo, "BLOCKED", `harness: ${String(e?.message || e).slice(0, 300)}`, evidence);
async function flowOf(browser, name, opts) { const f = await newFlow(browser, name, opts); flows.push(f); return f; }
async function staffFlow(browser, name, email) { const f = await flowOf(browser, name); await staffSession(f.context, email); return f; }

const browser = await launch();
try {
  // ======================================================================================= L3 relocation enquiry (public)
  if (ONLY.has("reloc")) {
    const v = await flowOf(browser, "50-relocation-enquiry", { mobile: true });
    try {
      const page = v.page, phone = leadPhone(7);
      await page.goto(`${BASE}/relocation-enquiry`, { waitUntil: "domcontentloaded" }); await dismissCookies(page); await settle(page, 1500);
      await page.getByLabel("Customer name").fill(`Master E2E Lead Relocation ${RUN}`);
      await page.getByLabel("Primary phone (10 digits)").fill(phone);
      await page.getByLabel(/^Email/).fill(`master-e2e-lead+${RUN}@pawspace.test`);
      await page.getByLabel("Pet type").selectOption("dog");
      await page.getByRole("radio", { name: /International/ }).check();
      await page.getByLabel("Pickup date").fill(isoDay(DAY));
      await page.getByLabel("Pickup approximate time").fill("10:00");
      await page.getByLabel("Pickup location").fill("Indiranagar, Bengaluru 560038");
      await page.getByLabel("Drop location").fill("Dubai Marina, Dubai, UAE");
      await page.getByLabel("Expected travel date").fill(isoDay(DAY + 2));
      await page.keyboard.press("Escape").catch(() => {});
      const filled = await v.shot("relocation-filled");
      const r = await withResponse(page, (res) => res.url().includes("/api/relocation-enquiry") && res.request().method() === "POST", () => page.getByRole("button", { name: "Submit enquiry" }).click(), 25_000);
      await settle(page, 1200);
      const seen = await mainText(page, 600), done = await v.shot("relocation-submitted");
      out.public.relocation = { status: r.status, id: r.body?.data?.id || null, kind: r.body?.data?.relocationKind || null, error: r.body?.error || null, phone, seen };
      const ok = r.status === 200 && out.public.relocation.kind === "international" && /ENQUIRY RECEIVED/i.test(seen) && seen.includes(out.public.relocation.id || "§");
      rec("L3 Relocation enquiry form (public)", "International, Pixel 7", ok ? "PASS" : "FAIL", out.public.relocation, [filled, done]);
      if (!ok && r.status && r.status !== 200) finding({ suite: SUITE, severity: "P1", area: "Leads - relocation enquiry", persona: "Visitor", flow: "/relocation-enquiry", title: "Public relocation enquiry form refused an International enquiry", steps: "Fill every field, choose International, Submit enquiry", expected: "200 with RELQ id and the thank-you screen", actual: clip(out.public.relocation, 300), evidence: [filled, done] });
    } catch (e) { fail("L3 Relocation enquiry form (public)", "International", e); }
  }

  // ======================================================================================= customer entry points
  if (ONLY.has("entry")) {
    const v = await flowOf(browser, "50-entry-points");
    for (const [path, service, want] of [["/v2/boarding", "Boarding", /\/v2\/chat/], ["/v2/sitting", "Pet Sitting", /\/v2\/chat/], ["/v2/taxi", "Pet Taxi", /\/v2\/chat/], ["/services/boarding", "Boarding", /./], ["/services/sitting", "Pet Sitting", /./], ["/services/taxi", "Pet Taxi", /\/contact/]]) {
      try {
        const r = await v.page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" }); await dismissCookies(v.page); await v.page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {}); await v.page.waitForTimeout(2000);
        const links = await v.page.locator("a").evaluateAll((as) => as.map((a) => `${(a.innerText || "").trim().replace(/\s+/g, " ").slice(0, 30)}->${a.getAttribute("href")}`));
        const enquiry = links.filter((l) => /\/v2\/chat|\/contact|\/mobile-app/.test(l)).slice(0, 8);
        const shot = await v.shot(`entry${path.replace(/\//g, "-")}`, { fullPage: false });
        const ok = r?.status() === 200 && enquiry.some((l) => want.test(l));
        rec("Customer enquiry entry point", `${service} ${path}`, ok ? "PASS" : "FAIL", { status: r?.status(), links: enquiry }, [shot]);
      } catch (e) { fail("Customer enquiry entry point", `${service} ${path}`, e); }
    }
  }

  // ======================================================================================= public /contact enquiries (lead customer)
  // One visitor enquires about Boarding and (from the Pet Taxi service page) about Pet Taxi; the second enquiry lands on
  // the same canonical customer. This customer later books Boarding herself and gets a staff-assisted Pet Taxi.
  const leadCustomer = { phone: leadPhone(6), name: `Master E2E Lead Public ${RUN}`, customerId: null, leads: {} };
  out.leadCustomer = leadCustomer;
  if (ONLY.has("contact")) {
    const v = await flowOf(browser, "50-contact-enquiries");
    for (const [service, start] of [["Boarding", "/contact"], ["Pet Taxi", "/services/taxi"]]) {
      try {
        const page = v.page;
        await page.goto(`${BASE}${start}`, { waitUntil: "domcontentloaded" }); await dismissCookies(page); await settle(page, 1500);
        if (start !== "/contact") { await page.getByRole("link", { name: "Check availability" }).first().click(); await page.waitForURL(/\/contact/, { timeout: 20_000 }); await settle(page, 1500); }
        await page.getByLabel("Your name").fill(leadCustomer.name);
        await page.getByLabel("Phone number").fill(leadCustomer.phone);
        await page.getByLabel("Email (optional)").fill(`master-e2e-lead+${RUN}@pawspace.test`);
        await page.getByLabel(/Service you/).selectOption({ label: service });
        await page.getByLabel("Message (optional)").fill(`Master E2E ${service} enquiry for ${isoDay(DAY)} - synthetic test, do not call`);
        const filled = await v.shot(`contact-${service}-filled`);
        // The form gives up after 15 s ("The response timed out … retry with the same details"); the retry reuses the
        // enquiry reference kept in sessionStorage, so it is the product's own recovery path.
        const send = () => withResponse(page, (res) => res.url().includes("/api/public-contact") && res.request().method() === "POST", () => page.getByRole("button", { name: "Send message" }).click(), 20_000);
        const t0 = Date.now();
        let r = await send();
        const firstMs = Date.now() - t0;
        await page.waitForTimeout(1500);
        const timedOut = r.status === null && /response timed out/i.test(await mainText(page, 6000));
        const timeoutShot = timedOut ? await v.shot(`contact-${service}-timed-out`) : null;
        if (timedOut) { r = await send(); await page.waitForTimeout(1500); }
        await settle(page, 800);
        const seen = await mainText(page, 3000), done = await v.shot(`contact-${service}-sent`);
        leadCustomer.leads[service] = { status: r.status, leadId: r.body?.leadId || null, owner: r.body?.governance?.owner ?? r.body?.outbound?.owner ?? null, sla: r.body?.governance?.sla ?? null, outbound: r.body?.outbound?.status ?? null, duplicatePrevented: r.body?.duplicatePrevented ?? null, error: r.body?.error ?? null, firstAttemptMs: firstMs, firstAttemptTimedOut: timedOut };
        const ok = (r.status === 201 || r.status === 200) && Boolean(r.body?.leadId) && /we.ve got it/i.test(seen);
        rec("Public enquiry form (/contact)", `${service} via ${start}`, ok ? (timedOut ? "PARTIAL" : "PASS") : "FAIL", { ...leadCustomer.leads[service], thanks: /we.ve got it/i.test(seen) }, [filled, ...(timeoutShot ? [timeoutShot] : []), done]);
        if (timedOut) finding({ suite: SUITE, severity: "P2", area: "Leads - public enquiry form", persona: "Visitor", flow: `/contact (${service})`, title: "The public enquiry form times out (no answer within 15 s) and tells the visitor their enquiry 'may already be saved'", steps: `${start} > ${start === "/contact" ? "" : "Check availability > "}name, phone ${leadCustomer.phone}, ${service}, message > Send message`, expected: "'Thanks — we've got it' within a few seconds", actual: `No POST /api/public-contact answer within ${firstMs} ms; the form showed 'The response timed out. Your enquiry may already be saved; retry with the same details to recover it safely.' Retry: HTTP ${r.status} duplicatePrevented=${r.body?.duplicatePrevented ?? "?"}.`, evidence: [timeoutShot, done] });
      } catch (e) { fail("Public enquiry form (/contact)", service, e); }
    }
    const unworked = Object.entries(leadCustomer.leads).filter(([, l]) => l.leadId && /AI Orchestrator/i.test(String(l.owner)) && l.sla !== "canonical" && l.outbound !== "queued");
    if (unworked.length) finding({ suite: SUITE, severity: "P2", area: "Leads - public enquiry routing", persona: "Visitor -> Sales staff", flow: "/contact enquiry (Boarding, Pet Taxi)", title: "Public Boarding / Pet Taxi enquiries are owned by 'AI Orchestrator' with no SLA clock and no outbound queue, although the visitor gave no WhatsApp consent", steps: `/contact (and /services/taxi > Check availability) with ${leadCustomer.phone}, WhatsApp box unticked > Send message`, expected: "a human owner or a queued first-response call (the form promises 'Our team will reach out within a couple of hours')", actual: clip(unworked.map(([service, l]) => ({ service, leadId: l.leadId, owner: l.owner, sla: l.sla, outbound: l.outbound })), 400), evidence: [] });
  }

  // ======================================================================================= L4 signed-out web chat
  const chat = { boarding: { phone: leadPhone(4), name: `Master Test Lead Chat ${RUN_LETTERS}` }, call: { phone: leadPhone(5), name: `Master Test Lead Call ${RUN_LETTERS}` } };
  out.public.chat = chat;
  if (ONLY.has("chat")) {
    const checkIn = isoDay(DAY), checkOut = isoDay(DAY + 3);
    const scripts = {
      boarding: [{ choice: "Boarding" }, { text: chat.boarding.name }, { text: chat.boarding.phone }, { choice: "First-time Enquiry" }, { choice: "Bangalore" }, { choice: "Dog" }, { choice: "1" }, { choice: "1 to 3 years" }, { choice: "Overnight - 24 hrs" }, { choice: "2-5 days" }, { text: `${ddmm(checkIn)} 10am` }, { text: `${ddmm(checkOut)} 10am` }, { choice: "No, call me instead" }],
      call: [{ choice: "Request a call" }, { text: chat.call.name }, { text: chat.call.phone }, { choice: "No, call me instead" }],
    };
    for (const kind of ["boarding", "call"]) {
      const combo = kind === "boarding" ? "Boarding enquiry, 'No, call me instead'" : "Request a call, 'No, call me instead'";
      const v = await flowOf(browser, `50-chat-${kind}`, { mobile: true });
      try {
        await v.page.goto(`${BASE}/v2/chat`, { waitUntil: "domcontentloaded" }); await dismissCookies(v.page); await settle(v.page, 2500);
        await v.page.getByRole("group", { name: "Choose an option" }).last().waitFor({ timeout: 20_000 });
        const opened = await v.shot("chat-open");
        const turns = await chatScript(v.page, scripts[kind]);
        const last = turns.at(-1) || {};
        const seen = await conversationText(v.page), done = await v.shot("chat-finished");
        const leadTurn = turns.find((t) => t.lead?.leadId) || {};
        chat[kind] = { ...chat[kind], turns: turns.map((t) => `${t.in} -> ${t.status} ${t.event || ""} ${t.bot.slice(0, 80)}`), event: last.event, leadId: leadTurn.lead?.leadId || null, captured: leadTurn.lead?.captured ?? null, sharedNotice: /Your details were shared with the PawSpace team/.test(seen), closing: clip(last.bot, 400) };
        const ok = turns.length === scripts[kind].length && last.status === 200 && last.event === "completed" && chat[kind].captured === true;
        rec("L4 Web chat enquiry (signed out, /v2/chat)", combo, ok ? "PASS" : "FAIL", { leadId: chat[kind].leadId, sharedNotice: chat[kind].sharedNotice, closing: chat[kind].closing, turns: chat[kind].turns.slice(-4) }, [opened, done]);
        if (!ok && turns.some((t) => t.status >= 500)) finding({ suite: SUITE, severity: "P1", area: "Leads - web chat", persona: "Visitor", flow: "/v2/chat bot", title: `Web chat ${kind} flow failed with a server error`, steps: scripts[kind].map((s) => s.choice || s.text).join(" > "), expected: "each turn 200, flow completed, lead captured", actual: clip(turns, 400), evidence: [done] });
      } catch (e) { fail("L4 Web chat enquiry (signed out, /v2/chat)", combo, e); }
    }
  }

  // ======================================================================================= identity continuity after an enquiry
  // The product resolves a public enquiry to one canonical customer (lib/public-lead-outbound.ts) and customer OTP
  // sign-in looks the phone up in canonical_customers (lib/customer-otp.ts). An enquirer who then signs in must get
  // that same customer, or their own booking can never convert the enquiry's lead.
  const idc = await flowOf(browser, "50-identity-checks");
  if (ONLY.has("chat") && chat.boarding.leadId) {
    try {
      const p = await otpProbe(idc.context, chat.boarding.phone, chat.boarding.name);
      out.public.chatIdentity = p;
      const reused = p.existingCustomer === true && /^CU-/.test(String(p.customerId || ""));
      rec("L4 Chat enquirer signs in (identity continuity)", "Boarding chat lead phone -> customer OTP", reused ? "PASS" : (p.verifyStatus === 200 ? "FAIL" : "BLOCKED"), p);
      if (p.verifyStatus === 200 && !reused) finding({ suite: SUITE, severity: "P1", area: "Leads - web chat / identity", persona: "Visitor who enquired in chat, then signs in", flow: "/v2/chat Boarding enquiry -> customer OTP sign-in", title: "A web chat enquirer who signs in gets a second customer identity, so their own booking can never convert the chat lead", steps: `Complete the signed-out Boarding chat flow with ${chat.boarding.phone} (lead ${chat.boarding.leadId}), then request + verify a customer OTP for the same number`, expected: "OTP request says existingCustomer:true and sign-in resolves to the enquiry's canonical customer (CU-…), as it does for a /contact enquiry typed as 10 digits", actual: `existingCustomer=${p.existingCustomer}, customerId=${p.customerId}. The chat stores the number as "+91XXXXXXXXXX" (lib/web-chat-bot.ts validate) and the canonical customer created for the enquiry keeps that string, while sign-in matches canonical_customers.primary_phone exactly on 10 digits (lib/customer-otp.ts resolveOtpCustomer), so a new CUS-OTP customer is created. Bookings land on it and attributeBookingToOpenLead finds no lead; later public enquiries from the number match two customers and go to identity review.`, evidence: [] });
    } catch (e) { fail("L4 Chat enquirer signs in (identity continuity)", "Boarding chat lead", e); }
  }

  // ======================================================================================= lead customer signs in and books Boarding herself
  const lc = await flowOf(browser, "50-lead-customer");
  if (ONLY.has("book") && ONLY.has("contact") && leadCustomer.leads.Boarding?.leadId) {
    try {
      const p = await otpProbe(lc.context, leadCustomer.phone, leadCustomer.name);
      leadCustomer.customerId = p.customerId; leadCustomer.signIn = p;
      const reused = p.existingCustomer === true && /^CU-/.test(String(p.customerId || ""));
      rec("L2 Public lead signs in (identity continuity)", "/contact enquiry phone -> customer OTP", reused ? "PASS" : (p.verifyStatus === 200 ? "FAIL" : "BLOCKED"), p);
      if (p.verifyStatus === 200 && !reused) finding({ suite: SUITE, severity: "P1", area: "Leads - identity", persona: "Visitor who enquired on /contact, then signs in", flow: "/contact -> customer OTP", title: "A /contact enquirer who signs in is not matched to the enquiry's customer", steps: `Submit /contact with ${leadCustomer.phone}, then customer OTP for the same number`, expected: "existingCustomer:true and the enquiry's CU-… customer", actual: clip(p, 300), evidence: [] });
      if (p.verifyStatus !== 200) throw new Error(`customer OTP for the lead phone refused: ${clip(p, 200)}`);
      const cid = p.customerId;
      await api(lc.context, "POST", "/api/customer-account", { customerId: cid, action: "upsert_pet", idempotencyKey: `m50-pet-${RUN}`, pet: { name: "LeadDog", species: "dog", breed: "Indie", vaccinationStatus: "verified" } });
      await api(lc.context, "POST", "/api/customer-account", { customerId: cid, action: "upsert_address", idempotencyKey: `m50-address-${RUN}`, address: ADDRESS });
      const account = (await api(lc.context, "GET", "/api/customer-account")).body?.data;
      const dog = account?.pets?.find((x) => x.name === "LeadDog");
      leadCustomer.account = { phone: account?.primaryPhone, pets: account?.pets?.length, addresses: account?.addresses?.length };
      if (!dog) throw new Error(`pet not saved for ${cid}: ${clip(account, 200)}`);
      const zone = (await api(lc.context, "GET", "/api/service-zone?pincode=560038")).body?.data;
      const cityId = zone?.assignment?.cityId, zoneId = zone?.assignment?.zoneId;
      const day = isoDay(DAY), scheduledStart = istIso(day, "10:00"), scheduledEnd = istIso(day, "14:00");
      const hosts = (await api(lc.context, "GET", `/api/boarding-commercial?${new URLSearchParams({ cityId, zoneId, scheduledStart, scheduledEnd, petCount: "1", species: "dog" })}`)).body?.data?.hosts || [];
      const host = hosts[0];
      const quote = (await api(lc.context, "POST", "/api/boarding-commercial", { packageCode: "boarding-4h", petCount: 1, cityId, zoneId, scheduledStart, scheduledEnd, paymentMode: "prepaid", providerId: host?.providerId })).body?.data;
      if (!host || !quote?.totalAmount) throw new Error(`no Boarding host/quote for ${day}: hosts=${hosts.length} quote=${clip(quote, 150)}`);
      const reserve = await api(lc.context, "POST", "/api/uat-scheduling", { clientRequestId: `m50-board-${RUN}-${Date.now()}`, customerId: cid, petIds: [dog.id], serviceCode: "boarding", serviceAddress: `${ADDRESS.line1}, Bengaluru, 560038`, servicePincode: "560038", cityId, zoneId, scheduledStart, scheduledEnd, careMode: "visit", preferredProviderId: host.providerId }, { timeout: 150_000 });
      if (!reserve.body?.data?.groupId || !reserve.body?.data?.provider) throw new Error(`Boarding reservation refused: HTTP ${reserve.status} ${clip(reserve.body, 200)}`);
      const created = await api(lc.context, "POST", "/api/canonical-bookings", {
        idempotencyKey: `m50-board-${reserve.body.data.groupId}`, scheduleGroupId: reserve.body.data.groupId,
        customer: { id: cid, name: account.name, primaryPhone: account.primaryPhone },
        pets: [{ sourceId: dog.sourceId ?? dog.id, name: dog.name, species: "dog", breed: "Indie", vaccinationStatus: dog.vaccinationStatus }],
        cityId, zoneId, serviceCode: "boarding", packageCode: quote.packageCode, packageName: quote.packageName, scheduledStart, scheduledEnd,
        provider: reserve.body.data.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
        payment: { method: "upi", mode: "prepaid", status: "created", detail: "Awaiting verified Razorpay payment" }, pricing: { discount: 0, boardingQuoteId: quote.quoteId },
      });
      const bookingId = created.body?.data?.bookingId;
      if (!bookingId) throw new Error(`Boarding booking refused: HTTP ${created.status} ${clip(created.body, 200)}`);
      booked.boarding = { bookingId, providerId: reserve.body.data.provider.id, scheduledStart, total: quote.totalAmount, dueNow: quote.amountDueNow };
      const stay = (await api(lc.context, "GET", `/api/boarding-stays?scope=customer&bookingId=${encodeURIComponent(bookingId)}`)).body?.data?.[0];
      if (stay) await api(lc.context, "POST", "/api/boarding-stays", { stayId: stay.id, action: "submit_care_plan", idempotencyKey: `m50-care-${bookingId}`, carePlan: { vet: "Dr. Rao, Indiranagar Vet Clinic, 9000000001", emergencyContact: "Asha, 9000000002", feeding: "Twice a day", medication: "None", specialInstructions: "Master E2E lead conversion booking" } });
      const pay = await payFromBookingPage(lc, bookingId, { complete: PAY });
      const captured = pay.status?.paymentStatus === "captured";
      booked.boarding.paid = captured;
      saveBooking({ suite: SUITE, bookingId, service: "boarding", packageCode: "boarding-4h", providerId: booked.boarding.providerId, customer: cid, scheduledStart, total: quote.totalAmount, dueNow: quote.amountDueNow, paid: captured, paymentMode: "prepaid" });
      rec("L2 Public Boarding lead books itself (customer app)", `boarding-4h ₹${quote.totalAmount} on ${day}`, captured ? "PASS" : (pay.skippedPayment && pay.opened ? "PARTIAL" : pay.opened ? "FAIL" : "BLOCKED"), { bookingId, customerId: cid, lead: leadCustomer.leads.Boarding?.leadId, payment: pay.status || pay.reason || "checkout opened, payment not completed (LEADS_PAY off)" }, pay.evidence);
      if (pay.opened && PAY && !captured) finding({ suite: SUITE, severity: "P1", area: "Payments", persona: "Customer", flow: "Boarding 4 h, lead customer", title: "Boarding payment completed in Razorpay TEST but not captured within 2 minutes", steps: `Pay ${bookingId} from /v2/booking`, expected: "captured", actual: clip(pay.status, 200), evidence: pay.evidence });
    } catch (e) { fail("L2 Public Boarding lead books itself (customer app)", "boarding-4h", e); }
  }

  // ======================================================================================= staff parts (runner only)
  const staffJourneys = ["L1 Sales associate creates a lead (staff UI)", "L1 Lead in CRM list and detail", "L1 Lead worked in Revenue & CX engine", "L1 Follow-up and assignment", "L1 Manager sees the lead", "L2 Staff converts the lead to a booking", "L2 Staff-assisted Pet Taxi for the lead customer", "L3 Relocation enquiry visible to staff", "L4 Web chat leads visible to staff", "L5 Customer 360 of the converted lead"];
  if (!ONLY.has("staff")) { /* local iteration without the staff part */ }
  else if (!hasAccessCode()) { for (const j of staffJourneys) rec(j, "staff", "BLOCKED", NO_CODE); }
  else {
    const leads = out.leads;
    // ---------------------------------------------------------------- L1 intake: the associate first
    const assoc = await staffFlow(browser, "50-staff-associate", STAFF.associate);
    let creator = null, creatorEmail = null;
    try {
      await openCrm(assoc);
      const svc = SERVICES[0], phone = leadPhone(svc.slot);
      const r = await addLeadUI(assoc, { name: `Master E2E Lead ${svc.label} ${RUN}`, phone, pet: "Bruno", service: svc.label });
      out.staff.associateAdd = { status: r.status, body: r.body, alert: r.alert, toast: r.toast };
      if (r.status === 201 && r.body?.id) leads[svc.key] = { ...svc, phone, id: r.body.id, leadId: r.body.leadId, owner: r.body.assignedOwner, ownerResolved: r.body.ownerResolved, createdBy: STAFF.associate };
      rec("L1 Sales associate creates a lead (staff UI)", `${svc.label} · ${STAFF.associate}`, r.status === 201 ? "PASS" : "FAIL", out.staff.associateAdd, r.evidence);
      if (r.status === 403) finding({ suite: SUITE, severity: "P1", area: "CRM - lead intake", persona: "Sales associate", flow: "/crm ＋ Add lead", title: "A sales associate cannot create a lead: 'Save lead & create follow-up' returns 403 'Permission denied'", steps: `Sign in ${STAFF.associate} (role associate, the role of the seeded sales executives), /crm > ＋ Add lead > name, phone, pet, Boarding > Save lead & create follow-up`, expected: "201 lead saved and a follow-up task created", actual: `POST /api/crm -> ${r.status} ${clip(r.body, 200)}; UI: ${r.alert}. POST /api/crm, /api/revenue-crm (call attempts, rotate day), /api/outbound-orchestrator (power dialler) and lead assignment all require customers.manage, which the associate role does not have, while /crm shows the associate the ＋ Add lead and RNR buttons and leads are auto-assigned to sales team members.`, evidence: r.evidence });
    } catch (e) { fail("L1 Sales associate creates a lead (staff UI)", STAFF.associate, e); }

    // The creator for the rest: the sales manager if the CRM opens for them, else the founder (full access).
    for (const email of [STAFF.salesManager, STAFF.founder]) {
      try {
        const f = await staffFlow(browser, `50-staff-creator-${email.split("@")[0]}`, email);
        const probe = await api(f.context, "GET", "/api/crm?search=master-e2e-probe");
        out.staff[`crmProbe_${email}`] = { status: probe.status, error: probe.body?.error ?? null };
        if (probe.status === 200) { creator = f; creatorEmail = email; break; }
      } catch (e) { out.staff[`crmProbe_${email}`] = String(e?.message || e).slice(0, 200); }
    }
    try {
      if (!creator) throw new Error("neither the sales manager nor the founder could open the CRM");
      await openCrm(creator);
      for (const svc of SERVICES) {
        if (leads[svc.key]) continue;
        const phone = leadPhone(svc.slot);
        const r = await addLeadUI(creator, { name: `Master E2E Lead ${svc.label} ${RUN}`, phone, pet: "Bruno", service: svc.label });
        if (r.status === 201 && r.body?.id) leads[svc.key] = { ...svc, phone, id: r.body.id, leadId: r.body.leadId, owner: r.body.assignedOwner, ownerResolved: r.body.ownerResolved, whatsappAi: r.body.whatsappAi?.status, createdBy: creatorEmail };
        rec("L1 Lead created in CRM (staff UI)", `${svc.label} · ${creatorEmail}`, r.status === 201 && r.body?.id ? "PASS" : "FAIL", { status: r.status, id: r.body?.id, leadId: r.body?.leadId, owner: r.body?.assignedOwner, ownerResolved: r.body?.ownerResolved, ownerException: r.body?.ownerMappingException, toast: r.toast, alert: r.alert, error: r.body?.error }, r.evidence);
        if (r.status === 201 && r.body?.ownerResolved === false) finding({ suite: SUITE, severity: "P2", area: "CRM - lead assignment", persona: "Sales manager", flow: "/crm ＋ Add lead", title: "A new lead gets no owner ('Unassigned'): no active lead-assignment member resolved", steps: `Add a ${svc.label} lead`, expected: "an owner from the sales assignment members", actual: clip(r.body, 300), evidence: r.evidence });
      }
      // In the list and in the detail panel.
      for (const svc of SERVICES) {
        const lead = leads[svc.key];
        if (!lead) { rec("L1 Lead in CRM list and detail", svc.label, "BLOCKED", "harness: lead was not created"); continue; }
        const s = await searchCrm(creator, lead.phone, `crm-detail-${svc.key}`);
        const listed = s.contacts.some((c) => c.id === lead.id);
        const detail = s.text.includes(lead.id) && /Book this customer/.test(s.text);
        lead.listed = listed; lead.detail = { stage: (s.text.match(/Stage\s*(.{0,20}?)\s*Lifetime/) || [])[1] || null, owner: (s.text.match(/Relationship owner\s*(.{0,40}?)\s*Stage/) || [])[1] || null, next: (s.text.match(/NEXT ACTION\s*(.{0,40}?)\s*Book/) || [])[1] || null };
        rec("L1 Lead in CRM list and detail", svc.label, listed && detail ? "PASS" : "FAIL", { id: lead.id, search: s.status, shown: s.shown, listed, detailShowsLead: detail, ...lead.detail }, [s.shot]);
      }
      // No note / stage control on the lead: the detail panel offers only "Book this customer" and "Open canonical 360".
      const boardingLead = leads.boarding;
      if (boardingLead) {
        const s = await searchCrm(creator, boardingLead.phone, "crm-detail-controls");
        const aside = creator.page.locator("aside").filter({ hasText: boardingLead.id }).first();
        const controls = { textareas: await aside.locator("textarea").count().catch(() => -1), selects: await aside.locator("select").count().catch(() => -1), inputs: await aside.locator("input").count().catch(() => -1), buttons: (await aside.getByRole("button").allInnerTexts().catch(() => [])).filter((b) => b.trim()).slice(0, 10), links: (await aside.getByRole("link").allInnerTexts().catch(() => [])).slice(0, 6) };
        out.staff.detailControls = controls;
        const none = controls.textareas === 0 && controls.selects === 0 && controls.inputs === 0;
        rec("L1 Follow-up and assignment", "note / stage control on the lead detail", none ? "FAIL" : "PASS", controls, [s.shot]);
        if (none) finding({ suite: SUITE, severity: "P2", area: "CRM - lead work", persona: "Sales staff", flow: "/crm lead detail", title: "A lead cannot be given a note, a next action or a new stage from the CRM: the detail panel has no such control", steps: `/crm > search ${boardingLead.phone} > lead detail`, expected: "record a call note / follow-up and move the stage (e.g. Qualified, Lost)", actual: `Detail shows Stage '${boardingLead.detail?.stage}' read-only; controls: ${clip(controls, 200)}. The only stage writes are API outcomes (log_attempt 'Interested'/'Opt-out') that no button offers; callbacks (schedule_callback) have no UI.`, evidence: [s.shot] });
      }
    } catch (e) { fail("L1 Lead created in CRM (staff UI)", creatorEmail || "creator", e); }

    // ---------------------------------------------------------------- L1 work: Revenue & CX engine, callback, assignment
    try {
      const lead = leads.boarding;
      if (!creator || !lead) throw new Error("no creator session or Boarding lead");
      await openCrm(creator);
      const engine = await openRevenueEngine(creator);
      const listedLeads = Array.isArray(engine.body?.leads) ? engine.body.leads : [];
      const ours = SERVICES.map((s) => leads[s.key]?.leadId).filter(Boolean);
      const visible = ours.filter((id) => listedLeads.some((l) => l.id === id));
      const closedShown = listedLeads.filter((l) => ["closed", "converted", "cold_exhausted"].includes(String(l.status))).length;
      await revenueTab(creator.page, "Lead lifecycle");
      const lifecycleShot = await creator.shot("revenue-lead-lifecycle");
      out.staff.engine = { status: engine.status, listed: listedLeads.length, ours, visible, closedShown, error: engine.body?.error ?? null };
      rec("L1 Lead worked in Revenue & CX engine", "new leads listed in Lead lifecycle", visible.length === ours.length && ours.length ? "PASS" : "FAIL", out.staff.engine, [lifecycleShot]);
      if (engine.status === 200 && ours.length && visible.length < ours.length) finding({ suite: SUITE, severity: listedLeads.length >= 80 ? "P1" : "P2", area: "CRM - Revenue & CX engine", persona: "Sales staff", flow: "/crm > Revenue & CX engine > Lead lifecycle / Mandatory RNR", title: "New leads are missing from the Revenue & CX engine worklist, so nobody can log their calls or rotate them from the screen", steps: `Create ${ours.join(", ")} in /crm, open Revenue & CX engine`, expected: "the new leads appear in Lead lifecycle and Mandatory RNR", actual: `GET /api/revenue-crm returned ${listedLeads.length} leads (${closedShown} of them closed/converted/cold) and none/only some of ours (${visible.join(",") || "none"}). The query orders by manager_alert_at ascending with LIMIT 80 and no status filter (app/api/revenue-crm/route.ts), so once 80 older leads exist every new lead is cut off.`, evidence: [lifecycleShot] });
      // Work the Boarding lead: Rotate day (stage day_1 -> day_2), Log RNR call, Connected. WhatsApp is never queued.
      const act = async (label, uiTab, button, apiBody) => {
        let r = { status: null, error: "not in list" }, via = "ui";
        if (visible.includes(lead.leadId)) { await revenueTab(creator.page, uiTab); r = await leadCardAction(creator.page, lead.leadId, button); }
        if (r.status === null) { via = "api"; const a = await api(creator.context, "POST", "/api/revenue-crm", apiBody); r = { status: a.status, body: a.body }; }
        const shot = await creator.shot(`revenue-${label}`);
        return { via, status: r.status, body: clip(r.body, 300), shot };
      };
      const rotate = await act("rotate-day", "Lead lifecycle", "Rotate day", { action: "advance_day", leadId: lead.leadId });
      const rnr = await act("log-rnr", "Mandatory RNR", "Log RNR call", { action: "log_attempt", leadId: lead.leadId, channel: "call", outcome: "RNR", note: "Master E2E synthetic lead" });
      const connected = await act("connected", "Mandatory RNR", "Connected", { action: "log_attempt", leadId: lead.leadId, channel: "call", outcome: "Connected", note: "Master E2E synthetic lead" });
      out.staff.work = { rotate, rnr, connected };
      for (const [name, r] of [["Rotate day (stage day_1 -> day_2)", rotate], ["Log RNR call", rnr], ["Connected", connected]]) rec("L1 Lead worked in Revenue & CX engine", `${name} via ${r.via}`, r.status === 200 ? (r.via === "ui" ? "PASS" : "PARTIAL") : "FAIL", { status: r.status, body: r.body }, [r.shot]);
      rec("L1 Lead worked in Revenue & CX engine", "Queue WhatsApp attempt", "SKIPPED", "not pressed: it queues a WhatsApp to the lead's number (synthetic numbers may be real)");
      if (rotate.status === 409) finding({ suite: SUITE, severity: "P2", area: "CRM - lead governance", persona: "Sales staff", flow: "Revenue & CX engine > Rotate day", title: "'Rotate day' is refused for a new lead (409): lead assignment/SLA governance has no active policy", steps: `Rotate day on ${lead.leadId}`, expected: "lead moves to work day 2 with a governed owner and SLA", actual: rotate.body, evidence: [rotate.shot] });
      // Follow-up: a callback (API only: no screen offers it), completed straight away so no reminder is left behind.
      const cb = await api(creator.context, "POST", "/api/revenue-crm", { action: "schedule_callback", leadId: lead.leadId, requestedAt: Date.now() + 2 * 3600_000, reason: "Master E2E follow-up (synthetic)" });
      const cbId = cb.body?.callback?.id || cb.body?.callback?.callbackId || cb.body?.callback?.callback?.id || null;
      const cbDone = cbId ? await api(creator.context, "POST", "/api/revenue-crm", { action: "complete_callback", callbackId: cbId, outcome: "connected" }) : null;
      rec("L1 Follow-up and assignment", "callback scheduled + completed (API; no UI control)", cb.status === 200 && cbDone?.status === 200 ? "PARTIAL" : "FAIL", { schedule: cb.status, callbackId: cbId, complete: cbDone?.status ?? null, body: clip(cb.body, 200) });
      // Assignment.
      const dir = await api(creator.context, "GET", "/api/lead-assignment-governance");
      const assign = await api(creator.context, "POST", "/api/lead-assignment-governance", { action: "assign", leadId: lead.leadId, idempotencyKey: `m50-assign-${lead.leadId}`, reason: "new_lead" });
      const policies = dir.body?.directory?.policies;
      out.staff.assignment = { owner: lead.owner, ownerResolved: lead.ownerResolved, directory: dir.status, activePolicies: Array.isArray(policies) ? policies.filter((p) => p.status === "active").length : null, assign: assign.status, body: clip(assign.body, 300) };
      rec("L1 Follow-up and assignment", "owner at creation + governed assign", lead.ownerResolved && assign.status === 200 ? "PASS" : lead.ownerResolved ? "PARTIAL" : "FAIL", out.staff.assignment);
      if (assign.status === 409 && rotate.status !== 409) finding({ suite: SUITE, severity: "P2", area: "CRM - lead governance", persona: "Sales manager", flow: "lead assignment governance", title: "A new lead cannot be assigned through lead assignment governance (409)", steps: `POST /api/lead-assignment-governance assign ${lead.leadId}`, expected: "assignment created", actual: out.staff.assignment.body, evidence: [] });
    } catch (e) { fail("L1 Lead worked in Revenue & CX engine", "Boarding lead", e); }

    // ---------------------------------------------------------------- L1 managers see the leads
    for (const email of [STAFF.manager, STAFF.salesManager]) {
      try {
        const m = await staffFlow(browser, `50-staff-view-${email.split("@")[0]}`, email);
        const lead = leads.boarding || leads.sitting || leads.taxi;
        if (!lead) throw new Error("no lead created");
        await openCrm(m);
        const s = await searchCrm(m, lead.phone, "manager-crm-search");
        const c360 = await api(m.context, "GET", `/api/customer-360?customerId=${encodeURIComponent(lead.id)}`);
        const inC360 = (c360.body?.data?.records || []).some((x) => x.customerId === lead.id);
        const sees = s.status === 200 && s.contacts.some((c) => c.id === lead.id);
        out.staff[`manager_${email}`] = { crm: s.status, error: s.status === 200 ? null : clip(s.text.match(/[^.]*(scope|denied|Permission)[^.]*/i)?.[0] || "", 160), sees, customer360: c360.status, inC360 };
        rec("L1 Manager sees the lead", email, sees ? "PASS" : inC360 ? "PARTIAL" : "FAIL", out.staff[`manager_${email}`], [s.shot]);
        if (!sees && email === STAFF.salesManager && s.status === 200) finding({ suite: SUITE, severity: "P1", area: "CRM - visibility", persona: "Sales manager", flow: "/crm search", title: "The sales manager cannot find a new lead in the CRM", steps: `${email}: /crm search ${lead.phone}`, expected: `${lead.id} listed`, actual: clip(out.staff[`manager_${email}`], 300), evidence: [s.shot] });
      } catch (e) { fail("L1 Manager sees the lead", email, e); }
    }

    // ---------------------------------------------------------------- L2 staff conversion of each staff-created lead
    for (const svc of SERVICES) {
      const lead = leads[svc.key];
      try {
        if (!lead) throw new Error("lead was not created");
        await openCrm(assoc);
        const s = await searchCrm(assoc, lead.phone, `assoc-crm-${svc.key}`);
        const link = assoc.page.getByRole("link", { name: /Book this customer/ }).first();
        const href = await link.getAttribute("href").catch(() => null);
        const page = await openAssisted(assoc, lead.id);
        const offered = page.services.filter((b) => !/^(Start over|×)$/.test(b));
        const hasService = svc.key === "taxi" ? /PET TAXI · ASSISTED STAFF/.test(page.text) : new RegExp(svc.key === "boarding" ? "boarding" : "sitting", "i").test(offered.join(" "));
        const shot = await assoc.shot(`assisted-${svc.key}`);
        const base = { lead: lead.id, bookLink: href, header: clip(page.text.match(/CRM → CANONICAL ASSISTED ORDER[^\n]{0,30}|GROOMING ONLY/)?.[0] || "", 60), offered: offered.slice(0, 12) };
        if (svc.key !== "taxi") {
          // The documented alternative for Boarding / Pet Sitting: the lead books in the customer app. Their sign-in
          // must land on the lead's customer id for the booking to convert the lead.
          let self = null;
          if (svc.key === "boarding") { self = await otpProbe(idc.context, lead.phone, `Master E2E Lead ${svc.label} ${RUN}`); lead.selfSignIn = self; }
          rec("L2 Staff converts the lead to a booking", svc.label, hasService ? "PASS" : "FAIL", { ...base, selfSignIn: self }, [s.shot, shot]);
          lead.convertible = hasService;
        } else {
          const t = await assistedTaxi(assoc, { pickup: `${ADDRESS.line1}, Bengaluru 560038`, drop: "Koramangala 5th Block, Bengaluru 560095", pincode: "560038", date: isoDay(DAY + 2), time: TAXI_TIME, consentRef: `MASTER-E2E-CALL-${RUN}` });
          lead.assistedTaxi = t;
          const ok = t.booking?.status === 201 && t.booking?.bookingId;
          rec("L2 Staff converts the lead to a booking", `${svc.label} (assisted Taxi panel)`, ok ? "PASS" : "FAIL", { ...base, quote: t.quote, schedule: t.schedule, booking: t.booking, panel: t.panel, error: t.error }, [s.shot, shot, ...t.evidence]);
          if (ok) saveBooking({ suite: SUITE, bookingId: t.booking.bookingId, service: "pet_taxi", providerId: t.schedule?.provider, customer: lead.id, scheduledStart: istIso(isoDay(DAY + 2), TAXI_TIME), total: t.quote.total, dueNow: t.booking.amountDueNow, paid: false, paymentMode: "split_50_50" });
          if (!ok && (t.schedule?.status === 403 || t.booking?.status >= 400)) finding({ suite: SUITE, severity: "P1", area: "CRM - lead conversion (Pet Taxi)", persona: "Sales associate", flow: "/crm > Book this customer > PET TAXI · ASSISTED STAFF", title: `A Pet Taxi lead cannot be booked by staff: the assisted Taxi panel is refused (${t.schedule?.status === 403 ? `scheduler 403 '${t.schedule?.error}'` : `HTTP ${t.booking?.status}`})`, steps: `${STAFF.associate}: /crm search ${lead.phone} > Book this customer > confirm species Dog > Taxi pickup/drop/PIN 560038/${isoDay(DAY + 2)} ${TAXI_TIME} > Calculate Taxi fare > consent > Create payment-pending Taxi`, expected: "a payment-pending Pet Taxi booking for the lead (the #1103 STAFF-01 fix converts the CRM lead first for Grooming)", actual: `${clip(t.schedule, 200)} ${clip(t.booking, 150)} panel: ${t.panel}. The Taxi panel sends pets as canonicalId||sourceId and never converts the CRM lead, so a lead's pet (the CRM pet name) is not a canonical pet and /api/uat-scheduling refuses it.`, evidence: [shot, ...t.evidence] });
        }
      } catch (e) { fail("L2 Staff converts the lead to a booking", svc.label, e); }
    }
    {
      const b = leads.boarding, st = leads.sitting;
      if (b && st && b.convertible === false && st.convertible === false) {
        const self = b.selfSignIn || {};
        finding({ suite: SUITE, severity: "P1", area: "CRM - lead conversion (Boarding, Pet Sitting)", persona: "Sales staff", flow: "/crm > Book this customer", title: "Boarding and Pet Sitting leads cannot be turned into a booking: 'Book this customer →' opens a Grooming-only order page and the lead's own booking would not convert it", steps: `/crm > ${b.id} (Boarding) / ${st.id} (Pet Sitting) > Book this customer →; then the lead's customer OTP sign-in with ${b.phone}`, expected: "staff book the stay (or send a booking link, as for Training), and the booking converts the lead", actual: `/assisted-booking offers Grooming packages and a Pet Taxi panel only (header 'CRM → CANONICAL ASSISTED ORDER · GROOMING'); no Boarding/Pet Sitting option and no booking link on the lead. The self-booking alternative does not reach the lead either: sign-in for ${b.phone} returned customerId ${self.customerId ?? "?"} (existingCustomer=${self.existingCustomer ?? "?"}) instead of ${b.id}, because a staff lead has no canonical customer, so attributeBookingToOpenLead never matches it.`, evidence: [] });
      }
    }

    // ---------------------------------------------------------------- L2 staff-assisted Pet Taxi for the public lead customer + stored contact
    try {
      const cid = leadCustomer.customerId;
      if (!cid) throw new Error("the public lead customer did not sign in");
      await openCrm(assoc);
      const s = await searchCrm(assoc, leadCustomer.phone, "assoc-crm-public-lead");
      const inCrm = s.contacts.some((c) => c.id === cid);
      const before = (await api(lc.context, "GET", "/api/customer-account")).body?.data;
      await openAssisted(assoc, cid);
      const t = await assistedTaxi(assoc, { pickup: `${ADDRESS.line1}, Bengaluru 560038`, drop: "Koramangala 5th Block, Bengaluru 560095", pincode: "560038", date: isoDay(DAY + 1), time: TAXI_TIME, consentRef: `MASTER-E2E-CALL-${RUN}` });
      const bookingId = t.booking?.bookingId || null;
      booked.taxi = { bookingId, fee: t.booking?.amountDueNow, total: t.quote?.total, providerId: t.schedule?.provider };
      rec("L2 Staff-assisted Pet Taxi for the lead customer", `${cid} (public Pet Taxi lead ${leadCustomer.leads["Pet Taxi"]?.leadId || "?"})`, bookingId ? "PASS" : "FAIL", { inCrm, quote: t.quote, schedule: t.schedule, booking: t.booking, panel: t.panel }, [s.shot, ...t.evidence]);
      if (!bookingId) throw new Error(`assisted Taxi not created: ${clip(t, 300)}`);
      saveBooking({ suite: SUITE, bookingId, service: "pet_taxi", providerId: t.schedule?.provider, customer: cid, scheduledStart: istIso(isoDay(DAY + 1), TAXI_TIME), total: t.quote.total, dueNow: t.booking.amountDueNow, paid: false, paymentMode: "split_50_50" });
      // Where did the booking land, and is the customer's stored contact intact?
      const after = (await api(lc.context, "GET", "/api/customer-account")).body?.data;
      const row = await d1("SELECT id,primary_phone,email,source FROM canonical_customers WHERE id=?", [cid]);
      const stored = Array.isArray(row) ? row[0] : null;
      // The customer pays the booking fee in her current session first: a fresh sign-in below may not reach this account.
      const pay = await payFromBookingPage(lc, bookingId, { complete: PAY });
      const captured = pay.status?.paymentStatus === "captured";
      booked.taxi.paid = captured;
      if (captured) saveBooking({ suite: SUITE, bookingId, service: "pet_taxi", providerId: t.schedule?.provider, customer: cid, scheduledStart: istIso(isoDay(DAY + 1), TAXI_TIME), total: t.quote.total, dueNow: t.booking.amountDueNow, paid: true, paymentMode: "split_50_50" });
      rec("L2 Staff-assisted Pet Taxi for the lead customer", `customer pays the ₹${t.booking.amountDueNow} booking fee`, captured ? "PASS" : (pay.skippedPayment && pay.opened ? "PARTIAL" : pay.opened ? "FAIL" : "BLOCKED"), { bookingId, payment: pay.status || pay.reason }, pay.evidence);
      // A fresh customer sign-in with her number must still reach the same account.
      const relogin = await otpProbe(lc.context, leadCustomer.phone, leadCustomer.name);
      const contact = { phoneBefore: before?.primaryPhone, phoneAfter: after?.primaryPhone, emailBefore: before?.email, emailAfter: after?.email, bookingOnCustomer: (after?.bookings || []).some((b) => b.id === bookingId), d1: stored || row, relogin };
      out.staff.taxiContact = contact;
      const corrupted = masked(contact.phoneAfter) || masked(contact.emailAfter) || masked(stored?.primary_phone) || masked(stored?.email);
      const lostAccount = relogin.verifyStatus !== 200 || relogin.customerId !== cid;
      rec("L2 Staff-assisted Pet Taxi for the lead customer", "booking on the canonical customer with the stored (unmasked) contact", !corrupted && !lostAccount && contact.bookingOnCustomer ? "PASS" : "FAIL", contact);
      if (corrupted || lostAccount) finding({ suite: SUITE, severity: lostAccount ? "P0" : "P1", area: "CRM - assisted Pet Taxi / customer identity", persona: "Sales associate -> Customer", flow: "/assisted-booking PET TAXI · ASSISTED STAFF", title: lostAccount ? "A staff-assisted Pet Taxi overwrites the customer's stored phone with the masked copy; her next sign-in no longer reaches her account and bookings" : "A staff-assisted Pet Taxi overwrites the customer's stored contact with the masked copy shown to staff", steps: `Customer ${cid} (${leadCustomer.phone}) has a pet and address; ${STAFF.associate} books a payment-pending Taxi for them from /assisted-booking?customerId=${cid}; then the customer's account and a fresh customer OTP sign-in`, expected: "booking on the customer with the stored contact; phone unchanged; sign-in still resolves to the same customer", actual: `booking ${bookingId}; phone before '${contact.phoneBefore}', after '${contact.phoneAfter}'; email before '${contact.emailBefore}', after '${contact.emailAfter}'; D1 ${clip(stored || row, 160)}; fresh sign-in ${clip(relogin, 200)}. The panel submits the Customer 360 copy (masked '+91 ••••••1234' / '•••@domain' for every role) and /api/taxi-ride-bookings upserts canonical_customers ON CONFLICT DO UPDATE primary_phone/email with it; sign-in matches primary_phone exactly (lib/customer-otp.ts). The Grooming path looks the stored contact up (#1103 STAFF-01), the Taxi path does not.`, evidence: t.evidence });
    } catch (e) { fail("L2 Staff-assisted Pet Taxi for the lead customer", leadCustomer.customerId || "lead customer", e); }

    // ---------------------------------------------------------------- lead state after the bookings (D1 read-back)
    try {
      const ids = [...SERVICES.map((s) => leads[s.key]?.leadId), leadCustomer.leads.Boarding?.leadId, leadCustomer.leads["Pet Taxi"]?.leadId, chat.boarding.leadId, chat.call.leadId].filter(Boolean);
      out.d1.leads = ids.length ? await d1(`SELECT id,customer_id,service,owner,status,stage,lifecycle_state,call_attempts,converted_booking_id,initiated_booking_id FROM lead_work_items WHERE id IN (${ids.map(() => "?").join(",")})`, ids) : [];
      const bIds = [booked.boarding?.bookingId, booked.taxi?.bookingId].filter(Boolean);
      out.d1.attribution = bIds.length ? await d1(`SELECT booking_id,attribution_type,lead_id FROM booking_attribution WHERE booking_id IN (${bIds.map(() => "?").join(",")})`, bIds) : [];
      if (Array.isArray(out.d1.leads)) {
        for (const [service, booking] of [["Boarding", booked.boarding], ["Pet Taxi", booked.taxi]]) {
          const leadId = leadCustomer.leads[service]?.leadId, row = out.d1.leads.find((l) => l.id === leadId);
          if (!booking?.bookingId || !row) continue;
          const attr = (out.d1.attribution || []).find((a) => a.booking_id === booking.bookingId);
          const converted = row.converted_booking_id === booking.bookingId;
          const linked = converted || row.initiated_booking_id === booking.bookingId;
          rec("L2 Booking converts the lead", `${service} lead ${leadId} <- ${booking.bookingId}${booking.paid ? " (paid)" : ""}`, (booking.paid ? converted : linked) ? "PASS" : "FAIL", { lead: row, attribution: attr || null });
          if (booking.paid && !converted) finding({ suite: SUITE, severity: "P1", area: "CRM - lead conversion", persona: "Sales staff", flow: `${service} lead -> paid booking`, title: `A paid ${service} booking by the lead's own customer did not convert the lead`, steps: `Lead ${leadId} (customer ${leadCustomer.customerId}); booking ${booking.bookingId} paid in Razorpay TEST`, expected: "lead_work_items.converted_booking_id set, lifecycle converted", actual: clip({ row, attr }, 400), evidence: [] });
        }
      } else rec("L2 Booking converts the lead", "D1 read-back", "SKIPPED", `not checked: ${clip(out.d1.leads, 160)}`);
    } catch (e) { fail("L2 Booking converts the lead", "D1 read-back", e); }

    // ---------------------------------------------------------------- L3 relocation enquiry for staff
    try {
      const rel = out.public.relocation;
      if (!rel?.id) throw new Error("no relocation enquiry was submitted in this run");
      const r = await assoc.page.goto(`${BASE}/team/relocation-enquiries`, { waitUntil: "domcontentloaded" }); await settle(assoc.page, 3000);
      const text = await mainText(assoc.page, 20_000), shot = await assoc.shot("relocation-enquiries");
      const listed = text.includes(rel.id), fullPhone = listed && text.includes(rel.phone);
      rec("L3 Relocation enquiry visible to staff", `${rel.id} · ${STAFF.associate}`, listed ? "PASS" : "FAIL", { page: r?.status(), listed, shownIntl: /Intl/.test(text), fullPhoneShown: fullPhone }, [shot]);
      if (!listed) finding({ suite: SUITE, severity: "P1", area: "Leads - relocation enquiry", persona: "Sales associate", flow: "/team/relocation-enquiries", title: "A submitted relocation enquiry does not appear for staff", steps: `Submit ${rel.id}, open /team/relocation-enquiries`, expected: "listed newest first", actual: clip(text, 300), evidence: [shot] });
      if (fullPhone) finding({ suite: SUITE, severity: "P3", area: "Privacy - masking consistency", persona: "Sales associate", flow: "/team/relocation-enquiries", title: "Relocation enquiries show the full phone number and email to every customers.view role while the CRM masks them", steps: `${STAFF.associate}: /team/relocation-enquiries`, expected: "masked contact with an audited reveal, as in /crm and Customer 360", actual: `${rel.id} shows ${rel.phone} in full`, evidence: [shot] });
    } catch (e) { fail("L3 Relocation enquiry visible to staff", "staff list", e); }

    // ---------------------------------------------------------------- L4 staff side of the web chat leads
    try {
      if (!creator) throw new Error("no creator session");
      const conv = await api(assoc.context, "GET", "/api/conversations");
      const queue = await api(assoc.context, "GET", "/api/ai-human-handoff?mode=queue");
      for (const kind of ["boarding", "call"]) {
        const c = chat[kind];
        if (!c.leadId) { rec("L4 Web chat leads visible to staff", kind, "BLOCKED", "harness: no chat lead in this run"); continue; }
        await openCrm(creator);
        const s = await searchCrm(creator, c.phone.slice(-10), `chat-lead-${kind}`);
        const contact = s.contacts[0] || null;
        const inInbox = JSON.stringify(conv.body || "").includes(c.phone.slice(-4)) || JSON.stringify(queue.body || "").includes(c.leadId);
        const ownership = await d1("SELECT status,human_owner,escalation_reason FROM ai_lead_ownership WHERE lead_id=?", [c.leadId]);
        const info = { crm: s.status, found: Boolean(contact), contactId: contact?.id, owner: contact?.owner, stage: contact?.stage, next: contact?.next_action, source: contact?.source, inInboxOrHandoffQueue: inInbox, aiOwnership: ownership };
        chat[kind].staff = info;
        const human = contact && !/AI Orchestrator/i.test(String(contact.owner || ""));
        rec("L4 Web chat leads visible to staff", kind === "call" ? "Request a call" : "Boarding enquiry", contact ? (human ? "PASS" : "FAIL") : "FAIL", info, [s.shot]);
        if (!contact) finding({ suite: SUITE, severity: "P1", area: "Leads - web chat", persona: "Sales staff", flow: "/v2/chat -> CRM", title: `A web chat ${kind === "call" ? "call request" : "Boarding enquiry"} is not in the CRM`, steps: `Finish the chat with ${c.phone}; /crm search`, expected: "a CRM lead", actual: clip(info, 300), evidence: [s.shot] });
        else if (!human) finding({ suite: SUITE, severity: kind === "call" ? "P1" : "P2", area: "Leads - web chat routing", persona: "Visitor -> Sales staff", flow: kind === "call" ? "/v2/chat 'Request a call'" : "/v2/chat Boarding enquiry", title: kind === "call" ? "A signed-out visitor's 'Request a call' is promised a call from the team but the lead stays owned by 'AI Orchestrator' with no human queue" : "A web chat Boarding enquiry that chose 'No, call me instead' stays owned by 'AI Orchestrator', so no person is tasked to call", steps: `/v2/chat signed out > ${kind === "call" ? "Request a call > name > phone" : "Boarding > … > check-in/out"} > 'No, call me instead'; /crm search ${c.phone}`, expected: "a human owner / team queue and first-response task (the visitor declined WhatsApp and the AI may not dial an anonymous number)", actual: `Customer saw: '${clip(c.closing, 160)}'. CRM: owner '${contact.owner}', next action '${contact.next_action}'; not in the Inbox/handoff queue; ai_lead_ownership ${clip(ownership, 120)}. The finished 'Talk to our team' flow carries no followUp, so app/api/ai-web-chat never calls routeLeadToTeamQueue.`, evidence: [s.shot] });
      }
    } catch (e) { fail("L4 Web chat leads visible to staff", "CRM", e); }

    // ---------------------------------------------------------------- L5 Customer 360 of the converted lead
    try {
      const cid = leadCustomer.customerId;
      if (!cid) throw new Error("no converted lead customer");
      const f = creatorEmail === STAFF.founder ? creator : await staffFlow(browser, "50-staff-founder-360", STAFF.founder);
      const r = await api(f.context, "GET", `/api/customer-360?customerId=${encodeURIComponent(cid)}`);
      const rec360 = (r.body?.data?.records || []).find((x) => x.customerId === cid);
      const ours = [booked.boarding?.bookingId, booked.taxi?.bookingId].filter(Boolean);
      const shownBookings = (rec360?.bookings || []).filter((b) => ours.includes(b.id)).map((b) => `${b.id}:${b.serviceCode}:${b.status}:₹${b.totalAmount}`);
      const paymentFields = rec360 ? /payment|captured|paid|due/i.test(JSON.stringify(rec360.bookings || [])) : false;
      await f.page.goto(`${BASE}/team/sales`, { waitUntil: "domcontentloaded" }); await settle(f.page, 4000);
      await f.page.getByPlaceholder("Filter by name, phone, stage or owner").fill(leadCustomer.name).catch(() => {});
      await f.page.locator("button").filter({ hasText: leadCustomer.name }).first().click().catch(() => {});
      await settle(f.page, 1500);
      const ui = await mainText(f.page, 6000), shot = await f.shot("customer-360-lead");
      const uiListsBookings = ours.length > 0 && ours.every((id) => ui.includes(id));
      const paidTotal = [booked.boarding, booked.taxi].filter((b) => b?.paid).reduce((s, b) => s + Number(b.dueNow ?? b.fee ?? 0), 0);
      out.staff.c360 = { status: r.status, bookings: shownBookings, lifetimeValue: rec360?.lifetimeValue, paymentFields, uiListsBookings, uiStats: clip(ui.match(/Pets[\s\S]{0,120}/)?.[0] || "", 160), paidTotal };
      rec("L5 Customer 360 of the converted lead", cid, shownBookings.length === ours.length && ours.length && paymentFields && uiListsBookings ? "PASS" : shownBookings.length ? "PARTIAL" : "FAIL", out.staff.c360, [shot]);
      if (rec360 && (!paymentFields || !uiListsBookings)) finding({ suite: SUITE, severity: "P2", area: "CRM - Customer 360", persona: "Sales staff", flow: "/team/sales Customer 360", title: "Customer 360 of a converted lead shows booking counts only: no booking list in the screen and no payment state (paid / due / refunded)", steps: `Founder: /team/sales > ${leadCustomer.name}; GET /api/customer-360?customerId=${cid}`, expected: "the lead's bookings with what was paid and what is due", actual: `API bookings ${clip(shownBookings, 200)} carry status/total only; lifetimeValue ₹${rec360.lifetimeValue} vs ₹${paidTotal} actually paid; screen: ${out.staff.c360.uiStats}`, evidence: [shot] });
    } catch (e) { fail("L5 Customer 360 of the converted lead", leadCustomer.customerId || "lead customer", e); }
  }

  // ======================================================================================= flow hygiene: 5xx and page errors
  for (const f of flows) {
    const p = flowProblems(f, { allow: [/\/api\/customer-otp .* 500/] });
    if (!p.fiveXX.length && !p.pageErrors.length) continue;
    const moneyPath = p.fiveXX.some((x) => /checkout|booking|scheduling|payment|taxi-ride/.test(x.url));
    rec("Flow hygiene (5xx / page errors)", f.name, "FAIL", { fiveXX: p.fiveXX.slice(0, 4), pageErrors: p.pageErrors.slice(0, 3) });
    finding({ suite: SUITE, severity: p.fiveXX.length && moneyPath ? "P1" : "P2", area: "Frontend / API robustness", persona: "Customer or staff", flow: f.name, title: `${p.fiveXX.length} unexpected 5xx and ${p.pageErrors.length} uncaught page error(s) during ${f.name}`, steps: `See ${f.name} log.json`, expected: "no 5xx, no uncaught errors", actual: clip({ fiveXX: p.fiveXX.slice(0, 3), pageErrors: p.pageErrors.slice(0, 2) }, 500), evidence: [] });
  }
} catch (error) {
  rec("suite", "harness", "BLOCKED", `harness: ${String(error?.message || error).slice(0, 300)}`);
} finally {
  out.booked = booked;
  writeJson("leads-crm.json", out);
  for (const f of flows) await f.close().catch(() => {});
  await browser.close().catch(() => {});
}
