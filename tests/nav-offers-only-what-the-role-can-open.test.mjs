/*
 * The second half of R3-G / F4.
 *
 * F4 gated the OpsShell rail and six page bodies. It did not reach the surfaces below, and a sweep of
 * every hardcoded staff link left in app/ - cross-referenced against the permission each destination's
 * own API demands in lib/api-gateway.ts - found eight more places offering a link that answers
 * "Permission denied", including three offered to actors who are not staff at all:
 *
 *  - app/page.tsx, the PUBLIC marketing header, listed "Team" beside Grooming and Boarding. /team
 *    needs dashboard.view; no signed-out visitor and no customer holds it.
 *  - app/walker/page.tsx, a PROVIDER surface, linked Operations -> Walking. service_provider holds
 *    bookings.view, not the bookings.manage that queue demands.
 *  - app/business/page.tsx is linked from the public marketing footer AND from the customer app, and
 *    listed Control Center, Team, Finance, People and CRM to whoever arrived.
 *  - app/assisted-booking/page.tsx loads on scheduling.book, which the CUSTOMER role holds, and
 *    rendered a full staff OPS rail to that actor.
 *  - /team/alerts loads on reports.view - finance and auditor hold it - and offered Cases
 *    (bookings.manage) and CRM (customers.view), neither of which either role holds.
 *  - /team/finance/unit-economics loads on reports.view and its ONLY way back was Finance home
 *    (finance.view), so manager and auditor were stranded on it.
 *  - TeamShell's nav did the same on /team/revenue-mission, /team/voice, /team/voice/ai-test and
 *    /team/ai/analytics.
 *
 * Everything here EXECUTES the real component against a real role's permission set from
 * lib/platform-security.ts, and asserts BOTH halves - what the role must still see AND what it must
 * not - because a gate that shows everything passes a presence-only test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { mount } from "./helpers/customer-ui-harness.mjs";

installWorkersHooks("__NAV_OFFERS_DB__");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAVIGATION_STUB = `data:text/javascript,${encodeURIComponent(
  'export const usePathname=()=>"/";export const useRouter=()=>({push(){},replace(){},refresh(){},back(){}});export const useSearchParams=()=>new URLSearchParams();export const redirect=()=>{};export const notFound=()=>{};',
)}`;
// app/components/ui pulls recharts in through StatCard, and recharts reaches redux through a CJS
// require the ESM test loader cannot link. No assertion here reads a chart.
const RECHARTS_STUB = `data:text/javascript,${encodeURIComponent(
  ["ResponsiveContainer", "LineChart", "Line", "BarChart", "Bar", "AreaChart", "Area", "PieChart", "Pie", "Cell", "XAxis", "YAxis", "CartesianGrid", "Tooltip", "Legend"]
    .map((name) => `export const ${name}=()=>null;`).join(""),
)}`;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "recharts") return { url: RECHARTS_STUB, shortCircuit: true };
    if (specifier === "next/navigation" || specifier === "next/navigation.js") return { url: NAVIGATION_STUB, shortCircuit: true };
    try { return nextResolve(specifier, context); }
    catch (error) {
      // This repo writes relative imports without an extension; the loader hook the other executing
      // suites install resolves them, and a suite that omits it dies on the first such import.
      if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
        for (const candidate of [`${specifier}/index.ts`, `${specifier}/index.tsx`]) {
          try { return nextResolve(candidate, context); } catch { /* try the next candidate */ }
        }
      }
      throw error;
    }
  },
});

globalThis.window = globalThis.window ?? globalThis;
globalThis.window.setTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.window.clearTimeout = globalThis.clearTimeout.bind(globalThis);

const { defaultRoles } = await import("../lib/platform-security.ts");
const { TeamShell } = await import("../app/components/ui/TeamShell.tsx");
const businessHub = (await import("../app/business/page.tsx")).default;
const alertsPage = (await import("../app/team/alerts/page.tsx")).default;
const unitEconomics = (await import("../app/team/finance/unit-economics/page.tsx")).default;
const assistedBooking = (await import("../app/assisted-booking/page.tsx")).default;
const { StaffGatedLink } = await import("../app/components/hub-workspace-links.tsx");

const permissionsOf = (code) => {
  const role = defaultRoles.find((item) => item.code === code);
  assert.ok(role, `role ${code} is defined in lib/platform-security.ts`);
  return [...role.permissions];
};

