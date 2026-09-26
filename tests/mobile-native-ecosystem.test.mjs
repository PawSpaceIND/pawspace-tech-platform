import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer } from "./helpers/ai-harness.mjs";

process.env.APP_ENV = process.env.APP_ENV || "staging";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.PAWSPACE_PAYMENT_ENV = process.env.PAWSPACE_PAYMENT_ENV || "sandbox";
process.env.FORBID_PRODUCTION = process.env.FORBID_PRODUCTION || "true";
process.env.PAWSPACE_PAYMENT_LIVE_APPROVED = process.env.PAWSPACE_PAYMENT_LIVE_APPROVED || "false";

assert.equal(process.env.PAWSPACE_PAYMENT_ENV, "sandbox", "suite must run with PAWSPACE_PAYMENT_ENV=sandbox");
assert.equal(process.env.FORBID_PRODUCTION, "true", "suite must run with FORBID_PRODUCTION=true");
assert.equal(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED, "false", "suite must run with PAWSPACE_PAYMENT_LIVE_APPROVED=false");

installAiHooks();

test("Capacitor dual-target configuration exports distinct customer and partner identifiers", async () => {
  const customerConfig = (await import("../capacitor.customer.config.ts")).default;
  const partnerConfig = (await import("../capacitor.partner.config.ts")).default;

  assert.equal(customerConfig.appId, "com.pawspace.customer");
  assert.equal(customerConfig.appName, "PawSpaceCustomer");
  assert.equal(customerConfig.webDir, "native/customer-shell");

  assert.equal(partnerConfig.appId, "com.pawspace.partner");
  assert.equal(partnerConfig.appName, "PawSpacePartner");
  assert.equal(partnerConfig.webDir, "native/partner-shell");

  assert.notEqual(customerConfig.appId, partnerConfig.appId);
  assert.notEqual(customerConfig.appName, partnerConfig.appName);
});

test("Mobile native bridge exports device modules and handles web fallbacks", async () => {
  const { PawSpaceDevice, checkGeolocationPermission, checkPushPermissions } = await import("../lib/mobile/index.ts");

  assert.equal(typeof PawSpaceDevice.isNative, "function");
  assert.equal(typeof PawSpaceDevice.getPlatform, "function");
  assert.equal(PawSpaceDevice.isNative(), false, "Node test runtime is non-native");

  const geoPerm = await checkGeolocationPermission();
  assert.ok(geoPerm.location);

  const pushPerm = await checkPushPermissions();
  assert.equal(pushPerm, false, "Push permission is false in non-native test runtime");
});

test("Native Razorpay bindings enforce strict sandbox locks and reject live credentials", async () => {
  const { assertSandboxPaymentLocks, assertSandboxKey, openMobileRazorpayCheckout } = await import("../lib/mobile/razorpay.ts");

  // Valid sandbox configuration
  assert.doesNotThrow(() => {
    assertSandboxPaymentLocks({
      PAWSPACE_PAYMENT_ENV: "sandbox",
      FORBID_PRODUCTION: "true",
      PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
    });
  });

  // Violation 1: Live payment environment
  assert.throws(() => {
    assertSandboxPaymentLocks({
      PAWSPACE_PAYMENT_ENV: "live",
      FORBID_PRODUCTION: "true",
      PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
    });
  }, /SECURITY LOCK VIOLATION/);

  // Violation 2: FORBID_PRODUCTION is false
  assert.throws(() => {
    assertSandboxPaymentLocks({
      PAWSPACE_PAYMENT_ENV: "sandbox",
      FORBID_PRODUCTION: "false",
      PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
    });
  }, /SECURITY LOCK VIOLATION/);

  // Violation 3: Live payment approved is true
  assert.throws(() => {
    assertSandboxPaymentLocks({
      PAWSPACE_PAYMENT_ENV: "sandbox",
      FORBID_PRODUCTION: "true",
      PAWSPACE_PAYMENT_LIVE_APPROVED: "true",
    });
  }, /SECURITY LOCK VIOLATION/);

  // Key validation: test key accepted
  assert.doesNotThrow(() => {
    assertSandboxKey("rzp_test_5h9J1kL9m8N7o6");
  });

  // Key validation: live key rejected
  assert.throws(() => {
    assertSandboxKey("rzp_live_9a8B7c6D5e4F3g");
  }, /Live Razorpay key rejected/);

  // Failure result on non-browser without crashing
  const result = await openMobileRazorpayCheckout({
    keyId: "rzp_test_5h9J1kL9m8N7o6",
    orderId: "order_test_123",
    amountPaise: 50000,
  });

  assert.equal(result.success, false);
  assert.equal(result.environment, "sandbox");
  assert.equal(result.code, "NO_WINDOW_CONTEXT");
});

