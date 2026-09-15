/*
 * R3-G / F4, F6, F7, F9, F11 - RENDERED, role by role.
 *
 * The OpsShell rail was gated in an earlier round and that gate holds, but six page BODIES still
 * carried hardcoded link lists: between them the breadth audit counted 60 distinct
 * page -> link -> 403 combinations across eight actor profiles. /team/operations alone offered six
 * bookings.manage queues to associate, provider, customer and a signed-out visitor, directly above a
 * section that says "Only the workspaces your role can open are listed".
 *
 * Alongside that, a refused read rendered as a real-looking zero (F6) and write controls were
 * offered on top of it (F7), /admin told every role it was "Karthik · Super admin" (F9), and two
 * screens answered a refusal with 309 characters and no way back (F11).
 *
 * Everything here EXECUTES the real component with the real gate: /api/team-overview is answered
 * with a real role's permission set from lib/platform-security.ts and the markup is read. The
 * expectations are written out by hand, both halves - what the role sees AND what it must not see -
 * because a gate that shows everything passes a presence-only test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__R3G_RENDER_DB__");

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

/*
 * The Booking Command Center debounces with window.setTimeout and subscribes to an EventSource. Both
 * are browser globals the render harness does not provide, and neither is the behaviour under test:
 * the timers are real (they just resolve against the Node ones) and the EventSource is inert, so no
 * stream is opened and no assertion below depends on either.
 */
globalThis.window = globalThis.window ?? globalThis;
globalThis.window.setTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.window.clearTimeout = globalThis.clearTimeout.bind(globalThis);
globalThis.EventSource = class { addEventListener() {} removeEventListener() {} close() {} };

const hubSection = (await import("../app/components/hub-workspace-links.tsx")).default;
const operationsHub = await import("../app/team/operations/page.tsx");
const teamHub = await import("../app/team/page.tsx");
const bookingCommandCenter = (await import("../app/booking-command-center/page.tsx")).default;
const { defaultRoles } = await import("../lib/platform-security.ts");

const permissionsOf = (code) => {
  const role = defaultRoles.find((item) => item.code === code);
  assert.ok(role, `role ${code} is defined in lib/platform-security.ts`);
  return [...role.permissions];
};

/**
 * Answers /api/team-overview with this role's real permission set; every other endpoint answers with
 * `apiStatus`, so a screen's own data read can be made to succeed or to be refused.
 */
function actorFetch(permissions, { apiStatus = 200, apiBody = {}, signedOut = false } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("/api/team-overview")) {
      if (signedOut) return { ok: false, status: 401, json: async () => ({ error: "Authentication required" }) };
      return { ok: true, status: 200, json: async () => ({ data: { actor: { name: "Rhea Operator", email: "rhea.operator@pawspace.in", roleCode: "associate", permissions }, today: "2026-09-15", commandStrip: {}, workspaces: {} } }) };
    }
    return { ok: apiStatus < 400, status: apiStatus, json: async () => (apiStatus < 400 ? apiBody : { error: "Permission denied" }) };
  };
  return () => { globalThis.fetch = original; };
}

async function render(Component, props, options, label) {
  const restore = actorFetch(...options);
  try {
    const rendered = mount(Component, props ?? {}, { label });
    await rendered.settle();
    return rendered.html();
  } finally { restore(); }
}

const has = (html, href) => html.includes(`href="${href}"`);

/* ----------------------------------------------------------------------------------------- F4 */

