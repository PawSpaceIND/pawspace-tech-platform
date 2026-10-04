import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("ordinary staging declares approved Workers speech models without a voice overlay", () => {
  const dir = mkdtempSync(join(tmpdir(), "staging-workers-speech-"));
  try {
    mkdirSync(join(dir, "dist/server"), { recursive: true });
    const configPath = join(dir, "dist/server/wrangler.json");
    writeFileSync(configPath, JSON.stringify({ vars: { VOICE_STT_MODEL: "unapproved", VOICE_CARRIER_TTS_MODEL: "unapproved", PAWSPACE_LOCAL_PREVIEW: "on" } }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../scripts/stage-config.mjs", import.meta.url))], {
      cwd: dir, encoding: "utf8", env: {
        PATH: process.env.PATH,
        STAGING_D1_ID: "11111111-1111-4111-8111-111111111111",
        PAWSPACE_UAT_ACCESS_CODE: "x".repeat(32),
        PAWSPACE_UAT_SIGNING_KEY: "y".repeat(32),
        PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "z".repeat(32),
        PAWSPACE_VOICE_PHONE_TESTS_PAUSED: "true",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.ai, { binding: "AI" });
    assert.equal(config.vars.VOICE_STT_MODEL, "@cf/openai/whisper-large-v3-turbo");
    assert.equal(config.vars.VOICE_CARRIER_TTS_MODEL, "@cf/deepgram/aura-2-en");
    assert.equal(config.vars.PAWSPACE_VOICE_PHONE_TESTS_PAUSED, "true");
    assert.equal(config.vars.PAWSPACE_VOICE_UAT_APPROVED, "false");
    assert.equal(config.vars.FORBID_PRODUCTION, "true");
    assert.equal(config.vars.PAWSPACE_PAYMENT_LIVE_APPROVED, "false");
    assert.equal(config.vars.PAWSPACE_LOCAL_PREVIEW, undefined);
    assert.equal(config.vars.PAWSPACE_UAT_ACCESS_CODE, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
