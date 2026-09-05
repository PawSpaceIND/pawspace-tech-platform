import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import {
  ensureAiBusinessConfiguration,
  setAiKillSwitch,
  resolveActiveAiBusinessConfig,
} from "../lib/ai-business-configuration.ts";

test("P0 DR: global and channel kill switches fail closed and recover cleanly", async (t) => {
  const harness = freshCountingD1();
  t.after(() => harness.sqlite.close());
  await ensureAiBusinessConfiguration(harness.db);

  const base = { channel: "whatsapp", intent: "booking", provider: "meta", model: "workers-ai" };
  const healthy = await resolveActiveAiBusinessConfig(harness.db, base);
  assert.equal(healthy.enabled, true, "AI starts enabled when no matching kill switch is active");

  await setAiKillSwitch(harness.db, {
    scopeType: "global",
    scopeKey: "ai",
    disabled: true,
    reason: "P0 rollback drill",
    actorEmail: "p0-drill@pawspace.test",
  });
  const globallyDisabled = await resolveActiveAiBusinessConfig(harness.db, base);
  assert.equal(globallyDisabled.enabled, false, "global kill switch must disable the runtime");
  assert.equal(globallyDisabled.killSwitches.some((item) => item.scopeType === "global" && item.scopeKey === "ai"), true);

  await setAiKillSwitch(harness.db, {
    scopeType: "global",
    scopeKey: "ai",
    disabled: false,
    reason: "re-enabled after drill",
    actorEmail: "p0-drill@pawspace.test",
  });
  const restored = await resolveActiveAiBusinessConfig(harness.db, base);
  assert.equal(restored.enabled, true, "re-enabling the global switch restores the runtime");

  await setAiKillSwitch(harness.db, {
    scopeType: "channel",
    scopeKey: "whatsapp",
    disabled: true,
    reason: "isolate whatsapp during provider incident",
    actorEmail: "p0-drill@pawspace.test",
  });
  const whatsappDisabled = await resolveActiveAiBusinessConfig(harness.db, base);
  const webStillHealthy = await resolveActiveAiBusinessConfig(harness.db, { ...base, channel: "web" });
  assert.equal(whatsappDisabled.enabled, false, "channel kill switch blocks the affected channel");
  assert.equal(webStillHealthy.enabled, true, "channel kill switch does not disable unrelated channels");

  const auditRows = harness.sqlite.prepare("SELECT action,entity_id FROM ai_config_audit_events ORDER BY created_at").all();
  assert.equal(auditRows.some((row) => row.action === "kill_switch_disabled" && row.entity_id === "global:ai"), true);
  assert.equal(auditRows.some((row) => row.action === "kill_switch_enabled" && row.entity_id === "global:ai"), true);
  assert.equal(auditRows.some((row) => row.action === "kill_switch_disabled" && row.entity_id === "channel:whatsapp"), true);
});
