/*
 * R3-C / F7 (P2) — callbacks could not be scheduled or completed from any screen.
 *
 * MEASURED: `schedule_callback` and `complete_callback` both work over POST /api/revenue-crm, and the
 * SAME GET the CRM revenue panel already reads serves `dueCallbacks` and `stats.overdueCallbacks`.
 * Grep of app/: nothing rendered either one. /team/sales/power-dialler is a different queue - it
 * writes to the outbound orchestrator, not crm_lead_callbacks - so a customer who asked to be called
 * at six could only be called back through curl.
 *
 * This test drives the REAL panel with the REAL /api/revenue-crm handler behind it over real SQLite:
 * the schedule really writes a lead_callbacks row, the reload really serves it back, and the complete
 * really closes it. Asserting that a tab exists would prove nothing about any of that.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { mount, find, all, screenText } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__R3C_CB_DB__", "__R3C_CB_ENV__");

const { default: RevenueEnginePanel } = await import("../app/crm/revenue-engine-panel.tsx");
const ORIGIN = "https://uat.pawspace.in";
const REP = "rep.sales@pawspace.test";
const LEAD = "LEAD-R3C-CB";
const CUSTOMER = "CU-R3C-CB";

async function world() {
  const harness = freshCountingD1();
  enterWorkersDbScope(harness.db);
  globalThis.__R3C_CB_DB__ = harness.db;
  globalThis.__R3C_CB_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(harness.db);
  const now = Date.now();
  await harness.db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-REP',?,?,'manager','active',?,?)")
    .bind(REP, "Sales Rep", now, now).run();
  // Provision the engine's schema exactly as production does: through its own GET.
  const route = await import("../app/api/revenue-crm/route.ts");
  const warmup = await route.GET(new Request(`${ORIGIN}/api/revenue-crm`, { headers: { "oai-authenticated-user-email": REP } }));
  assert.equal(warmup.status, 200, `the engine must provision its schema: ${(await warmup.clone().text()).slice(0, 300)}`);
  harness.sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?)")
    .run(CUSTOMER, "Divya Sharma", "9845012777", "Leo", "Leo · dog", "New lead", REP, "Website", "Call back", "Grooming", now, now);
  harness.sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,next_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,?,0,0,?,?)")
    .run(LEAD, CUSTOMER, "Website", "grooming", REP, "Sales Manager", now, now + 600000, now + 1800000, now + 600000, now, now);
  return harness;
}

/** The panel's fetches, served by the REAL route. */
function installFetch(calls) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const route = await import("../app/api/revenue-crm/route.ts");
    const headers = { "oai-authenticated-user-email": REP, ...(init?.headers ?? {}) };
    if (init?.method === "POST") {
      calls.push(JSON.parse(String(init.body)));
      return route.POST(new Request(`${ORIGIN}/api/revenue-crm`, { method: "POST", headers, body: init.body }));
    }
    return route.GET(new Request(`${ORIGIN}/api/revenue-crm`, { headers }));
  };
  return () => { globalThis.fetch = previous; };
}

const control = (tree, label) => find(tree, (n) => (n.type === "input" || n.type === "select") && n.props?.["aria-label"] === label);
const button = (tree, text) => find(tree, (n) => n.type === "button" && String(n.props?.children ?? "").includes(text));