test("CRM Live-Chat API handles thread queries and enforces sandbox security locks without credential leaks", async () => {
  const { GET, POST } = await import("../app/api/crm/chat/route.ts");
  const { ensureWhatsAppUatTables, recordWhatsAppUatInbound } = await import("../lib/whatsapp-uat-adapter.ts");
  const customer360 = await import("../lib/customer-360.ts");
  const conversationControl = await import("../lib/whatsapp-conversation-control.ts");

  const { sqlite, db } = freshAiDb({
    PAWSPACE_DEPLOYMENT_ENV: "staging",
    PAWSPACE_PAYMENT_ENV: "sandbox",
    PAWSPACE_COMMUNICATION_ENV: "uat",
    META_WHATSAPP_APP_SECRET: "staging_secret_safe",
    META_WHATSAPP_ACCESS_TOKEN: "staging_token_safe",
  });

  const customerId = "CUS-CHAT-1";
  const phone = "9876543210";
  seedCustomer(sqlite, customerId, "Chat Customer", phone);
  await customer360.ensureCustomer360Tables(db);
  await ensureWhatsAppUatTables(db);
  await conversationControl.ensureWhatsAppConversationControl(db);

  // Set consent
  const now = Date.now();
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,1,0,0,0,'uat','chat-test',?)")
    .run(customerId, now);

  // Simulate inbound message via adapter
  const inbound = await recordWhatsAppUatInbound(db, {
    provider: "meta_whatsapp",
    eventId: "evt-meta-init-1",
    payloadHash: "hash-meta-1",
    customerId,
    text: "Hello PawSpace, I want grooming for my golden retriever",
    receivedAt: now,
  });

  assert.equal(inbound.duplicatePrevented, false);
  assert.ok(inbound.threadId);

  // GET thread list
  const req = new Request("http://localhost:3000/api/crm/chat", {
    headers: {
      "x-actor-role": "superuser",
      "x-actor-email": "crm-operator@pawspace.test",
    },
  });

  const res = await GET(req);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.data.threads));
  assert.equal(body.data.simulationAllowed, true);

  // Ensure NO credentials leaked in response body
  const rawJson = JSON.stringify(body);
  assert.equal(rawJson.includes("staging_secret_safe"), false);
  assert.equal(rawJson.includes("staging_token_safe"), false);

  // GET single thread detail
  const detailReq = new Request(`http://localhost:3000/api/crm/chat?threadId=${inbound.threadId}`, {
    headers: {
      "x-actor-role": "superuser",
      "x-actor-email": "crm-operator@pawspace.test",
    },
  });
  const detailRes = await GET(detailReq);
  assert.equal(detailRes.status, 200);
  const detailBody = await detailRes.json();
  assert.equal(detailBody.ok, true);
  assert.equal(detailBody.data.session.isWithin24Hours, true);
  assert.ok(detailBody.data.messages.length >= 1);

  // POST send outbound WhatsApp message within 24h window
  const sendReq = new Request("http://localhost:3000/api/crm/chat", {
    method: "POST",
    headers: {
      "x-actor-role": "superuser",
      "x-actor-email": "crm-operator@pawspace.test",
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      action: "send_message",
      clientRequestId: "native-ecosystem-chat-send-1",
      threadId: inbound.threadId,
      customerId,
      text: "We have an opening tomorrow at 10 AM! Would that work?",
    }),
  });

  const sendRes = await POST(sendReq);
  assert.equal(sendRes.status, 201);
  const sendBody = await sendRes.json();
  assert.equal(sendBody.ok, true);
  assert.equal(sendBody.data.queued, true);

  // POST simulate inbound message from customer in sandbox
  const simReq = new Request("http://localhost:3000/api/crm/chat", {
    method: "POST",
    headers: {
      "x-actor-role": "superuser",
      "x-actor-email": "crm-operator@pawspace.test",
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      action: "simulate_inbound",
      threadId: inbound.threadId,
      customerId,
      text: "Yes, 10 AM works perfectly!",
    }),
  });

  const simRes = await POST(simReq);
  assert.equal(simRes.status, 201);
  const simBody = await simRes.json();
  assert.equal(simBody.ok, true);
  assert.equal(simBody.data.duplicatePrevented, false);
});

