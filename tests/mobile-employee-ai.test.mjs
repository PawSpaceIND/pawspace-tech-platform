import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("mobile employee AI is server-authorized and defense-in-depth gated", () => {
  const route = source("app/api/mobile-employee-ai/route.ts");
  const gateway = source("lib/api-gateway.ts");
  assert.match(route, /requirePermission\(actor,"customers\.manage"\)/);
  assert.match(route, /requirePermission\(actor,"communications\.message"\)/);
  assert.match(route, /communications\.call/);
  assert.match(route, /runAuthenticatedAiWebChat/);
  assert.match(route, /mobile\.employee_ai\.bootstrap/);
  assert.match(route, /mobile\.employee_ai\.chat/);
  assert.match(gateway, /\/api\/mobile-employee-ai"\)return "customers\.manage"/);
});

test("mobile shell exposes Employee AI only after server authorization", () => {
  const page = source("app/mobile-app/page.tsx");
  assert.match(page, /fetch\("\/api\/mobile-employee-ai"/);
  assert.match(page, /setEmployeeAiAvailable\(response\.ok\)/);
  assert.match(page, /employeeAiAvailable&&<EmployeeAiMobile\/>/);
  assert.match(page, /employeeAiAvailable\?\[\["employee_ai","✦","AI"\]\]:\[\]/);
});

test("employee AI mobile chat stays canonical and idempotent", () => {
  const ui = source("app/mobile-app/employee-ai-mobile.tsx");
  assert.match(ui, /action:"chat"/);
  assert.match(ui, /crypto\.randomUUID\(\)/);
  assert.match(ui, /customerId/);
  assert.match(ui, /Money and sensitive actions remain approval-gated/);
});

test("employee AI mobile embeds governed voice transport", () => {
  const ui = source("app/mobile-app/employee-ai-mobile.tsx");
  assert.match(ui, /\/api\/voice-outbound\?scope=ai_browser_test/);
  assert.match(ui, /uat_ai_browser_ticket/);
  assert.match(ui, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(ui, /new WebSocket\(ticket\.wsUrl\)/);
  assert.match(ui, /type:"stop"/);
  assert.match(ui, /setTranscript/);
  assert.match(ui, /setReply/);
});

test("native customer shells declare microphone permission for employee AI voice", () => {
  const android = source("android/app/src/main/AndroidManifest.xml");
  const ios = source("ios/App/App/Info.plist");
  assert.match(android, /android\.permission\.RECORD_AUDIO/);
  assert.match(ios, /NSMicrophoneUsageDescription/);
  assert.match(ios, /authorized employee starts an AI Voice session/);
});

test("customer Capacitor target still points at the shared mobile app surface", () => {
  const config = source("capacitor.customer.config.ts");
  assert.match(config, /appId: "com\.pawspace\.customer"/);
  assert.match(config, /pathname !== "\/mobile-app"/);
});
