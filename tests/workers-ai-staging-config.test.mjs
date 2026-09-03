import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("generated staging config persists Workers AI beside the isolated staging D1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workers-ai-stage-config-"));
  fs.mkdirSync(path.join(dir, "dist", "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "server", "wrangler.json"), JSON.stringify({ name: "build-output", vars: {} }));
  const generatedValue = character => character.repeat(32);
  execFileSync(process.execPath, [new URL("../scripts/stage-config.mjs", import.meta.url).pathname], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      STAGING_D1_ID: "isolated-staging-d1-id",
      PAWSPACE_UAT_ACCESS_CODE: generatedValue("a"),
      PAWSPACE_UAT_SIGNING_KEY: generatedValue("b"),
      PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: generatedValue("c"),
    },
    stdio: "ignore",
  });
  const config = JSON.parse(fs.readFileSync(path.join(dir, "dist", "server", "wrangler.json"), "utf8"));

  assert.deepEqual(config.ai, { binding: "AI" }, "there must be exactly one Workers AI binding named AI");
  assert.deepEqual(config.d1_databases, [{
    binding: "DB", database_name: "pawspace-staging", database_id: "isolated-staging-d1-id",
  }]);
  assert.equal(config.name, "pawspace-staging");
  assert.equal(config.topLevelName, "pawspace-staging");
  assert.equal(config.vars.PAWSPACE_PAYMENT_ENV, "sandbox");
  assert.equal(config.vars.PAWSPACE_COMMUNICATION_ENV, "uat");
  assert.ok(!("VOICE_STT_API_KEY" in config.vars));
  assert.ok(!("VOICE_TTS_API_KEY" in config.vars));
});
