import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const wallet=read("lib/subscription-wallet.ts"),route=read("app/api/subscription-wallet/route.ts"),client=read("lib/subscription-wallet-client.ts"),page=read("app/team/subscriptions/page.tsx"),gateway=read("lib/api-gateway.ts"),lifecycle=read("app/api/grooming-lifecycle/route.ts");

test("subscription wallet keeps one canonical credit ledger",()=>{assert.match(wallet,/customer_grooming_subscriptions/);assert.match(wallet,/booking_subscription_usage/);assert.match(wallet,/subscription_wallet_events/);assert.match(wallet,/idempotency_key TEXT NOT NULL UNIQUE/);assert.match(wallet,/balances:\{total,reserved,consumed,available\}/);assert.match(wallet,/Math\.max\(0,total-reserved-consumed\)/);});

test("credit reservation is bounded and booking/customer owned",()=>{assert.match(wallet,/Subscription does not have enough available credits/);assert.match(wallet,/Booking and subscription customer do not match/);assert.match(wallet,/service_code\)!=="grooming"/);assert.match(wallet,/sessions_reserved\+sessions_consumed\+\?<=total_sessions/);assert.match(wallet,/Booking already has a subscription reservation/);});

test("credits consume only after canonical completion and release only before completion",()=>{assert.match(wallet,/Credits can only be consumed after canonical service completion/);assert.match(wallet,/Consumed\/completed service credits cannot be released/);assert.match(wallet,/status='consumed'/);assert.match(wallet,/status='released'/);assert.match(lifecycle,/UPDATE booking_subscription_usage SET sessions_consumed=sessions_reserved,status='consumed'/);});

test("pause resume expiry and renewal remain governed rather than invented",()=>{assert.match(wallet,/configured pause entitlement/);assert.match(wallet,/Pause reason is required/);assert.match(wallet,/status='paused'/);assert.match(wallet,/status='active'/);assert.match(wallet,/status='expired'/);assert.match(wallet,/autoRenewal:false/);assert.match(wallet,/renewalPricing:"configuration_required"/);assert.match(wallet,/expiryExtension:"policy_required"/);});

test("subscription API separates customer and staff authority and stays test-only",()=>{assert.match(route,/new Set<SubscriptionWalletAction>\(\["reserve","pause","resume"\]\)/);assert.match(route,/requireCustomerOwnership/);assert.match(route,/requirePermission\(actor,"bookings\.manage"\)/);assert.match(route,/securityAudit\(db,actor,`subscription_wallet\.\$\{action\}`/);assert.match(route,/testOnly:true/);assert.match(route,/liveMoney:false/);assert.match(gateway,/url\.pathname==="\/api\/subscription-wallet"/);assert.match(gateway,/\["reserve","pause","resume"\]/);});

test("UAT workspace exposes real balances without enabling auto renewal",()=>{assert.match(client,/\/api\/subscription-wallet/);assert.match(page,/Canonical Subscription Wallet/);assert.match(page,/Reserve 1 credit/);assert.match(page,/Release reservation/);assert.match(page,/Pause 1 UAT day/);assert.match(page,/Auto-renewal: OFF/);assert.match(page,/No renewal charge or live money/);});
