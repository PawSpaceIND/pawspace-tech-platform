import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  ProductionConfigurationError,
  PRODUCTION_SERVICE_REGISTRY,
  assertProductionReadiness,
  collectProductionReadinessProblems,
} from "../lib/production-readiness-enforcement.mjs";

const goodIdfy = {
  DEPLOYMENT_PROFILE: "production",
  IDFY_API_KEY: "test-key",
  IDFY_ACCOUNT_ID: "test-account",
  IDFY_URL: "https://api.idfy.com/v3/tasks",
  IDFY_WEBHOOK_SECRET: "test-webhook-secret",
  PRODUCTION_R2_BUCKET_NAME: "pawspace-private-production",
  CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
  CLOUDFLARE_ACCOUNT_ID: "test-cloudflare-account",
};

const healthyRegistry = [{
  id: "healthy",
  driver: "production_http",
  requiredSecrets: ["SERVICE_SECRET"],
  requiredConfig: ["SERVICE_URL"],
  handlers: [{ name: "request", state: "implemented" }],
}];

test("non-production profiles are not subject to production-only enforcement", () => {
  assert.deepEqual(assertProductionReadiness({ NODE_ENV: "test" }, healthyRegistry), {
    ok: true, enforced: false, profile: "test",
  });
});

test("a fully configured production service registry can pass", () => {
  assert.deepEqual(assertProductionReadiness({ DEPLOYMENT_PROFILE: "production", SERVICE_SECRET: "s", SERVICE_URL: "https://service.example" }, healthyRegistry), {
    ok: true, enforced: true, profile: "production", servicesChecked: 1,
  });
});

test("production rejects mock or sandbox drivers", () => {
  const registry = [{ id: "database", driverEnv: "DATABASE_DRIVER", handlers: [{ name: "connect", state: "implemented" }] }];
  assert.throws(
    () => assertProductionReadiness({ DEPLOYMENT_PROFILE: "production", DATABASE_DRIVER: "memory" }, registry),
    (error) => error instanceof ProductionConfigurationError && /database: production driver 'memory' is mock or sandbox-only/.test(error.message),
  );
});

test("production rejects unbuilt handlers even when credentials are present", () => {
  const registry = [{ id: "documents", driver: "r2", handlers: [{ name: "upload", state: "missing" }] }];
  assert.throws(
    () => assertProductionReadiness({ DEPLOYMENT_PROFILE: "production" }, registry),
    (error) => error instanceof ProductionConfigurationError && /handler upload is missing/.test(error.message),
  );
});

test("every IDfy production credential is individually load-bearing", () => {
  for (const name of ["IDFY_API_KEY", "IDFY_ACCOUNT_ID", "IDFY_URL", "IDFY_WEBHOOK_SECRET"]) {
    const env = { ...goodIdfy };
    delete env[name];
    const problems = collectProductionReadinessProblems(env, [PRODUCTION_SERVICE_REGISTRY[0]]);
    assert.ok(problems.some((problem) => problem.includes(name)), `${name} must be named in the refusal`);
  }
});

test("IDfy refuses non-production endpoint configuration", () => {
  const problems = collectProductionReadinessProblems({ ...goodIdfy, IDFY_URL: "http://localhost:9000/tasks" }, [PRODUCTION_SERVICE_REGISTRY[0]]);
  assert.ok(problems.some((problem) => /must use https/.test(problem)));
  assert.ok(problems.some((problem) => /non-production host/.test(problem)));
});

test("private R2 storage requires deployment credentials and a production bucket", () => {
  const storage = PRODUCTION_SERVICE_REGISTRY[1];
  const base = { DEPLOYMENT_PROFILE: "production" };
  const problems = collectProductionReadinessProblems(base, [storage]);
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "PRODUCTION_R2_BUCKET_NAME"]) {
    assert.ok(problems.some((problem) => problem.includes(name)), `${name} must be required`);
  }
  assert.ok(problems.some((problem) => /server_owned_secure_upload is missing/.test(problem)));
});

test("current provider agreement path is explicitly blocked as UAT/mock", () => {
  const problems = collectProductionReadinessProblems(goodIdfy, [PRODUCTION_SERVICE_REGISTRY[2]]);
  assert.ok(problems.some((problem) => /uat_mock.*mock or sandbox-only/.test(problem)));
  assert.ok(problems.some((problem) => /verified_digital_esign is mock/.test(problem)));
});

test("the canonical production registry fails hard on today's real onboarding blockers", () => {
  assert.throws(
    () => assertProductionReadiness(goodIdfy),
    (error) => error instanceof ProductionConfigurationError
      && error.code === "PRODUCTION_CONFIGURATION_ERROR"
      && error.problems.some((problem) => /server_owned_secure_upload is missing/.test(problem))
      && error.problems.some((problem) => /verified_digital_esign is mock/.test(problem)),
  );
});

test("the command-line production guard exits non-zero and emits the explicit configuration error", () => {
  const result = spawnSync(process.execPath, [new URL("../scripts/assert-production-readiness.mjs", import.meta.url).pathname], {
    env: { ...process.env, ...goodIdfy }, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PRODUCTION_CONFIGURATION_ERROR/);
  assert.match(result.stderr, /server_owned_secure_upload is missing/);
});