/** /api/team-overview answers with this role's real permissions; every other read is refused. */
function actorFetch(permissions, { signedOut = false } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    if (url.includes("/api/team-overview")) {
      if (signedOut) return { ok: false, status: 401, json: async () => ({ error: "Authentication required" }) };
      return { ok: true, status: 200, json: async () => ({ data: { actor: { name: "Rhea Operator", email: "rhea.operator@pawspace.in", roleCode: "associate", permissions } } }) };
    }
    return { ok: false, status: 403, json: async () => ({ error: "Permission denied" }) };
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

/* ------------------------------------------------------------------ the two dead links, removed */

test("NAV-OFFER-1: the public header and the walker workspace no longer link a staff screen", () => {
  const home = readFileSync(path.join(ROOT, "app/page.tsx"), "utf8");
  assert.equal(/href="\/team"/.test(home), false,
    'app/page.tsx is the PUBLIC marketing header: /team needs dashboard.view, which no visitor and no customer holds');
  // The customer destinations on that header are the point of it and must survive the removal.
  for (const href of ["/mobile-app", "/grooming", "/boarding", "/taxi", "/training"]) {
    assert.ok(home.includes(`href="${href}"`), `the public header still offers ${href}`);
  }

  const walker = readFileSync(path.join(ROOT, "app/walker/page.tsx"), "utf8");
  assert.equal(walker.includes('href="/team/operations/walking"'), false,
    "a walker holds bookings.view, not the bookings.manage that Operations -> Walking demands");
  assert.ok(walker.includes("Operations → Walking"),
    "the sentence is still true and still useful - only the link was a dead end");
  assert.ok(walker.includes('href="/walking"'), "and the walker's own booking link is untouched");
});

/* --------------------------------------------------------------------------- the business hub */

test("NAV-OFFER-2: the business hub lists staff front doors only to roles that can open them", async () => {
  const STAFF = ["/crm", "/control", "/team", "/team/finance", "/team/people"];
  const OPEN = ["/mobile-app", "/", "/partner-app", "/prelaunch"];

  const founder = await render(businessHub, {}, [permissionsOf("founder")], "/business as founder");
  for (const href of [...STAFF, ...OPEN]) assert.ok(has(founder, href), `a founder must still be offered ${href}`);

  // A customer reaches /business from the marketing footer and from the customer app.
  const customer = await render(businessHub, {}, [permissionsOf("customer")], "/business as customer");
  for (const href of STAFF) assert.ok(!has(customer, href), `a customer cannot open ${href} and must not be offered it`);
  for (const href of OPEN) assert.ok(has(customer, href), `the open front doors stay: ${href}`);

  const signedOut = await render(businessHub, {}, [[], { signedOut: true }], "/business signed out");
  for (const href of STAFF) assert.ok(!has(signedOut, href), `a signed-out visitor must not be offered ${href}`);
  for (const href of OPEN) assert.ok(has(signedOut, href), `but the public site is still reachable: ${href}`);

  // The gate narrows by ROLE, not to a single privileged one: finance holds finance.view and
  // audit.view and must keep exactly those, without gaining customers.view or people.view.
  const finance = await render(businessHub, {}, [permissionsOf("finance")], "/business as finance");
  for (const href of ["/team/finance", "/control", "/team"]) assert.ok(has(finance, href), `finance holds what ${href} demands`);
  for (const href of ["/crm", "/team/people"]) assert.ok(!has(finance, href), `finance does not, and must not be offered ${href}`);
});

/* ------------------------------------------------------------------------- the alert centre */

test("NAV-OFFER-3: the alert centre offers Cases and CRM only to roles that hold them", async () => {
  const manager = await render(alertsPage, {}, [permissionsOf("manager")], "/team/alerts as manager");
  assert.ok(has(manager, "/team/cases"), "a manager holds bookings.manage and keeps the Cases link");
  assert.ok(has(manager, "/crm"), "and customers.view, so the CRM link too");

  // auditor and finance both hold reports.view, so both can OPEN /team/alerts - and neither holds
  // bookings.manage or customers.view, so both links refused them.
  for (const code of ["auditor", "finance"]) {
    const html = await render(alertsPage, {}, [permissionsOf(code)], `/team/alerts as ${code}`);
    assert.ok(!has(html, "/team/cases"), `${code} cannot open Cases and must not be offered it`);
    assert.ok(!has(html, "/crm"), `${code} cannot open CRM and must not be offered it`);
  }
});

/* ------------------------------------------------------- unit economics keeps a way back that works */

test("NAV-OFFER-4: unit economics sends each role back to a hub it can actually open", async () => {
  const finance = await render(unitEconomics, {}, [permissionsOf("finance")], "unit economics as finance");
  assert.ok(has(finance, "/team/finance"), "finance holds finance.view and still goes back to Finance home");

  // /api/unit-economics is reports.view. manager and auditor hold it, neither holds finance.view.
  for (const code of ["manager", "auditor"]) {
    const html = await render(unitEconomics, {}, [permissionsOf(code)], `unit economics as ${code}`);
    assert.ok(!has(html, "/team/finance"), `${code} cannot open Finance home`);
    assert.ok(has(html, "/team"), `${code} is not stranded - the way back is retargeted at /team, not removed`);
  }
});

/* ------------------------------------------------------------------------- the assisted-order rail */

test("NAV-OFFER-8: the assisted-order rail drops the staff surfaces a customer cannot open", async () => {
  // /api/assisted-orders is scheduling.book, and the CUSTOMER role holds it - so a customer can open
  // this page, and it rendered the whole staff OPS rail to them.
  const GATED = ["/crm", "/team", "/control"];
  const OPEN = ["/admin", "/assisted-booking", "/partner-app"];

  const admin = await render(assistedBooking, {}, [permissionsOf("admin")], "/assisted-booking as admin");
  for (const href of [...GATED, ...OPEN]) assert.ok(has(admin, href), `an admin must still be offered ${href}`);

  const customer = await render(assistedBooking, {}, [permissionsOf("customer")], "/assisted-booking as customer");
  for (const href of GATED) assert.ok(!has(customer, href), `a customer cannot open ${href} and must not be offered it`);
  for (const href of OPEN) assert.ok(has(customer, href), `the ungated rail entries stay: ${href}`);
});

/* ---------------------------------------------------------------------------- the shared shell */

test("NAV-OFFER-5: TeamShell hides a nav entry whose permission the actor lacks", async () => {
  const nav = [
    { href: "/team/daily-revenue", label: "Daily revenue", permission: "customers.view" },
    { href: "/team/cases", label: "Cases", permission: "bookings.manage" },
    { href: "/team", label: "Team home", primary: true, permission: "dashboard.view" },
  ];
  const props = { eyebrow: "TEST", title: "Shell", nav, children: null };

  const manager = await render(TeamShell, props, [permissionsOf("manager")], "TeamShell as manager");
  for (const link of nav) assert.ok(has(manager, link.href), `a manager holds every one of these and keeps ${link.href}`);

  // finance holds reports.view and dashboard.view - neither customers.view nor bookings.manage.
  const finance = await render(TeamShell, props, [permissionsOf("finance")], "TeamShell as finance");
  assert.ok(!has(finance, "/team/daily-revenue"), "customers.view is not held and the link goes");
  assert.ok(!has(finance, "/team/cases"), "nor bookings.manage");
  assert.ok(has(finance, "/team"), "dashboard.view is held, so the way home stays");

  const signedOut = await render(TeamShell, props, [[], { signedOut: true }], "TeamShell signed out");
  for (const link of nav) assert.ok(!has(signedOut, link.href), `no actor means no offer: ${link.href}`);
});

test("NAV-OFFER-6: a TeamShell nav that declares no permission is not gated at all", async () => {
  // The opt-in has to be backwards compatible, or adding the field silently blanks every nav that
  // has not adopted it - including for a signed-out visitor, where no actor ever loads.
  const nav = [{ href: "/team/plain", label: "Plain" }, { href: "/team", label: "Team home", primary: true }];
  const html = await render(TeamShell, { eyebrow: "TEST", title: "Shell", nav, children: null }, [[], { signedOut: true }], "ungated TeamShell");
  for (const link of nav) assert.ok(has(html, link.href), `an entry with no permission is always offered: ${link.href}`);
});

test("NAV-OFFER-7: every TeamShell caller declares a permission on each staff nav entry", () => {
  /*
   * NAV-OFFER-5 proves the shell gates. This proves the four callers opted in - a page that adds a
   * nav entry without a permission gets the old ungated behaviour silently, which is exactly the
   * defect. Read the sources rather than the rendered pages: the shell is a CHILD of each page, and
   * the render harness runs the ROOT component's effects only, so a page-level render would report
   * an empty nav for every role and pass for the wrong reason.
   */
  const CALLERS = [
    "app/team/revenue-mission/page.tsx",
    "app/team/ai/analytics/page.tsx",
    "app/team/voice/page.tsx",
    "app/team/voice/ai-test/page.tsx",
  ];
  const missing = [];
  let entries = 0;
  for (const file of CALLERS) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    for (const match of source.matchAll(/\{\s*href:\s*"(\/team[^"]*)"[^}]*\}/g)) {
      entries += 1;
      if (!/permission:\s*"[a-z_.]+"/.test(match[0])) missing.push(`${file}: ${match[1]}`);
    }
  }
  assert.ok(entries >= 13, `only ${entries} nav entries found across the four callers - the scan has gone blind`);
  assert.deepEqual(missing, [],
    `these TeamShell nav entries point at a staff route with no permission, so they are offered to ` +
    `every role that can open the page:\n  ${missing.join("\n  ")}`);
});