test("Native permission manifests for iOS and Android declare all required hardware privileges", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // Verify iOS Info.plist
  const iosPlist = readFileSync(resolve("ios/App/App/Info.plist"), "utf-8");
  assert.match(iosPlist, /<key>NSLocationWhenInUseUsageDescription<\/key>/);
  assert.match(iosPlist, /PawSpace shares your location during an accepted partner job\./);
  assert.match(iosPlist, /<key>NSLocationAlwaysAndWhenInUseUsageDescription<\/key>/);
  assert.match(iosPlist, /Tracking stops when the job ends\./);
  assert.match(iosPlist, /<key>NSCameraUsageDescription<\/key>/);
  assert.match(iosPlist, /PawSpace requires camera access for pet grooming verification photos\./);

  assert.match(iosPlist, /<key>UIBackgroundModes<\/key>/);
  assert.match(iosPlist, /<string>location<\/string>/);
  // Verify Android AndroidManifest.xml
  const androidManifest = readFileSync(resolve("android/app/src/main/AndroidManifest.xml"), "utf-8");
  assert.match(androidManifest, /android:name="android\.permission\.ACCESS_FINE_LOCATION"/);
  assert.match(androidManifest, /android:name="android\.permission\.ACCESS_COARSE_LOCATION"/);
  assert.match(androidManifest, /android:name="android\.permission\.ACCESS_BACKGROUND_LOCATION"/);
  assert.match(androidManifest, /android:name="android\.permission\.CAMERA"/);
  assert.match(androidManifest, /android:name="android\.permission\.POST_NOTIFICATIONS"/);
});



test("native preparation requires partner URL for normalized targets and aliases", () => {
  for (const selection of [
    { CAPACITOR_TARGET: "partner" },
    { CAPACITOR_TARGET: "PARTNER" },
    { APP_TARGET: "partner" },
    { APP_TARGET: "PARTNER" },
  ]) {
    const env = { ...process.env };
    delete env.CAPACITOR_TARGET;
    delete env.APP_TARGET;
    delete env.PAWSPACE_PARTNER_APP_URL;
    const result = spawnSync(process.execPath, ["scripts/prepare-partner-native.mjs"], {
      cwd: new URL("..", import.meta.url), env: { ...env, ...selection }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Set PAWSPACE_PARTNER_APP_URL/);
  }
});

const STAGING = "https://pawspace-staging.karthik-fce.workers.dev";
// Each case loads the config in a fresh process: the URL rule runs when the module is first evaluated.
function loadNativeConfig(module, overrides) {
  const env = { ...process.env };
  for (const key of ["CAPACITOR_TARGET", "APP_TARGET", "PAWSPACE_CUSTOMER_APP_URL", "PAWSPACE_PARTNER_APP_URL"]) delete env[key];
  const code = `const c=(await import(${JSON.stringify(`./${module}`)})).default;console.log(JSON.stringify({appId:c.appId,server:c.server}))`;
  return spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
    cwd: new URL("..", import.meta.url), env: { ...env, ...overrides }, encoding: "utf8",
  });
}

test("native customer app loads the V2 customer experience at the HTTPS /v2 URL", () => {
  const result = loadNativeConfig("capacitor.customer.config.ts", { PAWSPACE_CUSTOMER_APP_URL: `${STAGING}/v2` });
  assert.equal(result.status, 0, result.stderr);
  const { appId, server } = JSON.parse(result.stdout);
  assert.equal(appId, "com.pawspace.customer");
  assert.equal(server.url, `${STAGING}/v2`);
  assert.equal(server.errorPath, "offline.html");
  assert.equal(server.cleartext, false);

  const unset = loadNativeConfig("capacitor.customer.config.ts", {});
  assert.equal(unset.status, 0, unset.stderr);
  assert.equal(JSON.parse(unset.stdout).server.url, undefined, "without a URL the packaged shell stays local");
});

