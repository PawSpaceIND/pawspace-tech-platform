/*
 * Dog Training trainer availability check against the deployed staging origin. READ-ONLY.
 *
 * Answers one question before human UAT: when a tester opens /v2/training, is a trainer offered? It never
 * reserves, never pays and never changes a trainer, a policy or a booking. It signs in a new customer with the
 * sandbox OTP shown on screen (as the master suite does), saves an East Bengaluru address (560038) and one
 * vaccinated dog, then:
 *   1. drives /v2/training with the choices from the tester's report (Basic Obedience Plan, 8 sessions from
 *      12 Oct 2026 10:00 IST every 4 days) and records the trainers on screen, with a screenshot;
 *   2. asks the same availability preview the page uses (POST /api/uat-scheduling action=preview, which holds
 *      nothing) for a matrix of start dates, times and frequencies, and intersects it with the eligible roster
 *      (/api/training-trainers), exactly as the page does.
 * It needs no secret. Every time in the report is IST.
 */
import { test, devices, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
const OUT = process.env.TRAINER_CHECK_OUT || "test-results/training-trainer-check";
const SHOTS = `${OUT}/shots`;
const DAY = 86_400_000;
const IST_MS = 330 * 60_000;
/** The city-wide UAT team trainer seats all start with this name. */
const TEAM = "PawSpace Training Team";
mkdirSync(SHOTS, { recursive: true });

const lines: string[] = [];
const say = (line = "") => { lines.push(line); console.log(`[trainer-check] ${line}`); };
function flush() { writeFileSync(`${OUT}/report.md`, lines.join("\n") + "\n"); }
/** "Sat 26 Sep 2026, 22:58 IST" for an instant. */
const ist = (value: number | string) => `${new Date(typeof value === "number" ? value : Date.parse(value)).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} IST`;
/** IST calendar date N days from today. */
const istDay = (offset: number) => new Date(Date.now() + IST_MS + offset * DAY).toISOString().slice(0, 10);

async function settle(page: Page, ms = 1200) { await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {}); await page.waitForTimeout(ms); }
async function api(page: Page, path: string, init: { method?: string; body?: unknown } = {}) {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { method: init.method || "GET", credentials: "include", headers: { "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    let body: unknown = null; try { body = await response.json(); } catch { /* not json */ }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schemaless API bodies at the external test boundary
    return { status: response.status, body: body as Record<string, any> | null };
  }, { path, init });
}
test("Dog Training: a tester on staging is offered a trainer", async ({ browser }) => {
  test.setTimeout(30 * 60_000);
  say("# Staging check: can a tester select a Dog Training trainer?");
  say("");
  say(`- Origin: ${BASE}`);
  say(`- Started: ${ist(Date.now())}`);
  say("- Read-only: nothing is reserved, paid or changed. Times are IST.");
  const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: BASE, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  const page = await context.newPage();
  try {
    // ---------------------------------------------------------------- customer (sandbox OTP, as a tester would)
    const phone = `8${String(Date.now()).slice(-9)}`;
    await page.goto("/mobile-app"); await settle(page);
    const account = page.locator("nav").getByRole("button", { name: /account/i }).last();
    if (await account.isVisible().catch(() => false)) await account.click();
    await page.getByPlaceholder("10-digit phone number").fill(phone);
    await page.getByRole("button", { name: "Send OTP" }).click();
    const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
    await sandbox.waitFor({ timeout: 30_000 });
    const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1] || "";
    await page.getByPlaceholder("6-digit code").fill(code);
    const nameBox = page.getByPlaceholder("Your name (first time only)");
    if (await nameBox.isVisible().catch(() => false)) await nameBox.fill("Trainer Check");
    await page.getByRole("button", { name: "Verify & continue" }).click();
    let signedIn = false;
    for (let i = 0; i < 40 && !signedIn; i++) { signedIn = (await api(page, "/api/identity-session")).status === 200; if (!signedIn) await page.waitForTimeout(500); }
    if (!signedIn) throw new Error("the customer session was not established after the sandbox OTP");
    const address = await api(page, "/api/customer-account", { method: "POST", body: { action: "upsert_address", idempotencyKey: `trainer-check-addr:${phone}`, address: { label: "Home", line1: "42 Indiranagar Double Road", area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true } } });
    const pet = await api(page, "/api/customer-account", { method: "POST", body: { action: "upsert_pet", idempotencyKey: `trainer-check-pet:${phone}`, pet: { name: "Bruno", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "verified" } } });
    if (address.status > 201 || pet.status > 201) throw new Error(`account setup: address ${address.status}, dog ${pet.status}`);
    const customerId = String((await api(page, "/api/identity-session")).body?.data?.subjectId || "");
    const record = await api(page, "/api/customer-account");
    const petIds = ((record.body?.data?.pets || []) as Array<{ id: string; species: string }>).filter(item => item.species === "dog").map(item => item.id);
    say(`- Test customer: ${phone} (new, sandbox OTP) · address 560038 Indiranagar · 1 vaccinated dog`);
    say("");
    flush();

    // ---------------------------------------------------------------- 1. the tester's own choices, on screen
    say("## 1. The reported case on /v2/training");
    say("");
    say("Basic Obedience Plan · 1 dog · first session 12 Oct 2026, 10:00 IST · every 4 days");
    // Every quote, roster and availability call the page makes, with its outcome and duration, so a
    // "No available trainer" can be told apart from a call that ran out of time.
    const calls: string[] = [];
    const watched = /\/api\/(training-commercial|training-trainers|uat-scheduling)\b/;
    const started = new WeakMap<object, number>();
    page.on("request", request => { if (watched.test(request.url())) started.set(request, Date.now()); });
    const logCall = (request: { url(): string; method(): string }, outcome: string) => {
      const began = started.get(request);
      calls.push(`${request.method()} ${new URL(request.url()).pathname} → ${outcome}${began ? ` in ${((Date.now() - began) / 1000).toFixed(1)} s` : ""}`);
    };
    page.on("requestfinished", async request => { if (watched.test(request.url())) logCall(request, `HTTP ${(await request.response())?.status() ?? "?"}`); });
    page.on("requestfailed", request => { if (watched.test(request.url())) logCall(request, `failed (${request.failure()?.errorText || "aborted"})`); });
    await page.goto("/v2/training"); await settle(page, 2500);
    const dogs = page.getByRole("group", { name: /Dogs/ });
    const bruno = dogs.getByRole("button", { name: /^Bruno/ }).first();
    await bruno.waitFor({ timeout: 30_000 });
    if ((await bruno.getAttribute("aria-pressed")) !== "true") await bruno.click();
    await page.getByRole("button", { name: /^Basic Obedience Plan/ }).first().click();
    // "Days between sessions" is the page's first select, as the master suite relies on.
    await page.locator("select").first().selectOption("4");
    await page.getByLabel("First session time (IST)").fill("10:00");
    // The page re-checks availability after every change; only the preview for the final selection counts.
    const reportedStart = Date.parse("2026-10-12T10:00:00+05:30");
    const previewFor = () => page.waitForResponse(response => {
      if (!response.url().includes("/api/uat-scheduling") || response.request().method() !== "POST") return false;
      try { const sent = JSON.parse(response.request().postData() || "{}"); return sent.action === "preview" && Date.parse(sent.scheduledStart) === reportedStart && Number(sent.cadenceDays) === 4 && Number(sent.occurrences) === 8; } catch { return false; }
    }, { timeout: 150_000 }).then(response => response.status()).catch(() => 0);
    const finalPreview = previewFor();
    await page.getByLabel("First session date").fill("2026-10-12");
    let previewStatus = await finalPreview;
    const section = page.locator("section").filter({ hasText: "3. Available trainer" }).first();
    async function readTrainers() {
      let text = "";
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        text = (await section.innerText().catch(() => "")).replace(/\n+/g, " · ");
        if (!/Checking availability/i.test(text)) return { names: (await section.getByRole("button").filter({ hasText: /★/ }).allInnerTexts()).map(item => item.split("\n")[0].trim()), text };
        await page.waitForTimeout(800);
      }
      return { names: [] as string[], text };
    }
    let { names: onScreen, text: screenText } = await readTrainers();
    const topAlert = async () => (await page.locator("main > p[role='alert']").first().innerText().catch(() => "")).trim();
    const firstAlert = await topAlert();
    let retry = "";
    if (!onScreen.length) {
      // A tester's next move: tap "Refresh trainer availability" once.
      await page.screenshot({ path: `${SHOTS}/00-v2-training-first-attempt.jpg`, type: "jpeg", quality: 70 }).catch(() => {});
      const again = previewFor();
      await section.getByRole("button", { name: "Refresh trainer availability" }).click().catch(() => {});
      previewStatus = await again;
      ({ names: onScreen, text: screenText } = await readTrainers());
      retry = `First attempt: no trainer${firstAlert ? ` and the page said "${firstAlert}"` : ""}. After one "Refresh trainer availability": ${onScreen.length ? onScreen.join(", ") : "still no trainer"}${await topAlert() ? ` (page said "${await topAlert()}")` : ""}.`;
    }
    if (!onScreen.length) screenText = `${screenText} || page: ${(await page.locator("main").first().innerText().catch(() => "")).replace(/\n+/g, " · ").slice(0, 600)}`;
    if (onScreen.length) {
      await section.getByRole("button").filter({ hasText: TEAM }).first().click().catch(() => {});
      await page.waitForTimeout(600);
    }
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: `${SHOTS}/01-v2-training-reported-case.jpg`, type: "jpeg", quality: 70 }).catch(() => {});
    await page.screenshot({ path: `${SHOTS}/02-v2-training-reported-case-full.jpg`, type: "jpeg", quality: 60, fullPage: true }).catch(() => {});
    const calendar = (await page.locator("section[aria-label='Proposed training calendar'] li").allInnerTexts().catch(() => [])).map(text => text.trim());
    const reserveEnabled = await page.getByRole("button", { name: /Reserve trainer/ }).isEnabled().catch(() => false);
    say("");
    say(onScreen.length ? `**Result: ${onScreen.length} trainer(s) offered: ${onScreen.join(", ")}.** "Reserve trainer & continue to payment" is ${reserveEnabled ? "enabled" : "disabled"} with ${onScreen.find(name => name.startsWith(TEAM)) || "the first trainer"} selected (availability preview HTTP ${previewStatus}).` : `**Result: no trainer offered** (availability preview HTTP ${previewStatus}). Screen: ${screenText.slice(0, 900)}`);
    say("");
    if (retry) { say(retry); say(""); }
    if (calendar.length) { say("Calendar shown:"); for (const item of calendar) say(`- ${item}`); say(""); }
    say("Calls the page made (quote, roster, availability):");
    for (const call of calls) say(`- ${call}`);
    say("");
    say(`Screenshots: ${retry ? "shots/00-v2-training-first-attempt.jpg, " : ""}shots/01-v2-training-reported-case.jpg, shots/02-v2-training-reported-case-full.jpg`);
    say("");
    flush();

    // ---------------------------------------------------------------- 2. availability matrix (preview only)
    say("## 2. Availability preview matrix (East Bengaluru, 1 dog)");
    say("");
    const catalogue = await api(page, "/api/training-commercial");
    const packages = (catalogue.body?.data?.packages || []) as Array<{ package_code: string; name: string; sessions: number; validity_days: number }>;
    const minutesFor = new Map<string, number>();
    for (const code of ["training-8-basic", "training-16-pro"]) {
      const quote = await api(page, "/api/training-commercial", { method: "POST", body: { packageCode: code, petCount: 1, scheduledStart: new Date(Date.now() + 5 * DAY).toISOString(), paymentMode: "split" } });
      minutesFor.set(code, Number(quote.body?.data?.minutesPerSession || 60));
    }
    const rosterCache = new Map<string, Set<string>>();
    async function roster(at: string) {
      const key = at.slice(0, 10);
      if (!rosterCache.has(key)) {
        const listed = await api(page, `/api/training-trainers?cityId=blr&zoneId=blr-east&at=${encodeURIComponent(at)}`);
        rosterCache.set(key, new Set(((listed.body?.data?.providers || []) as Array<{ id: string }>).map(item => item.id)));
      }
      return rosterCache.get(key) as Set<string>;
    }
    type Cell = { plan: string; date: string; time: string; cadence: number; sessions: number; offered: string[]; note: string };
    const cells: Cell[] = [];
    async function preview(code: string, date: string, time: string, cadence: number) {
      const plan = packages.find(item => item.package_code === code);
      const sessions = Number(plan?.sessions || (code === "training-16-pro" ? 16 : 8)), minutes = minutesFor.get(code) || 60;
      const start = new Date(`${date}T${time}:00+05:30`).toISOString();
      const body = { action: "preview", clientRequestId: `trainer-check:${customerId}:${code}:${date}:${time}:${cadence}`, customerId, petIds: petIds.slice(0, 1), serviceCode: "dog_training", cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd: new Date(Date.parse(start) + minutes * 60_000).toISOString(), occurrences: sessions, cadenceDays: cadence };
      const response = await api(page, "/api/uat-scheduling", { method: "POST", body });
      const eligible = await roster(start);
      const providers = (response.body?.data?.providers || []) as Array<{ id: string; name: string }>;
      const offered = providers.filter(item => eligible.has(item.id)).map(item => item.name);
      const note = response.status === 200 ? (providers.length !== offered.length ? `${providers.length - offered.length} not on the roster list` : "") : `HTTP ${response.status} ${String(response.body?.code || response.body?.error || "").slice(0, 120)}`;
      const cell = { plan: plan?.name || code, date, time, cadence, sessions, offered, note };
      cells.push(cell);
      console.log(`[trainer-check] ${cell.plan} ${date} ${time} every ${cadence}d → ${offered.join(", ") || "NONE"} ${note}`);
      return cell;
    }
    const dates = [...new Set([2, 3, 4, 5, 7, 10, 14].map(istDay).concat("2026-10-12"))];
    for (const date of dates) for (const time of ["10:00", "11:00", "15:00"]) for (const cadence of [4, 7]) await preview("training-8-basic", date, time, cadence);
    for (const date of [istDay(3), "2026-10-12"]) await preview("training-16-pro", date, "10:00", 7);
    const none = cells.filter(cell => !cell.offered.length), withTeam = cells.filter(cell => cell.offered.some(name => name.startsWith(TEAM)));
    say(`**${cells.length - none.length} of ${cells.length} programmes had at least one trainer; ${withTeam.length} of ${cells.length} offered a ${TEAM} seat.**`);
    say("");
    say("| Plan | First session (IST) | Every | Sessions | Trainers offered | Note |");
    say("|---|---|---|---|---|---|");
    for (const cell of cells) say(`| ${cell.plan} | ${cell.date} ${cell.time} | ${cell.cadence} days | ${cell.sessions} | ${cell.offered.join(", ") || "**none**"} | ${cell.note} |`);
    say("");
    say(`Finished: ${ist(Date.now())}`);
    flush();
    if (!onScreen.length) throw new Error("No trainer was offered for the reported case on /v2/training");
  } finally {
    flush();
    await context.close().catch(() => {});
  }
});
