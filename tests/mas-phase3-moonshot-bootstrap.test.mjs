import test from "node:test";
import assert from "node:assert/strict";
import {
  disabledCollarTelemetryChannel,
  disabledAmbientVisionDispatcher,
  disabledRpaExecutor,
} from "../lib/mas/phase3/index.ts";

test("Phase 3 IoT bootstrap fails closed", async () => {
  const result = await disabledCollarTelemetryChannel.ingest({deviceId:"dev",petId:"pet",observedAt:new Date(0).toISOString(),signalType:"activity",payload:{}});
  assert.deepEqual(result,{accepted:false,reason:"phase3_iot_not_enabled"});
});

test("Phase 3 ambient vision bootstrap fails closed", async () => {
  const result = await disabledAmbientVisionDispatcher.evaluate({sourceId:"camera",observedAt:new Date(0).toISOString(),mediaRef:"ref"});
  assert.deepEqual(result,{dispatched:false,reason:"phase3_vision_not_enabled"});
});

test("Phase 3 RPA bootstrap fails closed", async () => {
  const result = await disabledRpaExecutor.execute({system:"crm",action:"noop",correlationId:"corr",input:{}});
  assert.deepEqual(result,{executed:false,reason:"phase3_rpa_not_enabled"});
});