test("native customer config rejects /mobile-app and every non-canonical /v2 URL", () => {
  for (const url of [
    `${STAGING}/mobile-app`,
    "http://pawspace-staging.karthik-fce.workers.dev/v2",
    `${STAGING}/v2?preview=1`,
    "https://user:secret@pawspace-staging.karthik-fce.workers.dev/v2",
    `${STAGING}/v2#home`,
    `${STAGING}/v2/grooming`,
    `${STAGING}/`,
  ]) {
    const result = loadNativeConfig("capacitor.customer.config.ts", { PAWSPACE_CUSTOMER_APP_URL: url });
    assert.equal(result.status, 1, url);
    assert.match(result.stderr, /PAWSPACE_CUSTOMER_APP_URL must be an HTTPS \/v2 URL without credentials or query parameters\./, url);
  }
});

test("partner target is unchanged and a partner build needs no customer URL", async () => {
  const partner = loadNativeConfig("capacitor.partner.config.ts", { PAWSPACE_PARTNER_APP_URL: `${STAGING}/partner-app` });
  assert.equal(partner.status, 0, partner.stderr);
  assert.deepEqual(JSON.parse(partner.stdout), { appId: "com.pawspace.partner", server: { url: `${STAGING}/partner-app`, errorPath: "offline.html", androidScheme: "https", cleartext: false } });
  const stale = loadNativeConfig("capacitor.partner.config.ts", { PAWSPACE_PARTNER_APP_URL: `${STAGING}/v2/partner` });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /approved HTTPS \/partner-app URL/);
  // capacitor.config.ts evaluates both targets; the empty customer URL the beta workflow gives partner builds is accepted.
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../capacitor.config.ts", import.meta.url), "utf8"), /import customerConfig from "\.\/capacitor\.customer\.config";\nimport partnerConfig from "\.\/capacitor\.partner\.config";/);
  const empty = loadNativeConfig("capacitor.customer.config.ts", { PAWSPACE_CUSTOMER_APP_URL: "" });
  assert.equal(empty.status, 0, empty.stderr);
});

test("native preparation asks for the customer /v2 URL", () => {
  for (const selection of [{}, { CAPACITOR_TARGET: "customer" }, { APP_TARGET: "CUSTOMER" }]) {
    const env = { ...process.env };
    for (const key of ["CAPACITOR_TARGET", "APP_TARGET", "PAWSPACE_CUSTOMER_APP_URL"]) delete env[key];
    const result = spawnSync(process.execPath, ["scripts/prepare-partner-native.mjs"], {
      cwd: new URL("..", import.meta.url), env: { ...env, ...selection }, encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Set PAWSPACE_CUSTOMER_APP_URL to the approved HTTPS \/v2 workspace/);
  }
});

test("native build workflows point the customer app at /v2 and keep the partner app on /partner-app", async () => {
  const { readFileSync } = await import("node:fs");
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const testBuilds = read(".github/workflows/native-test-builds.yml");
  assert.match(testBuilds, /^ {2}PAWSPACE_CUSTOMER_APP_URL: https:\/\/pawspace-staging\.karthik-fce\.workers\.dev\/v2$/m);
  assert.match(testBuilds, /^ {2}PAWSPACE_PARTNER_APP_URL: https:\/\/pawspace-staging\.karthik-fce\.workers\.dev\/partner-app$/m);
  assert.doesNotMatch(testBuilds, /\/mobile-app/);
  // capacitor.config.ts evaluates both targets, so a partner beta build must not receive the customer URL.
  const beta = read(".github/workflows/mobile-beta-distribution.yml");
  assert.match(beta, /^ {2}PAWSPACE_CUSTOMER_APP_URL: \$\{\{ \(inputs\.target_app \|\| 'customer'\) == 'customer' && vars\.PAWSPACE_CUSTOMER_APP_URL \|\| '' \}\}$/m);
  assert.match(beta, /^ {2}PAWSPACE_PARTNER_APP_URL: \$\{\{ vars\.PAWSPACE_PARTNER_APP_URL \}\}$/m);
});
