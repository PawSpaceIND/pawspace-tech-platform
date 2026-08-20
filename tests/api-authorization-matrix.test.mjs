import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import matrix from "../security/api-authorization-matrix.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const baseline = JSON.parse(await readFile(new URL("../security/api-authorization-policy-baseline.json", import.meta.url), "utf8"));
const gateway = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
const sessionGateway = await readFile(new URL("../lib/session-api-gateway.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function row(route, method) {
  const found = matrix.find((entry) => entry.route === route && entry.method === method);
  assert.ok(found, `missing matrix row for ${method} ${route}`);
  return found;
}

test("the committed executable matrix classifies every generated route/method exactly once", () => {
  assert.ok(matrix.length > 0, "authorization matrix must not be empty");
  const pairs = matrix.map((entry) => `${entry.method} ${entry.route}`);
  assert.equal(new Set(pairs).size, pairs.length, "duplicate route/method authorization rows are forbidden");
  for (const entry of matrix) {
    assert.match(entry.route, /^\/api\//);
    assert.match(entry.method, /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/);
    assert.ok(entry.permission, `${entry.method} ${entry.route} lacks a permission decision`);
    assert.ok(entry.permissionOptions.length > 0, `${entry.method} ${entry.route} lacks permission options`);
    assert.ok(entry.enforcementLayers.includes("worker-gateway"), `${entry.method} ${entry.route} is not tied to Worker gateway enforcement`);
  }
});

test("authorization source fingerprints are review-gated in CI", () => {
  const actual = {
    "app/api": git("rev-parse", "HEAD:app/api"),
    "lib/api-gateway.ts": git("hash-object", "lib/api-gateway.ts"),
    "lib/session-api-gateway.ts": git("hash-object", "lib/session-api-gateway.ts"),
    "lib/server-auth.ts": git("hash-object", "lib/server-auth.ts"),
    "lib/platform-security.ts": git("hash-object", "lib/platform-security.ts"),
    "worker/index.ts": git("hash-object", "worker/index.ts"),
  };
  assert.deepEqual(
    actual,
    baseline.fingerprints,
    "API authorization surface changed. Regenerate the matrix, review route/method/permission/ownership changes, then intentionally update the #201 baseline.",
  );
});

test("requiredPermission has one production definition and both enforcement paths consume it", () => {
  const definitions = git(
    "grep",
    "-l",
    "function requiredPermission",
    "--",
    ":(glob)app/api/**/*.ts",
    ":(glob)lib/**/*.ts",
    ":(glob)worker/**/*.ts",
  ).split("\n").filter(Boolean);
  assert.deepEqual(definitions, ["lib/api-gateway.ts"], "a second production requiredPermission implementation appeared");
  assert.match(gateway, /export\s+async\s+function\s+requiredPermission\s*\(/);
  assert.match(sessionGateway, /import\s*\{[^}]*requiredPermission[^}]*\}\s*from\s*["']\.\/api-gateway["']/);
  assert.match(sessionGateway, /await\s+requiredPermission\s*\(request\)/);
  assert.match(worker, /authorizePlatformSessionRequest/);
  assert.match(worker, /authorizeApiRequest/);
  assert.ok(
    worker.indexOf("authorizePlatformSessionRequest") < worker.lastIndexOf("authorizeApiRequest"),
    "Worker must retain platform-session scope enforcement before the authoritative gateway fallback",
  );
});

test("read and write decisions are explicit for the #201 launch blockers", () => {
  assert.equal(row("/api/training-requirements", "GET").permission, "public");
  for (const entry of matrix.filter((item) => item.route === "/api/training-requirements" && item.stateChanging)) {
    assert.equal(entry.access, "protected", `${entry.method} /api/training-requirements must not be public`);
    assert.ok(entry.permissionOptions.includes("pricing.manage"));
  }

  assert.equal(row("/api/host-trust", "GET").permission, "public");
  for (const entry of matrix.filter((item) => item.route === "/api/host-trust" && item.stateChanging)) {
    assert.equal(entry.access, "protected", `${entry.method} /api/host-trust must not be public`);
    assert.ok(entry.permissionOptions.some((permission) => permission !== "public"));
  }

  assert.equal(row("/api/canonical-bookings", "GET").permission, "bookings.view");
  assert.equal(row("/api/canonical-bookings", "POST").permission, "scheduling.book");
});

test("ownership-classified rows name their enforcement source", () => {
  const owned = matrix.filter((entry) => !entry.ownershipOptions.includes("none"));
  assert.ok(owned.length > 0, "matrix must contain ownership-classified routes");
  for (const entry of owned) {
    assert.ok(entry.ownershipSources.length > 0, `${entry.method} ${entry.route} lacks an ownership enforcement source`);
    if (entry.ownershipSources.includes("route")) assert.ok(entry.enforcementLayers.includes("route-guard"));
    if (entry.ownershipSources.includes("session")) assert.ok(entry.enforcementLayers.includes("session-scope"));
  }
});

test("direct route permission checks cannot silently disagree with their gateway clause", () => {
  for (const entry of matrix) {
    for (const direct of entry.routePermissionChecks) {
      assert.ok(
        entry.permissionOptions.includes(direct),
        `${entry.method} ${entry.route} has direct route permission ${direct} outside authoritative gateway outcomes ${entry.permissionOptions.join(", ")}`,
      );
    }
  }
});
