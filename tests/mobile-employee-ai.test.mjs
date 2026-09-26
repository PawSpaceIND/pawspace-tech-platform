import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { d1 } from "./helpers/execution-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__MOBILE_EMPLOYEE_AI_DB__", "__MOBILE_EMPLOYEE_AI_ENV__");
const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("mobile employee AI is server-authorized and defense-in-depth gated", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = d1(sqlite);
  globalThis.__MOBILE_EMPLOYEE_AI_DB__ = db;
  globalThis.__MOBILE_EMPLOYEE_AI_ENV__ = {};
  const denied = await authorizeApiRequest(new Request("https://uat.pawspace.in/api/mobile-employee-ai"), { DB: db });
  assert.ok(denied instanceof Response);
  assert.equal(denied.status, 401);
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
  const css = source("app/mobile-app/mobile.module.css");
  assert.match(page, /fetch\("\/api\/mobile-employee-ai"/);
  assert.match(page, /setEmployeeAiAvailable\(response\.ok\)/);
  assert.match(page, /employeeAiAvailable&&<EmployeeAiMobile\/>/);
  assert.match(page, /employeeAiAvailable\?\[\["employee_ai","✦","AI"\]\]:\[\]/);
  assert.match(page, /data-employee-ai=\{employeeAiAvailable\?"enabled":"disabled"\}/);
  assert.match(page, /aria-label=\{item\[2\]\}/);
  assert.match(page, /<i aria-hidden="true">\{item\[1\]\}<\/i>/);
  assert.match(css, /\.phone>nav\[data-employee-ai="enabled"\]\{grid-template-columns:repeat\(6,minmax\(0,1fr\)\)\}/);
  assert.match(css, /\.phone>nav\{[^}]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  const convergence = source("app/prototype-convergence.css");
  assert.match(convergence, /:has\(\[data-location-welcome\]\)>nav:not\(\[data-employee-ai="enabled"\]\)\{display:none!important\}/);
  assert.doesNotMatch(convergence, /:has\(\[data-location-welcome\]\)>nav\{display:none!important\}/);
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

test("customer Capacitor target points at the V2 customer surface", () => {
  const config = source("capacitor.customer.config.ts");
  assert.match(config, /appId: "com\.pawspace\.customer"/);
  assert.match(config, /pathname !== "\/v2"/);
  assert.doesNotMatch(config, /mobile-app/);
});