/* -------------------------------------------------------------- the single-control gated link */

test("NAV-OFFER-9: StaffGatedLink renders nothing when the actor cannot open the destination", async () => {
  const props = { href: "/team/finance", permission: "finance.view", children: "Finance home" };

  const finance = await render(StaffGatedLink, props, [permissionsOf("finance")], "StaffGatedLink as finance");
  assert.ok(has(finance, "/team/finance"), "finance holds finance.view and must still get the link");

  for (const code of ["manager", "auditor", "associate", "service_provider", "customer"]) {
    const html = await render(StaffGatedLink, props, [permissionsOf(code)], `StaffGatedLink as ${code}`);
    assert.ok(!has(html, "/team/finance"), `${code} does not hold finance.view and must be offered nothing`);
    assert.equal(html.includes("Finance home"), false, "and not the label either - the whole control goes");
  }

  const signedOut = await render(StaffGatedLink, props, [[], { signedOut: true }], "StaffGatedLink signed out");
  assert.ok(!has(signedOut, "/team/finance"), "no actor means no offer");
});

test("NAV-OFFER-10: the five remaining blocked links go through that gate", () => {
  /*
   * A WIRING pin, reading the sources on purpose. StaffGatedLink loads the actor in its OWN effect,
   * and it is a CHILD of each of these pages; the render harness runs the ROOT component's effects
   * only, so a page-level render reports the link absent for EVERY role - the negative half would
   * pass for the wrong reason and the positive half could never pass at all. NAV-OFFER-9 proves the
   * component; this proves these five call sites reach it.
   *
   * Each pair was measured role by role against lib/platform-security.ts before it was gated:
   *
   *   /team/catalogue and /team/pricing-rules load on pricing.view, which the CUSTOMER role holds,
   *   and offered Team home (dashboard.view), which no customer holds.
   *   /team/funeral-memorial and /team/relocation load on bookings.view, which service_provider
   *   holds, and offered the same.
   *   /team/ai/configuration loads on the gateway's dashboard.view default, which an associate
   *   holds, and offered AI review (reports.view), which an associate does not.
   */
  const PAIRS = [
    ["app/team/catalogue/page.tsx", "/team", "dashboard.view"],
    ["app/team/pricing-rules/page.tsx", "/team", "dashboard.view"],
    ["app/team/funeral-memorial/page.tsx", "/team", "dashboard.view"],
    ["app/team/relocation/page.tsx", "/team", "dashboard.view"],
    ["app/team/ai/configuration/page.tsx", "/team/ai", "reports.view"],
  ];
  const missing = [];
  for (const [file, href, permission] of PAIRS) {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    const gated = new RegExp(`StaffGatedLink[^>]*href="${href.replace(/\//g, "\\/")}"[^>]*permission="${permission.replace(".", "\\.")}"`);
    if (!gated.test(source)) missing.push(`${file}: ${href} is not behind StaffGatedLink on ${permission}`);
    // And that the ungated spelling is gone, so the gate was not simply added beside the old link.
    if (new RegExp(`<Link href="${href.replace(/\//g, "\\/")}"`).test(source)) {
      missing.push(`${file}: a plain <Link href="${href}"> is still there beside the gated one`);
    }
  }
  assert.deepEqual(missing, []);
});
