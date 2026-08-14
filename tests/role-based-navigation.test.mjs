// Role-based navigation: the Team hub and Control panel must show a role only the surfaces it can
// actually open — not every module to everyone (which then dead-ends on "Permission denied").
//
// Two guarantees are pinned here:
//   1. Both pages FILTER their menu by the signed-in actor's permissions (source-level), and the
//      Team overview API now carries those permissions.
//   2. The permissions CHOSEN for each tile/view actually differentiate the seeded roles the way we
//      intend — Founder sees everything, Finance can't see CRM/People, Manager can't see Finance, etc.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const { defaultRoles, hasPermission } = await import("../lib/platform-security.ts");

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const permsOf = (code) => defaultRoles.find((r) => r.code === code).permissions;

// The tile → required-permission map, mirroring app/team/page.tsx.
const TEAM_TILES = {
  "Revenue & CRM": "customers.view", "Daily revenue priority": "customers.view", "Customer reminders": "customers.view",
  "Bookings & delivery": "bookings.view", "Tickets & recovery": "customers.view", "Accounts & collections": "finance.view",
  "HR & performance": "people.view", "Assistant & handoff": "reports.view", "Segments & campaigns": "marketing.view",
};
const visibleTiles = (roleCode) => Object.entries(TEAM_TILES).filter(([, p]) => hasPermission(permsOf(roleCode), p)).map(([t]) => t);

test("the Team overview API carries the actor's permissions to the page", () => {
  assert.match(read("lib/team-overview.ts"), /permissions:\s*input\.permissions/, "buildTeamOverview must include permissions in the actor");
  assert.match(read("app/api/team-overview/route.ts"), /permissions:\s*actor\.permissions/, "the route must pass the actor's permissions");
});

test("the Team hub filters its workspaces by the role's permissions (no unfiltered menu)", () => {
  const page = read("app/team/page.tsx");
  assert.match(page, /visibleWorkspaces\s*=\s*data\s*\?\s*workspaces\.filter/, "workspaces must be filtered by permission");
  assert.match(page, /hasPermission\(data\.actor\.permissions/, "filtering uses the actor's permissions");
  assert.ok(!/\bworkspaces\.map\(/.test(page), "the raw workspaces list must not be rendered unfiltered");
});

test("the Control panel filters its side-nav by the role's permissions", () => {
  const page = read("app/control/page.tsx");
  assert.match(page, /visibleNav\s*=\s*approvals\.loaded\s*\?\s*nav\.filter/, "nav must be filtered by permission");
  assert.match(page, /visibleNav\.map\(/, "the filtered nav is what renders");
  assert.ok(!/\{nav\.map\(/.test(page), "the raw nav must not be rendered unfiltered");
});

test("Founder and Superuser see every Team workspace", () => {
  for (const role of ["founder", "superuser"]) assert.equal(visibleTiles(role).length, Object.keys(TEAM_TILES).length, `${role} sees all tiles`);
});

test("non-owner roles see only their own workspaces, not everything", () => {
  const finance = visibleTiles("finance");
  assert.ok(finance.includes("Accounts & collections"), "Finance sees Finance");
  assert.ok(!finance.includes("Revenue & CRM"), "Finance does NOT see CRM");
  assert.ok(!finance.includes("HR & performance"), "Finance does NOT see People");

  const manager = visibleTiles("manager");
  assert.ok(manager.includes("Bookings & delivery") && manager.includes("Revenue & CRM"), "Manager sees Ops + CRM");
  assert.ok(!manager.includes("Accounts & collections"), "Manager does NOT see Finance");

  const associate = visibleTiles("associate");
  assert.ok(associate.includes("Revenue & CRM"), "Associate sees CRM");
  assert.ok(!associate.includes("Accounts & collections") && !associate.includes("HR & performance"), "Associate is limited");

  // Every non-owner role sees strictly fewer tiles than the owner.
  for (const role of ["finance", "manager", "associate", "service_provider", "auditor"]) {
    assert.ok(visibleTiles(role).length < Object.keys(TEAM_TILES).length, `${role} must not see every tile`);
  }
});

test("only roles with users.manage can see the Control 'Users, roles & access' surface", () => {
  // access2 view requires users.manage — held by founder/superuser and admin, not manager/associate/finance.
  assert.equal(hasPermission(permsOf("manager"), "users.manage"), false);
  assert.equal(hasPermission(permsOf("associate"), "users.manage"), false);
  assert.equal(hasPermission(permsOf("finance"), "users.manage"), false);
  assert.equal(hasPermission(permsOf("founder"), "users.manage"), true);
});
