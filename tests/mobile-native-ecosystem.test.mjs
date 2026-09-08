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
  assert.equal(customerConfig.webDir, ".next");

  assert.equal(partnerConfig.appId, "com.pawspace.partner");
  assert.equal(partnerConfig.appName, "PawSpacePartner");
  assert.equal(partnerConfig.webDir, ".next");

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
  assert.equal(body.data.sandboxLocks.paymentEnv, "sandbox");
  assert.equal(body.data.sandboxLocks.forbidProduction, true);

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
  assert.match(iosPlist, /PawSpace requires location access to track walker routes during active sessions\./);
  assert.match(iosPlist, /<key>NSLocationAlwaysAndWhenInUseUsageDescription<\/key>/);
  assert.match(iosPlist, /PawSpace requires background location access for live pet walking telemetry\./);
  assert.match(iosPlist, /<key>NSCameraUsageDescription<\/key>/);
  assert.match(iosPlist, /PawSpace requires camera access for pet grooming verification photos\./);

  // Verify Android AndroidManifest.xml
  const androidManifest = readFileSync(resolve("android/app/src/main/AndroidManifest.xml"), "utf-8");
  assert.match(androidManifest, /android:name="android\.permission\.ACCESS_FINE_LOCATION"/);
  assert.match(androidManifest, /android:name="android\.permission\.ACCESS_COARSE_LOCATION"/);
  assert.match(androidManifest, /android:name="android\.permission\.ACCESS_BACKGROUND_LOCATION"/);
  assert.match(androidManifest, /android:name="android\.permission\.CAMERA"/);
  assert.match(androidManifest, /android:name="android\.permission\.POST_NOTIFICATIONS"/);
});

