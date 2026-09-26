// Master E2E — AI on staging: does PawSpace AI answer through the real provider (not the canned directory)?
// Public chat (anonymous) and My PawSpace chat (run-scoped OTP customer), through the API and the /v2/chat screen.
// Read-only apart from the chat turns themselves; never touches the AI kill switch or rollout stage.
import { mkdirSync } from "node:fs";
import { BASE, OUT, launch, newFlow, settle, customerSession, dismissCookies, api, record, finding, writeJson, d1, runPhone } from "../lib.mjs";

const SUITE = "07-ai-probe";
mkdirSync(OUT, { recursive: true });
const out = { suite: SUITE, public: [], customer: [], d1: {} };
const turnOf = (body) => body?.data?.ai?.turn || body?.data?.turn || null;
const summary = (r) => { const t = turnOf(r.body); return { status: r.status, providerConnected: r.body?.data?.ai?.providerConnected ?? null, provider: t?.provider ?? null, modelRef: t?.modelRef ?? null, outcome: t?.outcome ?? null, handoffReason: t?.handoffReason ?? null, output: String(t?.output ?? r.body?.data?.reply ?? r.body?.error ?? "").slice(0, 400) }; };

const browser = await launch();
try {
  // 1. Public chat through the API: one directory-style question, two open questions that need a model.
  const pub = await newFlow(browser, "07-ai-public");
  try {
    const sessionKey = `master-ai-${runPhone(7)}`;
    const questions = [
      "What is included in PawSpace boarding?",
      "My indie dog gets anxious during thunderstorms. What should I tell the boarding host before a 3-night stay?",
      "Can a senior cat with kidney issues be boarded, and what should I pack?",
    ];
    const history = [];
    for (const q of questions) {
      const r = await api(pub.context, "POST", "/api/ai-web-chat", { mode: "public", query: q, history, sessionKey }, { timeout: 60_000 });
      const s = summary(r);
      out.public.push({ q, ...s });
      history.push({ role: "user", text: q }, { role: "assistant", text: s.output });
      const modelAnswered = s.status === 200 && s.providerConnected === true && s.outcome === "reply_ready";
      record({ suite: SUITE, journey: "PawSpace AI public chat (API)", combo: q.slice(0, 70), result: modelAnswered ? "PASS" : (s.status === 200 && s.provider === "canonical_service_directory" ? "PARTIAL" : "FAIL"), detail: JSON.stringify(s), evidence: [] });
    }
    const open = out.public.slice(1), missed = open.filter(s => s.providerConnected !== true);
    if (missed.length) finding({ suite: SUITE, severity: missed.length === open.length ? "P1" : "P2", area: "AI", persona: "Public visitor", flow: "PawSpace AI public chat", title: `${missed.length} of ${open.length} open questions did not reach the model provider on staging`, steps: "POST /api/ai-web-chat {mode:'public', query} with two open pet-care questions", expected: "providerConnected=true, outcome reply_ready, a model-written answer", actual: JSON.stringify(missed.map(s => ({ q: s.q.slice(0, 60), provider: s.provider, outcome: s.outcome, handoffReason: s.handoffReason }))), evidence: [] });

    // Same questions through the screen a visitor uses.
    await pub.page.goto(`${BASE}/v2/chat`, { waitUntil: "domcontentloaded" });
    await dismissCookies(pub.page); await settle(pub.page, 1500);
    const shots = [await pub.shot("public-chat-open")];
    const box = pub.page.locator("textarea, input[type='text']").last();
    if (await box.isVisible().catch(() => false)) {
      await box.fill(questions[1]);
      await box.press("Enter").catch(() => {});
      const send = pub.page.getByRole("button", { name: /send/i }).first();
      if (await send.isVisible().catch(() => false) && await send.isEnabled().catch(() => false)) await send.click().catch(() => {});
      await settle(pub.page, 12_000);
      shots.push(await pub.shot("public-chat-answer"));
      record({ suite: SUITE, journey: "PawSpace AI public chat (screen)", combo: "open pet-care question", result: "PASS", detail: "screen captured; see API rows for provider status", evidence: shots });
    } else record({ suite: SUITE, journey: "PawSpace AI public chat (screen)", combo: "open pet-care question", result: "BLOCKED", detail: "harness: no chat input found on /v2/chat", evidence: shots });
  } catch (e) { record({ suite: SUITE, journey: "PawSpace AI public chat", combo: "all", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await pub.close();

  // 2. Signed-in customer chat (My PawSpace).
  const cus = await newFlow(browser, "07-ai-customer");
  try {
    const account = await customerSession(cus.context, "customer-a");
    const q = "Which of my bookings are coming up, and what do I still need to pay?";
    const r = await api(cus.context, "POST", "/api/ai-web-chat", { mode: "authenticated", customerId: account.customerId, message: q, idempotencyKey: `master-ai-cus-${runPhone(7)}` }, { timeout: 60_000 });
    const s = summary(r);
    out.customer.push({ q, ...s, raw: JSON.stringify(r.body).slice(0, 800) });
    record({ suite: SUITE, journey: "PawSpace AI My PawSpace chat (API)", combo: "upcoming bookings / dues", result: r.status < 300 ? (s.providerConnected === true ? "PASS" : "PARTIAL") : "FAIL", detail: JSON.stringify(s), evidence: [] });
  } catch (e) { record({ suite: SUITE, journey: "PawSpace AI My PawSpace chat", combo: "upcoming bookings", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }
  await cus.close();

  // 3. What the AI log says about the last day of turns on staging (read-only).
  out.d1.outcomes = await d1("SELECT json_extract(detail_json,'$.outcome') AS outcome, json_extract(detail_json,'$.provider') AS provider, COUNT(*) AS n, MAX(created_at) AS last FROM ai_web_chat_events WHERE created_at > ? GROUP BY 1,2 ORDER BY n DESC", [Date.now() - 86_400_000]).catch(e => ({ error: String(e?.message || e) }));
} finally {
  writeJson("ai-probe.json", out);
  await browser.close();
}
