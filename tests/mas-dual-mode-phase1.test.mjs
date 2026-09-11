import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {activeGoalContext} from "../lib/goal-context-engine.ts";

test("GCE migration pins dual-mode autonomy and governed envelopes",()=>{
 assert.equal(typeof activeGoalContext,"function");
 const sql=readFileSync(new URL("../drizzle/0033_goal_context_dual_mode_mas.sql",import.meta.url),"utf8");
 assert.match(sql,/autonomy_mode TEXT NOT NULL DEFAULT 'recommend'/);
 assert.match(sql,/recommend','approval_required','execute_within_envelope/);
 assert.match(sql,/CREATE TABLE IF NOT EXISTS gce_budget_envelopes/);
 assert.match(sql,/CREATE TABLE IF NOT EXISTS gce_constraints/);
});

test("Head of Sales prompt forbids authoritative hallucination and preserves Human Staff",()=>{
 const sales=readFileSync(new URL("../lib/agents/sales-head.ts",import.meta.url),"utf8");
 assert.match(sales,/HEAD_OF_SALES_MODEL="claude-sonnet-4-6"/);
 assert.match(sales,/Never invent or infer prices, taxes, payment amounts/i);
 assert.match(sales,/Human Staff remains a first-class operating mode/i);
});

test("Atlas Sales tools expose no model-controlled payment amount",()=>{
 const gateway=readFileSync(new URL("../lib/atlas-tool-gateway.ts",import.meta.url),"utf8");
 const payment=gateway.match(/"sales\.payment_link\.create":\{[\s\S]*?required:\["bookingId","customerId"\]\}\}/)?.[0]||"";
 assert.ok(payment);
 assert.doesNotMatch(payment,/amountPaise|totalAmount|paymentStatus/);
 assert.doesNotMatch(payment,/properties:\{[^}]*amount:/);
});

test("human and AI payment paths share the canonical payment-order function",()=>{
 const human=readFileSync(new URL("../app/api/payment-order/route.ts",import.meta.url),"utf8");
 const core=readFileSync(new URL("../lib/sales-core-tools.ts",import.meta.url),"utf8");
 assert.match(human,/createBookingPaymentOrder/);
 assert.match(core,/createBookingPaymentOrder/);
});

test("human Assisted Orders and AI quote registry share canonical quote core",()=>{
 const human=readFileSync(new URL("../app/api/assisted-orders/route.ts",import.meta.url),"utf8");
 const ai=readFileSync(new URL("../lib/ai-tool-registry.ts",import.meta.url),"utf8");
 assert.match(human,/generateCanonicalSalesQuote/);
 assert.match(ai,/generateCanonicalSalesQuote/);
});


test("global kill switch is evaluated before every AI tool executes",()=>{
 const gateway=readFileSync(new URL("../lib/atlas-tool-gateway.ts",import.meta.url),"utf8");
 const kill=gateway.indexOf("atlasAiExecutionEnabled(db,input.env)");
 const quote=gateway.indexOf('input.toolCode==="sales.quote.generate"');
 assert.ok(kill>0&&quote>kill);
 assert.match(gateway,/AI executive is disabled; workflow routed to Human Staff/);
});
