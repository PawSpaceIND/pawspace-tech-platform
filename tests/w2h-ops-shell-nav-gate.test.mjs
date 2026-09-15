/*
 * The Operations rail, RENDERED, for real roles.
 *
 * app/components/ops-shell/OpsShell.tsx is the chrome fifteen internal consoles render inside. Its
 * thirteen-item staff navigation carried no permission at all and rendered in full to every role: a
 * finance operator was offered the CX queue, the day board, Cases and Meet & greet; an auditor was
 * offered all thirteen. None of those screens loads for them - lib/api-gateway.ts refuses the read
 * before the handler runs - so the product was walking people into a 403 on which they cannot tell a
 * missing permission from a broken page. That is the same defect
 * app/components/hub-workspace-links.tsx fixed one level down, and the rail now uses the same gate:
 * useStaffPermissions() for the actor, visibleHubLinks() for the filter.
 *
 * HOW THIS IS ASSERTED. The real OpsShell is executed - effects run, /api/team-overview is answered
 * with a real role's permission set from lib/platform-security.ts - and the markup is read. Every
 * expectation below is WRITTEN OUT BY HAND, entry by entry, and both halves are checked: what the role
 * sees and what it must not see. Recomputing the expected list with visibleHubLinks() would agree with
 * any bug in visibleHubLinks(), and a gate that shows everything would pass a presence-only test.
 *
 * The founder case is the regression guard the change most needed: OpsShell is on many screens, and a
 * filter that quietly dropped an entry for the role that holds everything would be a far worse
 * outcome than the defect being fixed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount, all } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__W2H_OPS_SHELL_DB__");

// OpsShell reads usePathname at render; the Operations hub below pulls the shared UI barrel, which is
// a directory of index.ts reaching recharts. Neither is the code under test. Same stubs, same reasons,
// as tests/w2d-hub-links-render.test.mjs.
const RECHARTS_STUB = `data:text/javascript,${encodeURIComponent(
  ["ResponsiveContainer", "LineChart", "Line", "BarChart", "Bar", "XAxis", "YAxis", "CartesianGrid", "Tooltip", "Legend"]
    .map((name) => `export const ${name}=()=>null;`).join(""),
)}`;
const NAVIGATION_STUB = `data:text/javascript,${encodeURIComponent(
  'export const usePathname=()=>"/team/operations";export const useRouter=()=>({push(){},replace(){},refresh(){},back(){}});export const useSearchParams=()=>new URLSearchParams();export const redirect=()=>{};export const notFound=()=>{};',
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

const OpsShell = (await import("../app/components/ops-shell/OpsShell.tsx")).default;
const operationsHub = await import("../app/team/operations/page.tsx");
const hubSection = (await import("../app/components/hub-workspace-links.tsx")).default;
const { defaultRoles } = await import("../lib/platform-security.ts");

const permissionsOf = (code) => {
  const role = defaultRoles.find((item) => item.code === code);
  assert.ok(role, `role ${code} is defined in lib/platform-security.ts`);
  return [...role.permissions];
};

/** Answers /api/team-overview with this role's real permission set, and nothing else. */
function staffFetch(permissions) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("/api/team-overview")) {
      return { ok: true, status: 200, json: async () => ({ data: { actor: { name: "Test Operator", email: "op@pawspace.in", roleCode: "test", permissions }, today: "2026-09-15", commandStrip: {}, workspaces: {} } }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: `no stub for ${url}` }) };
  };
  return () => { globalThis.fetch = original; };
}

/** Render the real shell for one role and return the hrefs its rail actually offers. */
async function railFor(roleCode) {
  const restore = staffFetch(permissionsOf(roleCode));
  try {
    const rendered = mount(OpsShell, { title: "Workspace", children: null }, { label: `OpsShell as ${roleCode}` });
    await rendered.settle();
    return { hrefs: all(rendered.tree(), (node) => typeof node?.props?.href === "string").map((node) => node.props.href), html: rendered.html() };
  } finally { restore(); }
}

/** Every rail destination, so "absent" can be spelled as the complement of "present" by hand. */
const EVERY_NAV = [
  "/team", "/team/operations", "/team/scheduling", "/team/customer-experience", "/team/cases",
  "/team/customer-reminders", "/team/meet-and-greet", "/team/subscription-plans", "/team/performance",
  "/team/marketing", "/team/people", "/team/finance-compliance", "/team/analytics",
];
const EVERY_FOOTER = ["/team/operations/bookings", "/control/integrations", "/mobile-app"];

