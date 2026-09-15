/*
 * A ratchet on dead navigation, modelled on tests/schema-read-coverage.test.mjs.
 *
 * That test asks "is every table a route READS created somewhere?". This one asks the navigational
 * equivalent: "is every page a user can render actually LINKED from somewhere?". At commit f4e735b
 * the answer was no for 45 of the 147 static routes under app/. They existed, they rendered, several
 * had tests, and nothing anywhere in app/, lib/ or worker/ contained their path, so the only way to
 * open one was to type its URL. The clearest single case: app/team/finance/page.tsx linked two of
 * its ten sibling finance screens, leaving Food, Funeral & memorial, Provider settlement,
 * Relocation, Sitting, Statutory, Taxi and Unit economics reconciling real money out of reach.
 *
 * Five routes are deliberately still unlinked and are frozen in the baseline with their reason:
 * /account and /ops are RETIRED redirect-only routes (tests/retired-routes.test.mjs forbids linking
 * them), /prelaunch/layer2-swarm is a destructive pre-launch lab that writes 60 bookings into the
 * real database, and /chat and /relocation-enquiry are customer-facing front doors whose owning
 * surfaces are outside this change.
 *
 * /walker/recovery was the sixth until the walker workspace gained the accept-offer link its Pet
 * Taxi sibling already had; a replacement walker could not accept an offer in the product at all.
 *
 * Like the schema ratchet this is a RATCHET rather than a gate: the set may only shrink. A NEW
 * orphan fails ROUTE-REACH-1; fixing a frozen one fails ROUTE-REACH-2 until it is deleted from
 * tests/w2d-route-reachability-baseline.json, which is the point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = JSON.parse(readFileSync(path.join(ROOT, "tests/w2d-route-reachability-baseline.json"), "utf8"));

/*
 * Every file the app ships, tracked or newly added, so a link written this minute counts. `--others
 * --exclude-standard` is what stops an uncommitted hub from reading as "still unlinked" while the
 * change that links it is in the working tree.
 */
const sourceFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "app", "lib", "worker"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));

/** Every statically-addressable page route: app/<segments>/page.tsx, minus dynamic [param] routes. */
const routes = sourceFiles
  .filter((file) => /^app\/(.*\/)?page\.tsx$/.test(file))
  .map((file) => "/" + file.slice("app/".length, -"page.tsx".length).replace(/\/$/, ""))
  .filter((route) => route !== "/" && !route.includes("["))
  .sort();

/*
 * Prose describes routes constantly in this codebase - lib/partner-settlement-governance.ts narrates
 * "the next time an operator merely OPENED /team/finance/partners" - and a comment is not a link.
 * Same stripping as the schema contract, for the same reason.
 */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Does this source LINK to this route?
 *
 * The route must open a string literal and end there: `"/team/relocation"` links /team/relocation,
 * `"/team/relocation-enquiries"` does not - without the trailing boundary every parent path is
 * silently "reachable" through a longer child, which is exactly how /team/relocation,
 * /team/finance/partners and /trainer read as linked when nothing linked them. A query string or
 * fragment still counts: `/mobile-app?tab=account` is a real link to /mobile-app.
 */
export function linksTo(source, route) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`["'\`]${escaped}(?=[?#"'\`])`).test(source);
}

const stripped = sourceFiles.map((file) => [file, stripComments(readFileSync(path.join(ROOT, file), "utf8"))]);

/** A route is reachable if any OTHER app/lib/worker source links to it. Its own page does not count. */
const linkers = (route) => stripped.filter(([file, source]) => file !== `app${route}/page.tsx` && linksTo(source, route)).map(([file]) => file);

const orphans = routes.filter((route) => linkers(route).length === 0);

test("ROUTE-REACH-1: no NEW page ships without a link to it", () => {
  const added = orphans.filter((route) => !BASELINE.includes(route));
  assert.deepEqual(added, [],
    `These pages render but nothing in app/, lib/ or worker/ links to them, so a user cannot get ` +
    `to them. Link each one from the hub that owns it, permission-gated the way ` +
    `app/components/hub-workspace-links.tsx does:\n  ${added.join("\n  ")}`);
});

test("ROUTE-REACH-2: the baseline only shrinks", () => {
  const linked = BASELINE.filter((route) => !orphans.includes(route));
  assert.deepEqual(linked, [],
    `These routes are now linked. Delete them from tests/w2d-route-reachability-baseline.json so ` +
    `the ratchet cannot slip back:\n  ${linked.join("\n  ")}`);
});

test("ROUTE-REACH-3: the baseline still names real pages", () => {
  // A baseline entry whose page was deleted would sit there forever, and ROUTE-REACH-2 would never
  // notice: a route that does not exist is not in `orphans` either... except it would then fail
  // ROUTE-REACH-2 as "now linked", which is a confusing way to say "now deleted". Say it directly.
  const missing = BASELINE.filter((route) => !routes.includes(route));
  assert.deepEqual(missing, [],
    `These baseline entries name a page that no longer exists. Delete them:\n  ${missing.join("\n  ")}`);
});

