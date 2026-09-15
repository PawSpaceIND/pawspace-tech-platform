/*
 * The hub navigation, RENDERED.
 *
 * 45 of 153 screens had no link anywhere in the product. tests/w2d-route-reachability.test.mjs
 * ratchets that count; it proves a path string exists somewhere, which is not the same as proving a
 * user sees a link. This suite renders the hubs and reads what comes out.
 *
 * Two claims are checked, and both are about output rather than source:
 *
 *  1. Each hub really renders the gated link section, carrying its own catalogue. The page function
 *     is EXECUTED (the harness drives React's dispatcher) and the returned element tree inspected -
 *     a hub that stopped rendering the section, or handed it someone else's list, fails here.
 *  2. For every catalogue, the markup offers exactly the links the role may open. A permitted role
 *     sees the href; a role without that permission does not see it at all. The roles are the real
 *     ones from lib/platform-security.ts, not invented permission sets, and the expectations are
 *     written out by hand rather than computed with the same filter the component uses - a test that
 *     recomputes the answer with the code under test agrees with any bug in it.
 *
 * A link a user cannot use must not be shown: offering a workspace that answers "Permission denied"
 * is worse than offering nothing, because the operator cannot tell a missing permission from a
 * broken page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, find, walk } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__W2D_HUB_LINKS_DB__");

// Two resolutions the shared harness does not cover, neither of them about the code under test:
// `../../components/ui` is a DIRECTORY barrel (index.ts) that Node's ESM resolver will not fold in,
// and that barrel pulls recharts, whose CJS chain cannot be linked from a synchronous resolve hook.
// next/navigation is stubbed because OpsShell reads usePathname at render.
const RECHARTS_STUB = `data:text/javascript,${encodeURIComponent(
  ["ResponsiveContainer", "LineChart", "Line", "BarChart", "Bar", "XAxis", "YAxis", "CartesianGrid", "Tooltip", "Legend"]
    .map((name) => `export const ${name}=()=>null;`).join(""),
)}`;
const NAVIGATION_STUB = `data:text/javascript,${encodeURIComponent(
  'export const usePathname=()=>"/team";export const useRouter=()=>({push(){},replace(){},refresh(){},back(){}});export const useSearchParams=()=>new URLSearchParams();export const redirect=()=>{};export const notFound=()=>{};',
)}`;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "recharts") return { url: RECHARTS_STUB, shortCircuit: true };
    if (specifier === "next/navigation" || specifier === "next/navigation.js") return { url: NAVIGATION_STUB, shortCircuit: true };
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        for (const candidate of [`${specifier}/index.ts`, `${specifier}/index.tsx`]) {
          try { return nextResolve(candidate, context); } catch { /* try the next candidate */ }
        }
      }
      throw error;
    }
  },
});

const hubLinks = await import("../app/components/hub-workspace-links.tsx");
const { defaultRoles } = await import("../lib/platform-security.ts");

const teamHub = await import("../app/team/page.tsx");
const financeHub = await import("../app/team/finance/page.tsx");
const operationsHub = await import("../app/team/operations/page.tsx");
const peopleHub = await import("../app/team/people/page.tsx");
const salesHub = await import("../app/team/sales/page.tsx");
const marketingHub = await import("../app/team/marketing/page.tsx");
const voiceHub = await import("../app/team/voice/page.tsx");
const partnerHub = await import("../app/partner/page.tsx");
const controlHub = await import("../app/control/page.tsx");

const permissionsOf = (code) => {
  const role = defaultRoles.find((item) => item.code === code);
  assert.ok(role, `role ${code} is defined in lib/platform-security.ts`);
  return [...role.permissions];
};

/** A fetch that answers the endpoints these hubs read, and nothing else. */
function stubFetch(answers) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    for (const [fragment, body] of Object.entries(answers)) {
      if (url.includes(fragment)) return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({ error: `no stub for ${url}` }) };
  };
  return () => { globalThis.fetch = original; };
}