test("F4: the Operations hub offers its six queues to a manager and not one of them to an associate", async () => {
  const QUEUES = ["/team/operations/bookings", "/team/operations/boarding", "/team/operations/sitting",
    "/team/operations/walking", "/team/operations/food", "/team/operations/taxi"];

  const asManager = await render(hubSection, { heading: "Operations workspaces", links: operationsHub.operationsWorkspaceLinks }, [permissionsOf("manager")], "/team/operations as manager");
  for (const href of QUEUES) assert.ok(has(asManager, href), `a manager holds bookings.manage and must still be offered ${href}`);
  assert.ok(has(asManager, "/team/relocation"), "and the bookings.view workspaces beside them");

  // associate: dashboard.view, customers.view, bookings.VIEW - no bookings.manage.
  const asAssociate = await render(hubSection, { heading: "Operations workspaces", links: operationsHub.operationsWorkspaceLinks }, [permissionsOf("associate")], "/team/operations as associate");
  for (const href of QUEUES) assert.ok(!has(asAssociate, href), `an associate cannot open ${href} and must not be offered it`);
  assert.ok(!has(asAssociate, "/team/operations/work-queue"), "nor the cross-service work queue");
  assert.ok(has(asAssociate, "/team/relocation"), "bookings.view screens are still offered - the gate narrows, it does not blank the hub");

  // service_provider and a signed-out visitor: no bookings.manage, no staff actor at all.
  const asProvider = await render(hubSection, { heading: "Operations workspaces", links: operationsHub.operationsWorkspaceLinks }, [permissionsOf("service_provider")], "/team/operations as provider");
  for (const href of QUEUES) assert.ok(!has(asProvider, href), `a provider must not be offered ${href}`);
  const signedOut = await render(hubSection, { heading: "Operations workspaces", links: operationsHub.operationsWorkspaceLinks }, [[], { signedOut: true }], "/team/operations signed out");
  for (const href of [...QUEUES, "/team/relocation"]) assert.ok(!has(signedOut, href), `a signed-out visitor must not be offered ${href}`);
});

test("F4: the Team front door stops offering the Booking Command Center and Control to roles that cannot open them", async () => {
  const founder = await render(teamHub.default, {}, [permissionsOf("founder")], "/team as founder");
  assert.ok(has(founder, "/team/operations/bookings"), "the hero call to action still works for a role that holds bookings.manage");
  assert.ok(has(founder, "/control"), "and Control is still offered in the nav and the footer");

  const associate = await render(teamHub.default, {}, [permissionsOf("associate")], "/team as associate");
  assert.ok(!has(associate, "/team/operations/bookings"), "F4: the hero CTA pointed at a bookings.manage screen with no gate at all");
  assert.ok(!has(associate, "/control"), "F4: /control was in the top nav AND the footer, ungated, for every signed-in role");
  assert.ok(has(associate, "/team/sales"), "the tiles an associate CAN open are untouched");
  assert.ok(has(associate, "/"), "the public customer and partner links stay - they refuse nobody");
  assert.ok(has(associate, "/partner"));

  /*
   * F4: "Customer reminders" was gated on customers.view while /api/customer-reminders enforces
   * settings.manage, so it was offered to admin, manager and associate and every one of them was
   * refused. The tile now carries the permission the API demands, so the roles that hold it keep the
   * tile and the roles that do not lose it - whatever the permission model later decides about who
   * holds settings.manage.
   */
  for (const role of ["manager", "associate", "auditor"]) {
    const permissions = permissionsOf(role);
    assert.ok(!permissions.includes("settings.manage") && !permissions.includes("*"), `premise: ${role} does not hold settings.manage`);
    const html = await render(teamHub.default, {}, [permissions], `/team as ${role}`);
    assert.ok(!has(html, "/team/customer-reminders"), `${role} cannot open /api/customer-reminders and must not be offered the tile`);
    assert.ok(has(html, "/team"), `premise: the ${role} page really rendered`);
  }
  assert.ok(has(founder, "/team/customer-reminders"), "a role that holds settings.manage still gets it");
  const withSettings = await render(teamHub.default, {}, [["dashboard.view", "settings.manage"]], "/team holding settings.manage only");
  assert.ok(has(withSettings, "/team/customer-reminders"), "the tile follows settings.manage, not customers.view");
});

/* ------------------------------------------------------------------------------------- F6 / F7 */

const BCC_TILES = ["Total bookings", "Needs attention", "Payment pending", "Open revenue"];