test("ROUTE-REACH-4: the scanner is not blind", () => {
  /*
   * The companion to SCHEMA-READ-3. Everything above passes trivially if the scan sees nothing: no
   * routes means no orphans, and no sources means every route is an orphan (which ROUTE-REACH-1
   * would catch) or, after a bad matcher change, none is (which nothing would catch). So pin both
   * ends - that pages are found, that sources are found, and that most routes come back reachable.
   */
  assert.ok(routes.length > 130, `only ${routes.length} page routes discovered - the route scan has gone blind`);
  assert.ok(sourceFiles.length > 400, `only ${sourceFiles.length} source files scanned - the file scan has gone blind`);
  const reachable = routes.length - orphans.length;
  assert.ok(reachable > 100, `only ${reachable} of ${routes.length} routes read as reachable - the link matcher has gone blind`);

  // A positive and a negative control against the REAL tree: the matcher must be able to say both.
  assert.deepEqual(orphans.includes("/team/operations/bookings"), false,
    "/team/operations/bookings is linked from app/team/page.tsx and app/team/operations/page.tsx - a matcher that calls it an orphan is broken");
  assert.equal(linkers("/team/__no_such_route__").length, 0,
    "a path that appears nowhere must resolve to no linkers, or the matcher is matching anything");
});

test("ROUTE-REACH-5: the matcher counts links and not prose or prefixes", () => {
  /*
   * The three ways this scan silently over-reports reachability, each one a real finding it hid:
   *
   *  - a COMMENT naming the route (lib/partner-settlement-governance.ts narrates
   *    /team/finance/partners; lib/session-api-gateway.ts narrates /partner/rates),
   *  - a LONGER route that merely starts with it (/team/relocation inside
   *    /team/relocation-enquiries; /trainer inside "./trainer-incentive-engine"),
   *  - an unrelated identifier that contains it (/account inside "lib/accounts-business-view",
   *    /ops inside "./ops-shell/OpsShell", /chat inside "/api/crm/chat").
   *
   * A naive `source.includes(route)` reported 33 orphans where there were 45: those 12 were found
   * only because both halves below hold. Run them on fixtures so a refactor of either half fails
   * here rather than quietly shrinking the count.
   */
  // Quoted, because this codebase's comments quote paths constantly - tests/retired-routes.test.mjs
  // narrates `href="${route}"` in its own prose - and an unquoted mention never reaches the matcher.
  assert.equal(linksTo(stripComments(`/* nothing links "/team/alerts" any more */ const x = 1;`), "/team/alerts"), false,
    "a route quoted in a block comment is not a link");
  assert.equal(linksTo(stripComments(`// was href="/team/alerts" before the rewrite\nconst x = 1;`), "/team/alerts"), false,
    "a route quoted in a line comment is not a link");
  assert.equal(linksTo(`<Link href="/team/relocation-enquiries">Enquiries</Link>`, "/team/relocation"), false,
    "a longer sibling route is not a link to its prefix");
  assert.equal(linksTo(`import x from "./trainer-incentive-engine";`, "/trainer"), false,
    "an identifier that merely starts with the route is not a link");
  assert.equal(linksTo(`fetch("/api/crm/chat")`, "/chat"), false,
    "a path that merely contains the route is not a link");

  assert.equal(linksTo(`<Link href="/team/alerts">Alerts</Link>`, "/team/alerts"), true,
    "an href to the route is a link");
  assert.equal(linksTo(`{ href: "/team/alerts", permission: "reports.view" }`, "/team/alerts"), true,
    "a route in a nav catalogue is a link");
  assert.equal(linksTo("redirect(`/walker/recovery?bookingId=${id}`)", "/walker/recovery"), true,
    "a query string after the route still links the route");
});

test("ROUTE-REACH-6: every route this change surfaced is linked from the hub that owns it", () => {
  /*
   * ROUTE-REACH-1 only says "something, somewhere links it". These 39 were linked deliberately, each
   * from one named hub, and a link that drifts to another page is a regression this ratchet would
   * not see. The hub file, not just any file, must be among the linkers.
   */
  const placed = {
    "app/team/page.tsx": ["/team/catalogue", "/team/pricing-rules", "/team/alerts", "/team/provider-verification", "/team/provider-onboarding", "/team/i18n"],
    "app/team/finance/page.tsx": ["/team/finance/food", "/team/finance/sitting", "/team/finance/taxi", "/team/finance/partners", "/team/finance/statutory", "/team/finance/unit-economics", "/team/finance/relocation", "/team/finance/funeral-memorial"],
    "app/team/operations/page.tsx": ["/team/operations/work-queue", "/team/operations/training", "/team/operations/food/supply-chain", "/team/relocation", "/team/funeral-memorial"],
    "app/team/people/page.tsx": ["/team/people/provider-training"],
    "app/team/sales/page.tsx": ["/team/sales/cross-sell", "/team/sales/power-dialler", "/team/acquisition-funnel", "/team/revenue-mission", "/team/relocation-enquiries", "/team/bot-call-outcomes", "/team/subscriptions"],
    "app/team/marketing/page.tsx": ["/team/marketing/content", "/team/whatsapp/templates", "/team/whatsapp/automation", "/team/whatsapp/analytics", "/team/haptik", "/team/lifecycle-reminders"],
    "app/team/voice/page.tsx": ["/team/voice/ai-test"],
    "app/control/page.tsx": ["/control/appearance", "/control/provider-onboarding"],
    "app/partner/page.tsx": ["/partner/rates", "/partner/funeral", "/trainer"],
  };
  const total = Object.values(placed).reduce((sum, list) => sum + list.length, 0);
  assert.equal(total, 39, "39 of the 45 orphans were linked; the other six are frozen in the baseline");

  const misplaced = [];
  for (const [hub, hubRoutes] of Object.entries(placed)) {
    for (const route of hubRoutes) {
      if (!routes.includes(route)) { misplaced.push(`${route} no longer exists as a page`); continue; }
      if (!linkers(route).includes(hub)) misplaced.push(`${route} is not linked from ${hub}`);
    }
  }
  assert.deepEqual(misplaced, []);
});