function assertRail(rail, present, label) {
  for (const href of present) assert.ok(rail.hrefs.includes(href), `${label}: the rail must offer ${href}`);
  for (const href of [...EVERY_NAV, ...EVERY_FOOTER]) {
    if (present.includes(href)) continue;
    assert.ok(!rail.hrefs.includes(href), `${label}: the rail must NOT offer ${href} - that screen answers "Permission denied" to this role`);
  }
}

test("W2H-RAIL-1: the founder still sees everything the rail ever showed", async () => {
  // The regression guard. ["*"] holds every permission there is, so nothing may be filtered out.
  const rail = await railFor("founder");
  assertRail(rail, [...EVERY_NAV, ...EVERY_FOOTER], "founder");
  // And the rail is really the rail: the current screen is still marked, and the chrome still renders.
  assert.match(rail.html, /aria-current="page"/, "the current screen is still marked from the pathname");
  assert.match(rail.html, /aria-label="Operations"/, "the rail itself still renders");
  assert.equal(await railFor("superuser").then((r) => r.hrefs.length), rail.hrefs.length, "superuser is ['*'] too and sees the same rail");
});

test("W2H-RAIL-2: an admin is offered all thirteen - settings.manage is now an admin permission", async () => {
  const rail = await railFor("admin");
  assertRail(rail, [
    "/team", "/team/operations", "/team/scheduling", "/team/customer-experience", "/team/cases",
    "/team/customer-reminders",
    "/team/meet-and-greet", "/team/subscription-plans", "/team/performance", "/team/marketing",
    "/team/people", "/team/finance-compliance", "/team/analytics",
    "/team/operations/bookings", "/control/integrations", "/mobile-app",
  ], "admin");
});

test("W2H-RAIL-2b: a role WITHOUT settings.manage is still not offered Reminders", async () => {
  // The negative case W2H-RAIL-2 used to carry. Without it, granting settings.manage to admin would
  // have quietly removed the only proof that this rail entry is gated at all.
  const rail = await railFor("associate");
  assert.ok(!rail.hrefs.includes("/team/customer-reminders"),
    "associate holds no settings.manage and must not be offered the reminder engine");
  assert.ok(rail.hrefs.length > 0, "the rail rendered something, so the absence above is not vacuous");
});

test("W2H-RAIL-3: a manager loses Finance as well - manager holds no finance.view", async () => {
  const rail = await railFor("manager");
  assertRail(rail, [
    "/team", "/team/operations", "/team/scheduling", "/team/customer-experience", "/team/cases",
    "/team/meet-and-greet", "/team/subscription-plans", "/team/performance", "/team/marketing",
    "/team/people", "/team/analytics",
    "/team/operations/bookings", "/control/integrations", "/mobile-app",
  ], "manager");
});

test("W2H-RAIL-4: the finance role is offered the four screens it can actually open", async () => {
  /*
   * The case that names the defect. Finance holds dashboard.view, finance.view, reports.view and
   * audit.view, and no booking, customer, scheduling, communications, marketing, people, pricing or
   * settings permission at all - so nine of the thirteen entries it used to be shown were a 403.
   */
  const rail = await railFor("finance");
  assertRail(rail, ["/team", "/team/performance", "/team/finance-compliance", "/team/analytics", "/mobile-app"], "finance");
});

test("W2H-RAIL-5: the lowest-privilege staff role gets a rail, not a wall of refusals", async () => {
  // auditor is read-only compliance: dashboard.view, reports.view, people.view, audit.view and the
  // view-only people permissions. It holds no booking, finance, marketing or settings permission.
  const rail = await railFor("auditor");
  assertRail(rail, ["/team", "/team/performance", "/team/people", "/team/analytics", "/mobile-app"], "auditor");

  // associate is a different shape of low privilege - booking and communications reads, no reports -
  // so it proves the filter is reading permissions and not just counting them.
  const associate = await railFor("associate");
  assertRail(associate, ["/team", "/team/operations", "/team/customer-experience", "/team/subscription-plans", "/mobile-app"], "associate");
});