const staffFetch = (permissions) => stubFetch({
  "/api/team-overview": { data: { actor: { name: "Test Operator", email: "op@pawspace.in", roleCode: "test", permissions }, today: "2026-09-15", commandStrip: {}, workspaces: {} } },
  "/api/control-tower": { data: { date: "2026-09-15", timezone: "Asia/Kolkata", headline: { signalsTracked: 0, signalsClear: 0, needsAttention: 0, openItems: 0 }, signals: [], posture: [], recentChanges: [], sourceStatus: {} } },
});
const providerFetch = (roleCode) => stubFetch({ "/api/identity-session": { data: { subjectType: "provider", subjectId: "prov_1", roleCode } } });

/** Render one gated section for one role and return its markup. */
async function renderSection(Component, links, installFetch) {
  const restore = installFetch();
  try {
    const rendered = mount(Component, { heading: "Workspaces", links }, { label: "hub links" });
    await rendered.settle();
    return rendered.html();
  } finally { restore(); }
}

/**
 * The outcome assertion: these hrefs are in the markup, those are not. `absent` is checked as
 * strictly as `present` - a gate that shows everything passes half a test.
 */
function assertLinks(html, { present, absent }, label) {
  for (const href of present) assert.ok(html.includes(`href="${href}"`), `${label}: expected a link to ${href}`);
  for (const href of absent) assert.ok(!html.includes(`href="${href}"`), `${label}: must NOT offer ${href}`);
}

const SECTION_TYPES = new Set([hubLinks.default, hubLinks.HubWorkspaceLinks, hubLinks.ProviderHubWorkspaceLinks]);