test("F6: a refused Booking Command Center renders no figures at all, and says why", async () => {
  const refused = await render(bookingCommandCenter, {}, [permissionsOf("associate"), { apiStatus: 403 }], "/booking-command-center refused");
  for (const tile of BCC_TILES) assert.ok(!refused.includes(tile), `"${tile} 0" beside a refusal reads as a quiet day: ${tile} must not render`);
  assert.match(refused, /You do not have access to the Booking Command Center/);
  assert.match(refused, /A zero here would mean/, "the notice must say why no figure is shown");

  const signedOut = await render(bookingCommandCenter, {}, [[], { apiStatus: 401, signedOut: true }], "/booking-command-center signed out");
  for (const tile of BCC_TILES) assert.ok(!signedOut.includes(tile), `a signed-out visitor saw the same four zeros behind a 401: ${tile}`);
});

test("F7: the Booking Command Center offers no write control to a role whose read was refused", async () => {
  const refused = await render(bookingCommandCenter, {}, [permissionsOf("associate"), { apiStatus: 403 }], "/booking-command-center refused");
  assert.ok(!refused.includes("Add booking"), "＋ Add booking was offered above Permission denied");
  assert.ok(!refused.includes("Refresh snapshot"), "↻ Refresh snapshot was offered above Permission denied");
  assert.ok(!has(refused, "/assisted-booking"));
});

test("F4/F6: a successful read still renders the whole Booking Command Center", async () => {
  const ok = await render(bookingCommandCenter, {}, [permissionsOf("founder"), { apiStatus: 200, apiBody: { bookings: [] } }], "/booking-command-center as founder");
  for (const tile of BCC_TILES) assert.ok(ok.includes(tile), `${tile} must still render when the read succeeded`);
  assert.ok(ok.includes("Add booking"), "and so must the write controls");
  assert.ok(ok.includes("Refresh snapshot"));
  assert.ok(has(ok, "/team"), "and the rail, for a role that can open it");
  assert.ok(!ok.includes("You do not have access"), "no refusal notice on a successful read");
});

test("F4: the Booking Command Center rail offers nothing to a signed-out visitor", async () => {
  const signedOut = await render(bookingCommandCenter, {}, [[], { apiStatus: 401, signedOut: true }], "/booking-command-center signed out");
  for (const href of ["/team", "/team/operations", "/team/sales", "/control", "/control/integrations"]) {
    assert.ok(!has(signedOut, href), `the rail offered ${href} even to a signed-out visitor`);
  }
});

/* --------------------------------------------------------------------------------------- F9 */

const adminPage = (await import("../app/admin/page.tsx")).default;

/** The shape app/admin/page.tsx expects back from /api/operations-overview; nothing here is asserted. */
const OVERVIEW_BODY = { data: { date: "2026-08-03", dayWindow: {}, zoneId: null, zones: [], metrics: {}, capacity: [], capacityShown: 0, capacityTotal: 0, slots: [], activity: [], activityShown: 0, activityTotal: 0, byService: {}, sourceStatus: {} } };

test("F9: /admin shows the signed-in operator, not a hardcoded 'KP · Karthik · Super admin'", async () => {
  const auditor = await render(adminPage, {}, [permissionsOf("auditor"), { apiStatus: 200, apiBody: OVERVIEW_BODY }], "/admin as auditor");
  assert.ok(!auditor.includes("Karthik"), "the sidebar told every signed-in role it was Karthik");
  assert.ok(!auditor.includes("Super admin"), "…and that it was a super admin");
  assert.ok(auditor.includes("Rhea Operator"), "it must show the actor /api/team-overview actually returned");
  assert.ok(auditor.includes("associate"), "…and that actor's own role code");

  // A signed-out visitor never reaches the sidebar: the operations read fails and /admin shows its
  // access-error screen. What matters is that no identity is invented anywhere on the way there.
  const signedOut = await render(adminPage, {}, [[], { apiStatus: 401, signedOut: true }], "/admin signed out");
  assert.ok(!signedOut.includes("Karthik"), "no identity is borrowed on the refusal screen either");
  assert.ok(!signedOut.includes("Super admin"));
  assert.match(signedOut, /Operations overview unavailable/);
});

