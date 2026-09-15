/*
 * R3-C / F8 (P2) — the 409's own remedy had no screen.
 *
 * MEASURED: /api/assisted-orders refuses an unpriceable order with "publish the city GST policy
 * through Grooming finance (save_tax_policy) first". Grep of the whole repo: the only save_tax_policy
 * control anywhere is app/team/finance/training/page.tsx, which publishes a TRAINING policy and prices
 * nothing in Grooming. On the UAT database grooming_tax_policies had no `blr` row at all, so every
 * assisted order 409'd and the documented way out existed only over curl.
 *
 * This test drives the REAL control and lets its POST reach the REAL /api/grooming-finance handler
 * over real SQLite, then asserts the OUTCOME the 409 asked for: a published policy for the city, and a
 * governed quote that can now be computed. A test that only asserted a button exists would pass
 * against a button wired to nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { mount, find, all, screenText } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__R3C_TAXUI_DB__", "__R3C_TAXUI_ENV__");

const { default: GroomingTaxPolicyControl, canPublishGroomingTaxPolicy } = await import("../app/team/finance/grooming-tax-policy.tsx");
const ORIGIN = "https://uat.pawspace.in";
const FINANCE = "finance.manager@pawspace.test";

async function world() {
  const harness = freshCountingD1();
  enterWorkersDbScope(harness.db);
  globalThis.__R3C_TAXUI_DB__ = harness.db;
  globalThis.__R3C_TAXUI_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(harness.db);
  const now = Date.now();
  await harness.db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-FIN',?,?,'finance','active',?,?)")
    .bind(FINANCE, "Finance Manager", now, now).run();
  return harness;
}

/** The control's POST goes to the REAL route; /api/team-overview supplies the actor's permissions. */
function installFetch(permissions, posts) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/team-overview")) return Response.json({ data: { actor: { name: "Finance Manager", email: FINANCE, roleCode: "finance", permissions } } });
    if (url.includes("/api/grooming-finance") && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      const route = await import("../app/api/grooming-finance/route.ts");
      return route.POST(new Request(`${ORIGIN}/api/grooming-finance`, { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": FINANCE }, body: init.body }));
    }
    throw new Error(`unexpected call ${url}`);
  };
  return () => { globalThis.fetch = previous; };
}

const labelled = (tree, text) => {
  const node = find(tree, (n) => n.type === "label" && String(n.props?.children?.[0] ?? "").startsWith(text));
  assert.ok(node, `the form shows a "${text}" field`);
  const control = find(node, (n) => n.type === "input" || n.type === "select");
  assert.ok(control, `"${text}" has a control`);
  return control;
};

test("TAXUI-01: the gate is the permission the route demands", () => {
  assert.equal(canPublishGroomingTaxPolicy(["finance.manage"]), true);
  assert.equal(canPublishGroomingTaxPolicy(["*"]), true);
  assert.equal(canPublishGroomingTaxPolicy(["finance.view", "customers.view"]), false, "finance.view can read the ledger but not publish policy");
});

test("TAXUI-02: publishing EXCLUSIVE 18% from the screen makes the governed quote computable", async () => {
  const harness = await world();
  const posts = [];
  const restore = installFetch(["finance.view", "finance.manage"], posts);
  try {
    // NON-VACUITY: the quote really is blocked before the screen is used.
    const { generateCanonicalSalesQuote } = await import("../lib/sales-core-tools.ts");
    await assert.rejects(() => generateCanonicalSalesQuote(harness.db, { packageCode: "dog-basic", petCount: 1, cityId: "blr" }),
      /published city GST policy/, "this is the state the 409 describes");

    const screen = mount(GroomingTaxPolicyControl, { policies: [], onSaved: () => {} }, { label: "GroomingTaxPolicyControl" });
    await screen.settle();
    assert.match(screenText(screen.html()), /No city has a published Grooming GST policy/);

    labelled(screen.tree(), "City").props.onChange({ target: { value: "blr" } });
    labelled(screen.tree(), "GST mode").props.onChange({ target: { value: "exclusive" } });
    labelled(screen.tree(), "GST rate").props.onChange({ target: { value: "18" } });
    labelled(screen.tree(), "Effective from").props.onChange({ target: { value: "2026-09-01" } });
    labelled(screen.tree(), "Reason").props.onChange({ target: { value: "Finance approval FIN-2026-014" } });
    await screen.settle();

    const button = find(screen.tree(), (n) => n.type === "button" && String(n.props?.children ?? "").includes("Publish"));
    assert.ok(button, "the publish control is on screen for a finance.manage actor");
    button.props.onClick();
    await screen.settle();

    assert.deepEqual(posts, [{ action: "save_tax_policy", cityId: "blr", taxMode: "exclusive", taxRate: 18, effectiveFrom: "2026-09-01", reason: "Finance approval FIN-2026-014" }]);
    const stored = harness.sqlite.prepare("SELECT tax_mode,tax_rate,status,version FROM grooming_tax_policies WHERE city_id='blr'").get();
    assert.equal(stored?.status, "published", "the policy really is published, through the real route");
    assert.equal(stored.tax_mode, "exclusive");
    assert.equal(stored.tax_rate, 18);

    // THE OUTCOME THE 409 ASKED FOR.
    const quote = await generateCanonicalSalesQuote(harness.db, { packageCode: "dog-basic", petCount: 1, cityId: "blr" });
    assert.equal(quote.taxMode, "exclusive");
    assert.ok(quote.totalAmount > 1899, "and the city can now be priced");
    assert.match(screenText(screen.html()), /Published exclusive 18% GST for blr/, "and the operator is told so");
  } finally { restore(); }
});

test("TAXUI-03: an actor without finance.manage is told, not offered a control that would be refused", async () => {
  await world();
  const restore = installFetch(["finance.view"], []);
  try {
    const screen = mount(GroomingTaxPolicyControl, { policies: [], onSaved: () => {} }, { label: "GroomingTaxPolicyControl" });
    await screen.settle();
    const text = screenText(screen.html());
    assert.match(text, /needs the finance.manage permission/);
    assert.equal(all(screen.tree(), (n) => n.type === "button").length, 0, "no publish button is offered");
  } finally { restore(); }
});

test("TAXUI-04: the route's own refusal reaches the screen instead of a silent failure", async () => {
  const harness = await world();
  const posts = [];
  const restore = installFetch(["finance.manage"], posts);
  try {
    const screen = mount(GroomingTaxPolicyControl, { policies: [], onSaved: () => {} }, { label: "GroomingTaxPolicyControl" });
    await screen.settle();
    labelled(screen.tree(), "Reason").props.onChange({ target: { value: "short" } });
    await screen.settle();
    find(screen.tree(), (n) => n.type === "button" && String(n.props?.children ?? "").includes("Publish")).props.onClick();
    await screen.settle();
    assert.match(screenText(screen.html()), /clear reason are required/, "the server's reason is shown, not swallowed");
    assert.equal(harness.sqlite.prepare("SELECT COUNT(*) c FROM grooming_tax_policies").get().c, 0, "and nothing was published");
  } finally { restore(); }
});

test("TAXUI-05: an already published policy is shown, so the mode in force is visible", async () => {
  await world();
  const restore = installFetch(["finance.manage"], []);
  try {
    const screen = mount(GroomingTaxPolicyControl, {
      policies: [{ city_id: "blr", tax_mode: "exclusive", tax_rate: 18, status: "published", version: 2, effective_from: "2026-09-01", updated_by: FINANCE }],
      onSaved: () => {},
    }, { label: "GroomingTaxPolicyControl" });
    await screen.settle();
    const text = screenText(screen.html());
    assert.match(text, /blr : exclusive 18% · version 2/, text.slice(0, 400));
    assert.equal(/No city has a published Grooming GST policy/.test(text), false);
  } finally { restore(); }
});