test("W2D-RENDER-1: every hub renders its own permission-gated workspace section", () => {
  /*
   * The page function itself runs here; nothing is matched against source text.
   *
   * The expected component type is part of the claim, not decoration. /partner must use the PROVIDER
   * form: a partner holds an identity session, not a staff account, and /api/team-overview is
   * dashboard.view, which no provider role has - so the staff form would silently offer a partner
   * nothing at all, on a page whose entire audience is partners.
   */
  const cases = [
    ["app/team/page.tsx", teamHub.default, teamHub.configurationLinks, hubLinks.HubWorkspaceLinks],
    ["app/team/finance/page.tsx", financeHub.default, financeHub.financeWorkspaceLinks, hubLinks.default],
    ["app/team/operations/page.tsx", operationsHub.default, operationsHub.operationsWorkspaceLinks, hubLinks.default],
    ["app/team/people/page.tsx", peopleHub.default, peopleHub.peopleWorkspaceLinks, hubLinks.default],
    ["app/team/sales/page.tsx", salesHub.default, salesHub.salesWorkspaceLinks, hubLinks.default],
    ["app/team/marketing/page.tsx", marketingHub.default, marketingHub.marketingWorkspaceLinks, hubLinks.default],
    ["app/team/voice/page.tsx", voiceHub.default, voiceHub.voiceWorkspaceLinks, hubLinks.default],
    ["app/partner/page.tsx", partnerHub.default, partnerHub.partnerWorkspaceLinks, hubLinks.ProviderHubWorkspaceLinks],
  ];
  for (const [label, Page, catalogue, expectedType] of cases) {
    assert.ok(Array.isArray(catalogue) && catalogue.length > 0, `${label} exports a non-empty link catalogue`);
    for (const link of catalogue) {
      assert.match(link.href, /^\//, `${label}: every entry is an app route`);
      assert.ok(link.permission && link.label && link.detail, `${label}: ${link.href} needs a permission, a label and a detail`);
    }
    const node = find(mount(Page, {}, { label }).tree(), (element) => SECTION_TYPES.has(element?.type));
    assert.ok(node, `${label} must render the permission-gated workspace links`);
    assert.equal(node.type, expectedType, `${label} gates on the wrong actor - staff endpoint where a provider identity session is needed, or the other way round`);
    assert.deepEqual(node.props.links, catalogue, `${label} must pass its own catalogue to the gated section`);
  }
});

test("W2D-RENDER-2: Control lists its sibling ROUTES, gated, and only for a role that holds them", async () => {
  // /control's nav switches a view inside the shell; these three navigate away, so they are a
  // separate gated list. Rendered here through the real page, with the real usePermissions fetch.
  const founder = staffFetch(permissionsOf("founder"));
  let html;
  try {
    const rendered = mount(controlHub.default, {}, { label: "/control" });
    await rendered.settle();
    html = rendered.html();
  } finally { founder(); }
  assertLinks(html, {
    present: ["/control/integrations", "/control/provider-onboarding", "/control/appearance"],
    absent: [],
  }, "/control as founder");

  const manager = staffFetch(permissionsOf("manager")); // launch.view, no settings.manage
  try {
    const rendered = mount(controlHub.default, {}, { label: "/control" });
    await rendered.settle();
    html = rendered.html();
  } finally { manager(); }
  assertLinks(html, {
    present: ["/control/integrations"],
    absent: ["/control/provider-onboarding", "/control/appearance"],
  }, "/control as manager");
});

test("W2D-RENDER-3: Team home lists platform configuration for the roles that hold it", async () => {
  // /team already loads the actor for its workspace tiles, so the gated list renders inline from
  // the same permissions - the whole page is rendered here, not a fragment of it.
  const manager = staffFetch(permissionsOf("manager")); // pricing.view, reports.view, providers.manage
  let html;
  try {
    const rendered = mount(teamHub.default, {}, { label: "/team" });
    await rendered.settle();
    html = rendered.html();
  } finally { manager(); }
  assertLinks(html, {
    present: ["/team/catalogue", "/team/pricing-rules", "/team/alerts", "/team/provider-verification"],
    absent: ["/team/provider-onboarding", "/team/i18n"],
  }, "/team as manager");

  const auditor = staffFetch(permissionsOf("auditor")); // reports.view only, of these
  try {
    const rendered = mount(teamHub.default, {}, { label: "/team" });
    await rendered.settle();
    html = rendered.html();
  } finally { auditor(); }
  assertLinks(html, {
    present: ["/team/alerts"],
    absent: ["/team/catalogue", "/team/pricing-rules", "/team/provider-verification", "/team/provider-onboarding", "/team/i18n"],
  }, "/team as auditor");
});

test("W2D-RENDER-4: Team Finance offers its eight sibling finance screens to the roles that can load them", async () => {
  const Staff = hubLinks.default;
  const links = financeHub.financeWorkspaceLinks;
  // Finance holds finance.view and reports.view but NOT bookings.view. Relocation and Funeral finance
  // used to read /api/relocation and /api/funeral-memorial unscoped - booking/customer reads - and
  // were correctly hidden from the only role whose job they are. Both now read at ?scope=finance, a
  // finance.view read returning the commercial fields and nothing that identifies the customer
  // (lib/api-gateway.ts, and the allow-list in each route handler), so finance opens all eight and a
  // bookings.view-only role is not offered the two that would now refuse it. [W2-H fix 3]
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("finance"))), {
    present: ["/team/finance/food", "/team/finance/sitting", "/team/finance/taxi", "/team/finance/partners", "/team/finance/statutory", "/team/finance/unit-economics", "/team/finance/relocation", "/team/finance/funeral-memorial"],
    absent: [],
  }, "finance role");
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("associate"))), {
    present: [],
    absent: ["/team/finance/food", "/team/finance/sitting", "/team/finance/taxi", "/team/finance/partners", "/team/finance/statutory", "/team/finance/unit-economics", "/team/finance/relocation", "/team/finance/funeral-memorial"],
  }, "associate role");
  // unit-economics is reports.view, which the auditor holds and finance also holds - so the finance
  // list is not simply "everything finance.view": one entry is gated on a different permission and a
  // role that holds only that one still sees exactly it.
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("auditor"))), {
    present: ["/team/finance/unit-economics"],
    absent: ["/team/finance/food", "/team/finance/sitting", "/team/finance/taxi", "/team/finance/partners", "/team/finance/statutory", "/team/finance/relocation", "/team/finance/funeral-memorial"],
  }, "auditor role");
});