test("F4: the /admin sidebar footer offers only the consoles this role can open", async () => {
  const GATED = ["/team/operations/bookings", "/team/customer-experience", "/control/integrations", "/assisted-booking", "/control", "/team/finance", "/team/sales"];
  const okBody = OVERVIEW_BODY;

  // auditor: dashboard.view, reports.view, people.view, audit.view - no bookings.manage, no
  // communications.manage, no launch.view, no scheduling.book, no finance.view, no customers.view.
  const auditor = await render(adminPage, {}, [permissionsOf("auditor"), { apiStatus: 200, apiBody: okBody }], "/admin as auditor");
  assert.ok(has(auditor, "/control"), "auditor holds audit.view, so Platform Control stays");
  for (const href of GATED.filter((item) => item !== "/control")) {
    assert.ok(!has(auditor, href), `an auditor cannot open ${href} and must not be offered it`);
  }
  assert.ok(has(auditor, "/team"), "dashboard.view keeps Team home");
  assert.ok(has(auditor, "/mobile-app"), "the public surfaces are not gated - they refuse nobody");

  const founder = await render(adminPage, {}, [permissionsOf("founder"), { apiStatus: 200, apiBody: okBody }], "/admin as founder");
  for (const href of GATED) assert.ok(has(founder, href), `the founder holds everything and must still be offered ${href}`);
});

/* -------------------------------------------------------------------------------------- F11 */

const systemIntegration = (await import("../app/system-integration/page.tsx")).default;
const controlIntegrations = (await import("../app/control/integrations/page.tsx")).default;

test("F11: a refused integration screen is a screen, not 309 characters and a dead end", async () => {
  for (const [label, Component, title] of [
    ["/system-integration", systemIntegration, "System Integration Control"],
    ["/control/integrations", controlIntegrations, "Integration Readiness Register"],
  ]) {
    const html = await render(Component, {}, [permissionsOf("associate"), { apiStatus: 403 }], `${label} refused`);
    assert.ok(html.includes(title), `${label}: the refusal must still say which screen it is`);
    assert.match(html, /You do not have access to/, `${label}: and what happened`);
    assert.match(html, /Permission denied/, `${label}: carrying the platform's own refusal wording`);
    assert.ok(html.length > 309 * 2, `${label}: the whole refusal was 309 characters with no heading and no way out`);
    assert.ok(/Sign in with a staff account|← /.test(html), `${label}: it must offer a way onward`);
  }
});

/* -------------------------------------------------------------------------------------- F10 */

test("F10: the three customer service journeys with no anchor anywhere are linked from the front door", async () => {
  /*
   * / linked five of the eight customer verticals. /grooming - the vertical marketing buys traffic
   * for by name - /relocation and /funeral-memorial had no rendered anchor from any front door for
   * any role, so the only way to reach them was to type the URL.
   * tests/w2d-route-reachability.test.mjs counts ANY inbound string reference, which is why these
   * passed it; this reads the rendered markup instead. That ratchet is untouched.
   */
  const Home = (await import("../app/page.tsx")).default;
  // Server-rendered, which is how a visitor first receives this page: the component is executed and
  // its markup read. mount() is not used here because the front door drives timers and geolocation
  // that never settle outside a browser, and none of that is what this asserts.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const html = renderToStaticMarkup(React.createElement(Home));
  for (const href of ["/grooming", "/relocation", "/funeral-memorial"]) {
    assert.ok(has(html, href), `the customer front door must offer ${href}`);
  }
  for (const href of ["/food", "/boarding", "/sitting", "/taxi", "/walking", "/training"]) {
    assert.ok(has(html, href), `and must still offer ${href}`);
  }
});