test("CB-01: a rep schedules a callback from the CRM screen and it is really recorded", async () => {
  const harness = await world();
  const calls = [];
  const restore = installFetch(calls);
  try {
    const screen = mount(RevenueEnginePanel, { notify: () => {} }, { label: "RevenueEnginePanel" });
    await screen.settle();

    // The tab exists and is reachable, which it was not.
    const tab = button(screen.tree(), "Callbacks");
    assert.ok(tab, `a Callbacks tab must be on screen: ${screenText(screen.html()).slice(0, 300)}`);
    tab.props.onClick();
    await screen.settle();
    assert.match(screenText(screen.html()), /No callback is due in the next two hours/);

    const dueAt = new Date(Date.now() + 30 * 60000);
    const local = `${dueAt.getFullYear()}-${String(dueAt.getMonth() + 1).padStart(2, "0")}-${String(dueAt.getDate()).padStart(2, "0")}T${String(dueAt.getHours()).padStart(2, "0")}:${String(dueAt.getMinutes()).padStart(2, "0")}`;
    control(screen.tree(), "Lead").props.onChange({ target: { value: LEAD } });
    control(screen.tree(), "Callback time").props.onChange({ target: { value: local } });
    control(screen.tree(), "Callback reason").props.onChange({ target: { value: "Customer asked for a call after work at 6pm" } });
    await screen.settle();
    find(screen.tree(), (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
    await screen.settle();

    // THE OUTCOME: a real row, and the lead's own next action moved to the same real time.
    const stored = harness.sqlite.prepare("SELECT lead_id,reason,status,requested_at FROM lead_callbacks").get();
    assert.ok(stored, "a callback row must exist");
    assert.equal(stored.lead_id, LEAD);
    assert.equal(stored.status, "scheduled");
    assert.equal(stored.reason, "Customer asked for a call after work at 6pm");
    assert.equal(harness.sqlite.prepare("SELECT next_action_at n FROM lead_work_items WHERE id=?").get(LEAD).n, stored.requested_at,
      "the lead worklist and the callback queue agree about when this lead is next due");
    assert.equal(calls[0].action, "schedule_callback");

    // And the reloaded screen shows it, because /api/revenue-crm already served dueCallbacks.
    const text = screenText(screen.html());
    assert.ok(text.includes(String(stored.lead_id)), "the scheduled callback is listed");
    assert.match(text, /Customer asked for a call after work at 6pm/);
  } finally { restore(); }
});

test("CB-02: the rep completes the callback from the same screen, with a real outcome", async () => {
  const harness = await world();
  const { scheduleLeadCallback } = await import("../lib/lead-callback-governance.ts");
  const scheduled = await scheduleLeadCallback(harness.db, { leadId: LEAD, requestedAt: Date.now() + 20 * 60000, reason: "Customer asked to be called at six", actorId: REP });
  const calls = [];
  const restore = installFetch(calls);
  try {
    const screen = mount(RevenueEnginePanel, { notify: () => {} }, { label: "RevenueEnginePanel" });
    await screen.settle();
    button(screen.tree(), "Callbacks").props.onClick();
    await screen.settle();
    assert.ok(screenText(screen.html()).includes(scheduled.id), "the due callback is on screen");

    control(screen.tree(), "Call outcome").props.onChange({ target: { value: "Spoke to her, booking on Saturday" } });
    await screen.settle();
    button(screen.tree(), "Log call outcome").props.onClick();
    await screen.settle();

    const row = harness.sqlite.prepare("SELECT status,completed_outcome FROM lead_callbacks WHERE id=?").get(scheduled.id);
    assert.equal(row.status, "completed", "the callback is really closed");
    assert.equal(row.completed_outcome, "Spoke to her, booking on Saturday");
    assert.equal(calls.at(-1).action, "complete_callback");
    assert.equal(screenText(screen.html()).includes(scheduled.id), false, "and it leaves the due queue");
  } finally { restore(); }
});

test("CB-03: an overdue callback is counted on the metric tile and flagged in the queue", async () => {
  const harness = await world();
  const { scheduleLeadCallback } = await import("../lib/lead-callback-governance.ts");
  const soon = await scheduleLeadCallback(harness.db, { leadId: LEAD, requestedAt: Date.now() + 60000, reason: "Customer asked to be called right away" , actorId: REP });
  // Move it into the past the way the clock does.
  harness.sqlite.prepare("UPDATE lead_callbacks SET requested_at=? WHERE id=?").run(Date.now() - 45 * 60000, soon.id);
  const restore = installFetch([]);
  try {
    const screen = mount(RevenueEnginePanel, { notify: () => {} }, { label: "RevenueEnginePanel" });
    await screen.settle();
    const text = screenText(screen.html());
    assert.match(text, /Callbacks overdue/, "the tile the API already computed is rendered");
    assert.match(text, /Callbacks \(1 overdue\)/, "and the tab says how many");
    button(screen.tree(), "Callbacks").props.onClick();
    await screen.settle();
    assert.match(screenText(screen.html()), /Overdue by 4[0-9] min/);
  } finally { restore(); }
});

test("CB-04: the engine still refuses a callback in the past, and the screen shows the reason", async () => {
  // NON-VACUITY: a screen that could schedule a placeholder time would be worse than no screen.
  const harness = await world();
  const restore = installFetch([]);
  try {
    const screen = mount(RevenueEnginePanel, { notify: () => {} }, { label: "RevenueEnginePanel" });
    await screen.settle();
    button(screen.tree(), "Callbacks").props.onClick();
    await screen.settle();
    const past = new Date(Date.now() - 3600000);
    const local = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}T${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
    control(screen.tree(), "Lead").props.onChange({ target: { value: LEAD } });
    control(screen.tree(), "Callback time").props.onChange({ target: { value: local } });
    control(screen.tree(), "Callback reason").props.onChange({ target: { value: "A time that has already passed" } });
    await screen.settle();
    find(screen.tree(), (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
    await screen.settle();
    assert.match(screenText(screen.html()), /not a placeholder/, "the engine's own refusal reaches the rep");
    assert.equal(harness.sqlite.prepare("SELECT COUNT(*) c FROM lead_callbacks").get().c, 0, "and nothing was scheduled");
    void all;
  } finally { restore(); }
});