test("W2D-RENDER-5: Operations offers the work queues only where the permission allows", async () => {
  const Staff = hubLinks.default;
  const links = operationsHub.operationsWorkspaceLinks;
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("manager"))), {
    present: ["/team/operations/work-queue", "/team/operations/training", "/team/operations/food/supply-chain", "/team/relocation", "/team/funeral-memorial"],
    absent: [],
  }, "manager role");
  // associate holds bookings.view but not bookings.manage: the read-only queues, not the managed ones.
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("associate"))), {
    present: ["/team/relocation", "/team/funeral-memorial"],
    absent: ["/team/operations/work-queue", "/team/operations/training", "/team/operations/food/supply-chain"],
  }, "associate role");
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("auditor"))), {
    present: [],
    absent: ["/team/operations/work-queue", "/team/operations/training", "/team/operations/food/supply-chain", "/team/relocation", "/team/funeral-memorial"],
  }, "auditor role");
});

test("W2D-RENDER-6: Sales, People and Voice gate on the permission their API enforces", async () => {
  const Staff = hubLinks.default;
  // /api/outbound-orchestrator needs customers.manage AND communications.call. An associate holds
  // communications.call alone, so the dialler must not be offered to one.
  assertLinks(await renderSection(Staff, salesHub.salesWorkspaceLinks, () => staffFetch(permissionsOf("associate"))), {
    present: ["/team/sales/cross-sell", "/team/relocation-enquiries", "/team/bot-call-outcomes", "/team/subscriptions"],
    absent: ["/team/sales/power-dialler", "/team/acquisition-funnel", "/team/revenue-mission"],
  }, "sales as associate");
  assertLinks(await renderSection(Staff, salesHub.salesWorkspaceLinks, () => staffFetch(permissionsOf("auditor"))), {
    present: ["/team/revenue-mission"],
    absent: ["/team/sales/cross-sell", "/team/sales/power-dialler", "/team/acquisition-funnel", "/team/relocation-enquiries", "/team/bot-call-outcomes", "/team/subscriptions"],
  }, "sales as auditor");

  // The provider LMS reads at bookings.view, which finance does not hold.
  assertLinks(await renderSection(Staff, peopleHub.peopleWorkspaceLinks, () => staffFetch(permissionsOf("associate"))), {
    present: ["/team/people/provider-training"], absent: [],
  }, "people as associate");
  assertLinks(await renderSection(Staff, peopleHub.peopleWorkspaceLinks, () => staffFetch(permissionsOf("finance"))), {
    present: [], absent: ["/team/people/provider-training"],
  }, "people as finance");

  // The AI voice bench needs settings.manage on top of the console's own permissions; admin has none.
  assertLinks(await renderSection(Staff, voiceHub.voiceWorkspaceLinks, () => staffFetch(permissionsOf("founder"))), {
    present: ["/team/voice/ai-test"], absent: [],
  }, "voice as founder");
  assertLinks(await renderSection(Staff, voiceHub.voiceWorkspaceLinks, () => staffFetch(permissionsOf("admin"))), {
    present: [], absent: ["/team/voice/ai-test"],
  }, "voice as admin");
});