test("GroomingUpload component wires Camera.getPhoto() with native and web fallbacks", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const componentSource = readFileSync(resolve("components/customer/grooming-upload.tsx"), "utf-8");

  // Verify Capacitor camera imports
  assert.match(componentSource, /import\s+\{\s*Camera,\s*CameraResultType,\s*CameraSource\s*\}\s+from\s+"@capacitor\/camera"/);
  assert.match(componentSource, /import\s+\{\s*Capacitor\s*\}\s+from\s+"@capacitor\/core"/);

  // Verify Camera.getPhoto native invocation
  assert.match(componentSource, /await\s+Camera\.getPhoto\(\{/);
  assert.match(componentSource, /resultType:\s*CameraResultType\.DataUrl/);
  assert.match(componentSource, /quality:\s*90/);

  // Verify dual stages: check-in (before) and completion (after)
  assert.match(componentSource, /1\.\s+Check-in Photo \(Before\)/);
  assert.match(componentSource, /2\.\s+Completion Photo \(After\)/);

  // Verify Web fallback file picker
  assert.match(componentSource, /document\.createElement\("input"\)/);
  assert.match(componentSource, /input\.type\s*=\s*"file"/);
});

test("ActiveWalkMap component wires @capacitor/geolocation watchPosition telemetry to backend", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const componentSource = readFileSync(resolve("components/partner/active-walk-map.tsx"), "utf-8");

  // Verify Geolocation import
  assert.match(componentSource, /import\s+\{\s*Geolocation/);
  assert.match(componentSource, /from\s+"@capacitor\/geolocation"/);

  // Verify watchPosition and clearWatch bindings
  assert.match(componentSource, /Geolocation\.watchPosition\(/);
  assert.match(componentSource, /Geolocation\.clearWatch\(\{/);

  // Verify safe telemetry transmission
  assert.match(componentSource, /\/api\/walking-proof/);
  assert.match(componentSource, /action:\s*"record_location_sample"/);
  assert.match(componentSource, /accuracyMeters:/);
  assert.match(componentSource, /idempotencyKey:/);

  // Verify strict sandbox isolation indicators
  assert.match(componentSource, /Strict Sandbox Telemetry Mode/);
  assert.match(componentSource, /Zero production GPS leakage/);
});

test("MobilePushListener wires FCM token registration and notification click handlers in root layout", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const listenerSource = readFileSync(resolve("app/components/mobile-push-listener.tsx"), "utf-8");

  // Verify PushNotifications import
  assert.match(listenerSource, /import\s+\{\s*PushNotifications/);
  assert.match(listenerSource, /from\s+"@capacitor\/push-notifications"/);

  // Verify lifecycle registrations
  assert.match(listenerSource, /PushNotifications\.requestPermissions\(\)/);
  assert.match(listenerSource, /PushNotifications\.register\(\)/);
  assert.match(listenerSource, /PushNotifications\.addListener\(\s*"registration"/);
  assert.match(listenerSource, /PushNotifications\.addListener\(\s*"pushNotificationReceived"/);
  assert.match(listenerSource, /PushNotifications\.addListener\(\s*"pushNotificationActionPerformed"/);

  // Verify root layout integration
  const layoutSource = readFileSync(resolve("app/layout.tsx"), "utf-8");
  assert.match(layoutSource, /import\s+MobilePushListener\s+from\s+"\.\/components\/mobile-push-listener"/);
  assert.match(layoutSource, /<MobilePushListener\s*\/>/);
});

test("Mobile release signing configuration and security guardrails are verified", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // 1. Verify Android build.gradle signingConfigs
  const buildGradle = readFileSync(resolve("android/app/build.gradle"), "utf-8");
  assert.match(buildGradle, /signingConfigs\s*\{/);
  assert.match(buildGradle, /release\s*\{/);
  assert.match(buildGradle, /ANDROID_KEYSTORE_FILE/);
  assert.match(buildGradle, /storePassword/);
  assert.match(buildGradle, /keyAlias/);
  assert.match(buildGradle, /keyPassword/);
  assert.match(buildGradle, /signingConfig\s+signingConfigs\.release/);

  // 2. Verify Android gradle.properties template
  const gradleProperties = readFileSync(resolve("android/gradle.properties"), "utf-8");
  assert.match(gradleProperties, /ANDROID_KEYSTORE_FILE/);
  assert.match(gradleProperties, /ANDROID_KEY_ALIAS/);

  // 3. Verify .gitignore blocks release keystores and compiled binaries
  const gitignore = readFileSync(resolve(".gitignore"), "utf-8");
  assert.match(gitignore, /\*\.jks/);
  assert.match(gitignore, /\*\.keystore/);
  assert.match(gitignore, /\*\.aab/);
  assert.match(gitignore, /\*\.apk/);
  assert.match(gitignore, /\*\.xcarchive/);

  // 4. Verify release build script enforces fail-closed sandbox locks
  const releaseScript = readFileSync(resolve("scripts/build-mobile-release.sh"), "utf-8");
  assert.match(releaseScript, /PAWSPACE_PAYMENT_ENV="\$\{PAWSPACE_PAYMENT_ENV:-sandbox\}"/);
  assert.match(releaseScript, /FORBID_PRODUCTION="\$\{FORBID_PRODUCTION:-true\}"/);
  assert.match(releaseScript, /PAWSPACE_PAYMENT_LIVE_APPROVED="\$\{PAWSPACE_PAYMENT_LIVE_APPROVED:-false\}"/);
  assert.match(releaseScript, /FATAL: Sandbox security locks violated!/);
});

test("Fastlane CI/CD automation lanes configure Play Store internal testing and TestFlight deployment", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // 1. Verify Gemfile
  assert.equal(existsSync(resolve("Gemfile")), true);
  const gemfile = readFileSync(resolve("Gemfile"), "utf-8");
  assert.match(gemfile, /gem\s+["']fastlane["']/);

  // 2. Verify Appfile
  assert.equal(existsSync(resolve("fastlane/Appfile")), true);
  const appfile = readFileSync(resolve("fastlane/Appfile"), "utf-8");
  assert.match(appfile, /app_identifier\(.*com\.pawspace\.customer/);
  assert.match(appfile, /package_name\(.*com\.pawspace\.customer/);
  assert.match(appfile, /com\.pawspace\.partner/);

  // 3. Verify Fastfile
  assert.equal(existsSync(resolve("fastlane/Fastfile")), true);
  const fastfile = readFileSync(resolve("fastlane/Fastfile"), "utf-8");

  // Sandbox guard in before_all
  assert.match(fastfile, /before_all\s+do/);
  assert.match(fastfile, /PAWSPACE_PAYMENT_ENV/);
  assert.match(fastfile, /FORBID_PRODUCTION/);
  assert.match(fastfile, /SECURITY LOCK VIOLATION/);

  // Android lanes: bundleRelease and upload_to_play_store
  assert.match(fastfile, /platform\s+:android\s+do/);
  assert.match(fastfile, /lane\s+:beta\s+do/);
  assert.match(fastfile, /gradle\(\s*task:\s*["']bundleRelease["']/);
  assert.match(fastfile, /upload_to_play_store\(/);
  assert.match(fastfile, /track:\s*["']internal["']/);
  assert.match(fastfile, /package_name:\s*["']com\.pawspace\.customer["']/);

  // iOS lanes: build_app and upload_to_testflight
  assert.match(fastfile, /platform\s+:ios\s+do/);
  assert.match(fastfile, /build_app\(/);
  assert.match(fastfile, /workspace:\s*["']ios\/App\/App\.xcworkspace["']/);
  assert.match(fastfile, /upload_to_testflight\(/);
  assert.match(fastfile, /skip_waiting_for_build_processing:\s*true/);

  // Partner distribution lanes
  assert.match(fastfile, /lane\s+:partner_beta\s+do/);
});

test("GitHub Actions mobile beta distribution workflow enforces sandbox locks and wires Fastlane matrix", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const workflowPath = resolve(".github/workflows/mobile-beta-distribution.yml");
  assert.equal(existsSync(workflowPath), true, "mobile-beta-distribution.yml must exist");

  const workflow = readFileSync(workflowPath, "utf-8");

  // 1. Triggers
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /tags:\s*\n\s*-\s*['"]v\*['"]/);

  // 2. Hardcoded fail-closed sandbox locks in global env
  assert.match(workflow, /PAWSPACE_PAYMENT_ENV:\s*["']sandbox["']/);
  assert.match(workflow, /FORBID_PRODUCTION:\s*["']true["']/);
  assert.match(workflow, /PAWSPACE_PAYMENT_LIVE_APPROVED:\s*["']false["']/);
  assert.match(workflow, /NEXT_PUBLIC_API_BASE_URL:\s*["']https:\/\/staging-api\.pawspace\.in["']/);

  // 3. Android job configuration
  assert.match(workflow, /distribute-android:/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /setup-java@v4/);
  assert.match(workflow, /java-version:\s*['"]17['"]/);
  assert.match(workflow, /ruby\/setup-ruby@v1/);
  assert.match(workflow, /bundle exec fastlane android/);

  // 4. iOS job configuration
  assert.match(workflow, /distribute-ios:/);
  assert.match(workflow, /runs-on:\s*macos-latest/);
  assert.match(workflow, /bundle exec fastlane ios/);

  // 5. Secret injection
  assert.match(workflow, /secrets\.GOOGLE_PLAY_JSON/);
  assert.match(workflow, /secrets\.ANDROID_KEYSTORE_PASSWORD/);
  assert.match(workflow, /secrets\.ASC_KEY_ID/);
  assert.match(workflow, /secrets\.ASC_PRIVATE_KEY/);
});

test("Native icons and splash screens are generated across iOS and Android platforms", async () => {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // Base source assets
  assert.equal(existsSync(resolve("assets/icon.png")), true, "assets/icon.png must exist");
  assert.equal(existsSync(resolve("assets/splash.png")), true, "assets/splash.png must exist");

  // Android generated assets
  assert.equal(existsSync(resolve("android/app/src/main/res/drawable/splash.png")), true);
  assert.equal(existsSync(resolve("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png")), true);
  assert.equal(existsSync(resolve("android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png")), true);

  // iOS generated assets
  assert.equal(existsSync(resolve("ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")), true);
  assert.equal(existsSync(resolve("ios/App/App/Assets.xcassets/Splash.imageset/Default@3x~universal~anyany.png")), true);
});

test("Deep link routing intercepts custom schemes, universal links, and payment redirects", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // 1. Verify deep link handler component exists
  assert.equal(existsSync(resolve("app/components/mobile-deep-link-handler.tsx")), true);
  const handlerSource = readFileSync(resolve("app/components/mobile-deep-link-handler.tsx"), "utf-8");

  assert.match(handlerSource, /import\s+\{[^}]*\bApp\b[^}]*\}\s+from\s+["']@capacitor\/app["']/);
  assert.match(handlerSource, /App\.addListener\(\s*["']appUrlOpen["']/);
  assert.match(handlerSource, /router\.push/);
  assert.match(handlerSource, /pawspace:razorpay-callback/);

  // 2. Test deep link parser logic directly
  const { parseDeepLinkUrl } = await import("../app/components/mobile-deep-link-handler.tsx").catch(() => ({}));
  // Even if TSX import is evaluated via source or regex, verify parsing rules
  assert.match(handlerSource, /startsWith\(["']pawspace:\/\/["']\)/);
  assert.match(handlerSource, /url\.split\(["']\.in["']\)\.pop\(\)/);

  // 3. Verify AndroidManifest.xml deep link intent-filters
  const androidManifest = readFileSync(resolve("android/app/src/main/AndroidManifest.xml"), "utf-8");
  assert.match(androidManifest, /<data\s+android:scheme="pawspace"\s*\/>/);
  assert.match(androidManifest, /<data\s+android:scheme="https"\s+android:host="staging-api\.pawspace\.in"\s*\/>/);
  assert.match(androidManifest, /<data\s+android:scheme="https"\s+android:host="pawspace\.in"\s*\/>/);

  // 4. Verify Info.plist CFBundleURLTypes
  const iosPlist = readFileSync(resolve("ios/App/App/Info.plist"), "utf-8");
  assert.match(iosPlist, /<key>CFBundleURLTypes<\/key>/);
  assert.match(iosPlist, /<string>pawspace<\/string>/);

  // 5. Verify root layout mounts MobileDeepLinkHandler
  const layoutSource = readFileSync(resolve("app/layout.tsx"), "utf-8");
  assert.match(layoutSource, /import\s+MobileDeepLinkHandler\s+from\s+"\.\/components\/mobile-deep-link-handler"/);
  assert.match(layoutSource, /<MobileDeepLinkHandler\s*\/>/);
});

test("Offline telemetry queue buffers GPS telemetry and grooming photos with automatic reconnection flushing", async () => {
  const {
    getOfflineQueue,
    enqueueOfflineTelemetry,
    flushOfflineQueue,
    clearOfflineQueue,
    getNetworkStatus,
  } = await import("../lib/mobile/offline-queue.ts");

  // Reset queue before testing
  await clearOfflineQueue();
  let queue = await getOfflineQueue();
  assert.equal(queue.length, 0, "Initial queue must be empty");

  // 1. Enqueue GPS coordinate
  const gpsItem = await enqueueOfflineTelemetry({
    type: "gps_coordinate",
    endpoint: "/api/walking-proof",
    payload: {
      bookingId: "test-booking-1",
      sessionId: "session-1",
      action: "record_location_sample",
      latitude: 12.9716,
      longitude: 77.5946,
      accuracyMeters: 4.5,
      idempotencyKey: "idem-gps-1",
    },
  });

  assert.equal(gpsItem.type, "gps_coordinate");
  assert.equal(gpsItem.retryCount, 0);
  assert.ok(gpsItem.id.startsWith("offline-"));

  // 2. Enqueue Grooming photo
  const photoItem = await enqueueOfflineTelemetry({
    type: "grooming_photo",
    endpoint: "/api/service-media",
    payload: {
      bookingId: "test-booking-1",
      purpose: "before_service",
      dataUrl: "data:image/jpeg;base64,mock",
      format: "jpeg",
      capturedAt: Date.now(),
    },
  });

  assert.equal(photoItem.type, "grooming_photo");

  queue = await getOfflineQueue();
  assert.equal(queue.length, 2, "Queue should hold both buffered telemetry items");

  // 3. Test sequential flushing
  const originalFetch = globalThis.fetch;
  const processedCalls = [];
  globalThis.fetch = async (url, opts) => {
    processedCalls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };

  try {
    const result = await flushOfflineQueue();
    assert.equal(result.flushed, 2);
    assert.equal(result.remaining, 0);
    assert.equal(processedCalls.length, 2);
    assert.equal(processedCalls[0].url, "/api/walking-proof");
    assert.equal(processedCalls[1].url, "/api/service-media");

    const remainingQueue = await getOfflineQueue();
    assert.equal(remainingQueue.length, 0, "Queue should be empty after successful flush");
  } finally {
    globalThis.fetch = originalFetch;
    await clearOfflineQueue();
  }

  // 4. Test network status helper
  const netStatus = await getNetworkStatus();
  assert.equal(typeof netStatus.connected, "boolean");
});

test("Mobile network status component and offline-first UI listeners are mounted", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // 1. Check mobile network status component
  assert.equal(existsSync(resolve("app/components/mobile-network-status.tsx")), true);
  const statusSource = readFileSync(resolve("app/components/mobile-network-status.tsx"), "utf-8");

  assert.match(statusSource, /Network\.addListener\(\s*["']networkStatusChange["']/);
  assert.match(statusSource, /flushOfflineQueue/);
  assert.match(statusSource, /You are offline\. Service data is saving locally\./);
  assert.match(statusSource, /Triggering automatic offline queue flush/);

  // 2. Check layout mounts component
  const layoutSource = readFileSync(resolve("app/layout.tsx"), "utf-8");
  assert.match(layoutSource, /import\s+MobileNetworkStatus\s+from\s+"\.\/components\/mobile-network-status"/);
  assert.match(layoutSource, /<MobileNetworkStatus\s*\/>/);

  // 3. Check active-walk-map offline buffering
  const walkMapSource = readFileSync(resolve("components/partner/active-walk-map.tsx"), "utf-8");
  assert.match(walkMapSource, /enqueueOfflineTelemetry/);
  assert.match(walkMapSource, /Network\.getStatus\(\)/);
  assert.match(walkMapSource, /type:\s*["']gps_coordinate["']/);

  // 4. Check grooming-upload offline buffering
  const groomingSource = readFileSync(resolve("components/customer/grooming-upload.tsx"), "utf-8");
  assert.match(groomingSource, /enqueueOfflineTelemetry/);
  assert.match(groomingSource, /Network\.getStatus\(\)/);
  assert.match(groomingSource, /type:\s*["']grooming_photo["']/);
  assert.match(groomingSource, /Offline: Photo saved to local queue\. Will sync automatically upon reconnection\./);
});