test("W2H-RAIL-6: nothing is offered before the actor is known", async () => {
  /*
   * A rail item shown and then withdrawn reads as a permission that was just taken away. Until
   * /api/team-overview answers, the rail offers no staff destination at all - asserted on the FIRST
   * render, before settle() runs the effect.
   */
  const restore = staffFetch(permissionsOf("founder"));
  try {
    const rendered = mount(OpsShell, { title: "Workspace", children: null }, { label: "OpsShell pre-load" });
    const first = all(rendered.tree(), (node) => typeof node?.props?.href === "string").map((node) => node.props.href);
    assert.deepEqual(first, [], "no rail destination may render before the permission set is known");
    await rendered.settle();
    const settled = all(rendered.tree(), (node) => typeof node?.props?.href === "string").map((node) => node.props.href);
    assert.ok(settled.includes("/team/finance-compliance"), "and the rail fills in once the actor has loaded");
  } finally { restore(); }

  // A failed actor read resolves to no permissions rather than to an error: the workspace still
  // renders and nothing is offered. A blank rail is recoverable; a crashed console is not.
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const rendered = mount(OpsShell, { title: "Workspace", children: "the screen's own content" }, { label: "OpsShell offline" });
    await rendered.settle();
    // Exactly one destination survives a failed actor read: /mobile-app, the CUSTOMER app, which
    // carries no staff permission because it is a public surface. Every staff console is withheld.
    assert.deepEqual(all(rendered.tree(), (node) => typeof node?.props?.href === "string").map((node) => node.props.href), ["/mobile-app"]);
    assert.match(rendered.html(), /the screen&#x27;s own content|the screen's own content/, "the console it wraps still renders");
  } finally { globalThis.fetch = original; }
});

test("W2H-OPS-QUEUE: the Operations hub lists the Fresh Food and Taxi queues beside boarding, sitting and walking", async () => {
  /*
   * /team/operations/food was linked only from its own two children (the supply-chain and proof
   * screens beneath it) and /team/operations/taxi only from app/driver/canonical-driver-page.tsx - the
   * DRIVER's workspace. Neither was an orphan by the reachability metric and neither was reachable
   * from the hub that owns it: an operator on Operations control could open Boarding, Sitting and
   * Walking and had no way to reach Fresh Food or Taxi.
   *
   * Rendered, not grepped: the hub page is executed and its markup read.
   */
  const restore = staffFetch(permissionsOf("manager"));
  let html;
  try {
    // The queue cards moved into the gated section (R3-G/F4: six hardcoded cards were rendered to
    // every role, including a signed-in customer). mount() runs the ROOT component's effects only,
    // so the section is mounted directly with the page's OWN exported catalogue - same real gate.
    // The page-wires-the-catalogue half is asserted separately below, so nothing is lost.
    const rendered = mount(hubSection, { heading: "Operations workspaces", links: operationsHub.operationsWorkspaceLinks }, { label: "/team/operations" });
    await rendered.settle();
    html = rendered.html();
  } finally { restore(); }
  for (const href of ["/team/operations/boarding", "/team/operations/sitting", "/team/operations/walking", "/team/operations/food", "/team/operations/taxi"]) {
    assert.ok(html.includes(`href="${href}"`), `the Operations hub must offer ${href}`);
  }
  assert.match(html, /Fresh Food exception queue/);
  assert.match(html, /Taxi exception queue/);
});

test("W2H-OPS-WIRED: the Operations hub really renders its catalogue through the gated section", async () => {
  // Mounting the section directly (above) proves the gate filters. This proves the PAGE is what
  // hands it that catalogue - otherwise the queue cards could drift back into an ungated literal
  // and every test above would still pass.
  const source = await import("node:fs").then((fs) => fs.readFileSync("app/team/operations/page.tsx", "utf8"));
  assert.ok(Array.isArray(operationsHub.operationsWorkspaceLinks) && operationsHub.operationsWorkspaceLinks.length > 0,
    "the page must export the catalogue the gate filters");
  assert.match(source, /StaffHubWorkspaceLinks|hubSection|HubWorkspaceLinks/,
    "the page must render its links through the shared gated section, not a bare array");
  assert.ok(!/const QUEUES\s*=/.test(source),
    "the ungated QUEUES literal must not come back - that was the defect");
  for (const link of operationsHub.operationsWorkspaceLinks) {
    assert.ok(link.permission, `${link.href} must carry the permission its API enforces`);
  }
});

test("W2H-RAIL-SELF: staff can reach their own workspace, and only if they hold self_service.view", async () => {
  // R3-G/F10: /me holds an employee's own attendance, leave balance, leave requests, payslips and
  // salary. Its only inbound links were /staging-login and a conditional one on /partner/workspace,
  // so no staff console reached it - an employee could not find their own payslip from the product.
  for (const role of ["admin", "manager", "associate"]) {
    const rail = await railFor(role);
    assert.ok(rail.hrefs.includes("/me"), `${role} holds self_service.view and must be offered their own workspace`);
  }
  for (const role of ["finance", "auditor"]) {
    const rail = await railFor(role);
    assert.ok(rail.hrefs.length > 0, `${role} rendered a rail, so the absence below is not vacuous`);
    assert.ok(!rail.hrefs.includes("/me"), `${role} holds no self_service.view and must not be offered it`);
  }
});