test("W2D-RENDER-7: Marketing keeps WhatsApp on communications.manage and the reminder engine on settings.manage", async () => {
  const Staff = hubLinks.default;
  const links = marketingHub.marketingWorkspaceLinks;
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("admin"))), {
    present: ["/team/marketing/content", "/team/whatsapp/templates", "/team/whatsapp/automation", "/team/whatsapp/analytics", "/team/haptik"],
    absent: ["/team/lifecycle-reminders"],
  }, "marketing as admin");
  // associate holds communications.manage and nothing else here.
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("associate"))), {
    present: ["/team/whatsapp/templates", "/team/whatsapp/automation"],
    absent: ["/team/marketing/content", "/team/whatsapp/analytics", "/team/haptik", "/team/lifecycle-reminders"],
  }, "marketing as associate");
  assertLinks(await renderSection(Staff, links, () => staffFetch(permissionsOf("founder"))), {
    present: ["/team/marketing/content", "/team/whatsapp/templates", "/team/whatsapp/automation", "/team/whatsapp/analytics", "/team/haptik", "/team/lifecycle-reminders"],
    absent: [],
  }, "marketing as founder");
});

test("W2D-RENDER-8: the Partner hub gates on the provider identity session, not on a staff account", async () => {
  const Provider = hubLinks.ProviderHubWorkspaceLinks;
  const links = partnerHub.partnerWorkspaceLinks;
  assertLinks(await renderSection(Provider, links, () => providerFetch("service_provider")), {
    present: ["/trainer", "/partner/funeral", "/partner/rates"], absent: [],
  }, "partner as service_provider");
  // A customer session reaching /partner holds neither bookings.view nor self_service.view.
  assertLinks(await renderSection(Provider, links, () => providerFetch("customer")), {
    present: [], absent: ["/trainer", "/partner/funeral", "/partner/rates"],
  }, "partner as customer");
  // No session at all: /api/identity-session answers 401, and nothing is offered.
  const restore = stubFetch({});
  try {
    const rendered = mount(Provider, { heading: "Workspaces", links }, { label: "partner anon" });
    await rendered.settle();
    assertLinks(rendered.html(), { present: [], absent: ["/trainer", "/partner/funeral", "/partner/rates"] }, "partner with no session");
  } finally { restore(); }
});

test("W2D-RENDER-9: an unloaded actor and a role with nothing are told different things", async () => {
  /*
   * A tile shown and then withdrawn reads as a permission that was just taken away, so nothing is
   * offered until the actor is known. Both states offer no link, which is why "no link rendered" is
   * not enough to test either of them: the operator has to be able to tell "still loading" from
   * "your role cannot open these", or a slow request looks like a revoked permission.
   */
  const links = financeHub.financeWorkspaceLinks;
  const anchorsOf = (tree) => [...walk(tree)].filter((node) => node?.props?.href);

  const pending = mount(hubLinks.HubWorkspaceLinks, { heading: "Workspaces", links, permissions: ["*"], loaded: false }, { label: "pre-load" });
  assert.deepEqual(anchorsOf(pending.tree()), [], "no workspace link may render before the permission set is known");
  assert.match(pending.html(), /Loading what your role can open/, "an unloaded actor is told the list is still loading");

  const empty = mount(hubLinks.HubWorkspaceLinks, { heading: "Workspaces", links, permissions: [], loaded: true }, { label: "no permissions" });
  assert.deepEqual(anchorsOf(empty.tree()), [], "a role with none of these permissions is offered nothing");
  assert.match(empty.html(), /Your role cannot open any of these workspaces/, "a loaded role with nothing is told so, not left on a spinner");

  // And the connected component reaches the loaded state from a real response, not only from props.
  const restore = staffFetch(permissionsOf("finance"));
  try {
    const settled = mount(hubLinks.default, { heading: "Workspaces", links }, { label: "connected" });
    assert.match(settled.html(), /Loading what your role can open/, "the connected section offers nothing on its first render");
    await settled.settle();
    assert.ok(settled.html().includes('href="/team/finance/statutory"'), "and offers the permitted workspaces once the actor has loaded");
  } finally { restore(); }
});
