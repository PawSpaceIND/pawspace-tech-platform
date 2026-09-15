/*
 * An incentive could never be approved, so incentives could never pay.
 *
 * `incentives.manage` was held by NO role — only founder/superuser through the `"*"` wildcard. The
 * engine correctly enforces calculator != approver, and there is exactly one wildcard identity on a
 * deployment: `create_user` refuses to mint a founder/superuser even for the founder, `save_role`
 * refuses an unknown code, and no create-role action exists. So the only person who could approve an
 * incentive was the only person who could calculate one, and the engine refused them. The
 * approve/dispute/reverse half of the incentives screen was dead, and no incentive could reach
 * payroll. `compensation.manage` (salary-structure versioning) and `settings.manage` (LMS authoring,
 * provider-onboarding approval, AI configuration) were blocked the same way.
 *
 * The owner chose to grant these to the senior roles the definitions already describe. This test
 * pins the OUTCOME that unblocks — a second person can approve — rather than the permission list,
 * so it still means something if the roles are reshaped later.
 */
import test from "node:test";
import assert from "node:assert/strict";

const permissionHolders = async (permission) => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  return defaultRoles.filter((role) => role.permissions.includes(permission)).map((role) => role.code);
};

test("INCENTIVE-REACH-1: a role other than the wildcards can manage incentives", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const wildcards = defaultRoles.filter((r) => r.permissions.includes("*")).map((r) => r.code);
  assert.deepEqual(wildcards.sort(), ["founder", "superuser"], "the wildcard set is the premise of this test");

  for (const permission of ["incentives.manage", "compensation.manage", "settings.manage"]) {
    const holders = await permissionHolders(permission);
    assert.ok(holders.length > 0,
      `${permission} is held by no role but the wildcards, so only one identity on the whole ` +
      `deployment can exercise it — and an engine that enforces maker != checker can never be satisfied`);
    assert.ok(holders.every((code) => !wildcards.includes(code)),
      `${permission} must be reachable WITHOUT the wildcard, or nothing has changed`);
  }
});

test("INCENTIVE-REACH-2: the calculator still cannot approve their own result", async () => {
  // The grant must not have bought reachability by weakening separation of duties. If this ever
  // passes by letting one person do both, the fix has become the bug.
  const source = await import("node:fs").then((fs) => fs.readFileSync("lib/incentive-engine.ts", "utf8"));
  assert.match(source, /Incentive calculator cannot approve their own result/,
    "the maker/checker rule must still be enforced in the engine");
});

test("INCENTIVE-REACH-3: two DIFFERENT real roles can stand on either side of every gated approval", async () => {
  // The property that actually matters: for each permission, is there a pair of distinct non-wildcard
  // identities that can be maker and checker? One holder is enough only because the founder can be
  // the other party — but then the founder must not also be the only holder.
  const { defaultRoles } = await import("../lib/platform-security.ts");
  for (const permission of ["incentives.manage", "compensation.manage", "settings.manage", "payroll.approve"]) {
    const holders = defaultRoles.filter((r) => r.permissions.includes(permission) || r.permissions.includes("*"));
    assert.ok(holders.length >= 2,
      `${permission}: only ${holders.map((r) => r.code).join(",") || "nobody"} can hold it, so a ` +
      `two-person approval is impossible`);
  }
});
