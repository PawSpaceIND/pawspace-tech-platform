import {assertEmbeddedPayrollBridge} from './helpers/payroll-shell-review.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {customerScopedHref,isV2CustomerPath} from "../lib/v2/route-scope.ts";

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const bridges = {
  "app/v2/team/page.tsx": "../../team/page",
  "app/v2/team/sales/page.tsx": "../../../team/sales/page",
  "app/v2/team/customer-experience/page.tsx": "../../../team/customer-experience/page",
  "app/v2/team/finance/page.tsx": "../../../team/finance/page",
  "app/v2/team/marketing/page.tsx": "../../../team/marketing/page",
  "app/v2/team/operations/page.tsx": "../../../team/operations/page",
  "app/v2/team/voice/page.tsx": "../../../team/voice/page",
  "app/v2/team/ai/page.tsx": "../../../team/ai/page",
  "app/v2/team/whatsapp/page.tsx": "../../../team/whatsapp/page",
  "app/v2/team/provider-onboarding/page.tsx": "../../../team/provider-onboarding/page",
  "app/v2/team/provider-verification/page.tsx": "../../../team/provider-verification/page",
  "app/v2/team/pricing-rules/page.tsx": "../../../team/pricing-rules/page",
  "app/v2/team/subscriptions/page.tsx": "../../../team/subscriptions/page",
  "app/v2/team/customer-reminders/page.tsx": "../../../team/customer-reminders/page",
  "app/v2/team/analytics/page.tsx": "../../../team/analytics/page",
  "app/v2/team/acquisition-funnel/page.tsx": "../../../team/acquisition-funnel/page",
};

test("V2 exposes canonical V1 staff modules without forking their business logic", () => {
  for (const [file, target] of Object.entries(bridges)) {
    const source = read(file);
    assert.match(source, new RegExp(`export \\{ default \\} from [\"']${target.replaceAll("/", "\\/")}[\"']`), file);
  }
});

test("V2 workspace hub exposes the restored primary staff workspaces", () => {
  const hub = read("app/v2/workspaces/page.tsx");
  for (const href of [
    "/v2/team",
    "/v2/team/sales",
    "/v2/team/customer-experience",
    "/v2/team/finance",
    "/v2/team/operations",
    "/v2/team/marketing",
  ]) assert.match(hub, new RegExp(`href:\"${href.replaceAll("/", "\\/")}\"`));
});

test("People, payroll and scheduling reuse canonical V1 surfaces through V2 bridges", () => {
  for (const rel of ["app/v2/team/people/page.tsx", "app/v2/team/scheduling/page.tsx", "app/v2/team/people/payroll/page.tsx"]) {
    assert.equal(fs.existsSync(new URL(`../${rel}`, import.meta.url)), true, rel);
    if(rel==='app/v2/team/people/payroll/page.tsx')assertEmbeddedPayrollBridge(read(rel));
    else assert.match(read(rel), /export \{ default \} from/);
  }
});
test("V2 routing module executes for parity coverage",()=>{assert.equal(isV2CustomerPath("/v2/team/people"),true);assert.equal(customerScopedHref("/v2/training","/training"),"/v2/training");});
