var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// three-chat-release-review/lib/employee-exit-access.ts
async function employeeAccessHasEnded(db, email, asOf = Date.now()) {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_exit_cases'").first();
  if (!exists) return false;
  return Boolean(await db.prepare(EMPLOYEE_EXIT_CUTOFF_SQL).bind(email.trim().toLowerCase(), email.trim().toLowerCase(), asOf).first());
}
var EMPLOYEE_EXIT_CUTOFF_SQL;
var init_employee_exit_access = __esm({
  "three-chat-release-review/lib/employee-exit-access.ts"() {
    EMPLOYEE_EXIT_CUTOFF_SQL = "SELECT id FROM employee_exit_cases WHERE (identity_email=? OR user_id IN (SELECT id FROM app_users WHERE lower(email)=?)) AND status IN ('approved','access_revoked','settled_sandbox') AND access_ends_at<=? LIMIT 1";
  }
});

// three-chat-release-review/lib/platform-security.ts
function parsePermissions(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (typeof value !== "string") return [];
  try {
    return parsePermissions(JSON.parse(value));
  } catch {
    return [];
  }
}
var init_platform_security = __esm({
  "three-chat-release-review/lib/platform-security.ts"() {
  }
});

// three-chat-release-review/lib/security-crypto.ts
function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left ?? "")), b = encoder.encode(String(right ?? ""));
  if (a.length > CONSTANT_TIME_COMPARE_BYTES || b.length > CONSTANT_TIME_COMPARE_BYTES) return false;
  let diff = a.length ^ b.length;
  for (let index = 0; index < CONSTANT_TIME_COMPARE_BYTES; index++) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}
var encoder, CONSTANT_TIME_COMPARE_BYTES;
var init_security_crypto = __esm({
  "three-chat-release-review/lib/security-crypto.ts"() {
    encoder = new TextEncoder();
    CONSTANT_TIME_COMPARE_BYTES = 512;
  }
});

// three-chat-release-review/lib/d1-transient.ts
function messageOf(value) {
  if (value instanceof Error) return `${value.message} ${value.cause instanceof Error ? value.cause.message : ""}`;
  return typeof value === "string" ? value : "";
}
function isTransientD1Refusal(value) {
  return REFUSED_BEFORE_EXECUTION.test(messageOf(value));
}
var REFUSED_BEFORE_EXECUTION;
var init_d1_transient = __esm({
  "three-chat-release-review/lib/d1-transient.ts"() {
    REFUSED_BEFORE_EXECUTION = /Currently processing a long-running import|D1 DB is overloaded|Too many requests queued/i;
  }
});

// three-chat-release-review/lib/uat-staging-auth.ts
function uatLoginEnabled(env) {
  return String(env?.PAWSPACE_UAT_LOGIN || "") === "on" && String(env?.PAWSPACE_UAT_SIGNING_KEY || "").length >= UAT_SIGNING_KEY_MIN_LENGTH;
}
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToStr(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64);
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return b64url(new Uint8Array(sig));
}
function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
async function verifyUatToken(env, token) {
  const [payload, sig] = String(token).split(".");
  if (!payload || !sig) return null;
  const expect = await hmac(String(env.PAWSPACE_UAT_SIGNING_KEY), payload);
  if (!constantTimeEqual(expect, sig)) return null;
  let obj;
  try {
    obj = JSON.parse(b64urlToStr(payload));
  } catch {
    return null;
  }
  if (!obj || typeof obj.email !== "string" || Number(obj.exp || 0) < Date.now()) return null;
  return obj.email;
}
async function readStaffDirectory(read) {
  try {
    return await read();
  } catch (error) {
    if (!isTransientD1Refusal(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return read();
  }
}
async function readUatActorRow(db, email) {
  let byEmail = uatActorReads.get(db);
  if (!byEmail) {
    byEmail = /* @__PURE__ */ new Map();
    uatActorReads.set(db, byEmail);
  }
  const running = byEmail.get(email);
  if (running) return running;
  const pending = readStaffDirectory(() => db.prepare("SELECT u.id,u.name,u.role_code,u.status,r.permissions_json FROM app_users u LEFT JOIN role_definitions r ON r.code=u.role_code WHERE u.email=?").bind(email).first()).finally(() => {
    if (byEmail.get(email) === pending) byEmail.delete(email);
  });
  byEmail.set(email, pending);
  return pending;
}
async function resolveUatStaffActor(db, request, env) {
  if (!uatLoginEnabled(env)) return null;
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const email = await verifyUatToken(env, token);
  if (!email) return null;
  const user = await readUatActorRow(db, email);
  if (!user || String(user.status) !== "active") return null;
  if (await employeeAccessHasEnded(db, email)) return null;
  const roleCode = String(user.role_code || "").trim();
  if (!roleCode || user.permissions_json === null || user.permissions_json === void 0) return null;
  const permissions = parsePermissions(user.permissions_json);
  return { userId: String(user.id), email, name: String(user.name || email), roleCode, permissions, developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: email };
}
var COOKIE, enc, UAT_SIGNING_KEY_MIN_LENGTH, uatActorReads;
var init_uat_staging_auth = __esm({
  "three-chat-release-review/lib/uat-staging-auth.ts"() {
    init_employee_exit_access();
    init_platform_security();
    init_security_crypto();
    init_d1_transient();
    COOKIE = "pawspace_uat";
    enc = new TextEncoder();
    UAT_SIGNING_KEY_MIN_LENGTH = 32;
    uatActorReads = /* @__PURE__ */ new WeakMap();
  }
});

// three-chat-release-review/lib/voice-call-gate.ts
function voiceAllowlist(env) {
  return val(env, "PAWSPACE_VOICE_UAT_ALLOWLIST").split(/[,;\n]+/).map((entry) => entry.replace(/[^0-9]/g, "")).filter((entry) => entry.length >= 8).map((entry) => entry.slice(-10));
}
function normalisedDialKey(phone) {
  const digits2 = String(phone ?? "").replace(/[^0-9]/g, "");
  return digits2.length >= 8 ? digits2.slice(-10) : "";
}
function isVoiceAllowlisted(env, phone) {
  const key = normalisedDialKey(phone);
  return Boolean(key) && voiceAllowlist(env).includes(key);
}
var val;
var init_voice_call_gate = __esm({
  "three-chat-release-review/lib/voice-call-gate.ts"() {
    val = (env, key) => String(env?.[key] ?? "").trim();
  }
});

// three-chat-release-review/lib/staging-fixture-provider-manifest.ts
var STAGING_PROVIDER_FIXTURES;
var init_staging_fixture_provider_manifest = __esm({
  "three-chat-release-review/lib/staging-fixture-provider-manifest.ts"() {
    STAGING_PROVIDER_FIXTURES = Object.freeze({
      "uatcap_groom_east_6": "9000000951",
      "uatcap_groom_east_7": "9000000952",
      "uatcap_groom_east_8": "9000000953",
      "uatcap_groom_south_6": "9000000954",
      "uatcap_groom_south_7": "9000000955",
      "uatcap_groom_south_8": "9000000956",
      "uatcap_groom_north_6": "9000000957",
      "uatcap_groom_north_7": "9000000958",
      "uatcap_groom_north_8": "9000000959",
      "uatcap_groom_west_6": "9000000960",
      "uatcap_groom_west_7": "9000000961",
      "uatcap_groom_west_8": "9000000962",
      "uatcap_groom_central_6": "9000000963",
      "uatcap_groom_central_7": "9000000964",
      "uatcap_groom_central_8": "9000000965",
      "uatcap_groom_ft": "9000000901",
      "uatcap_groom_cm": "9000000902",
      "uatcap_groom_east": "9000000903",
      "uatcap_groom_south": "9000000904",
      "uatcap_groom_north": "9000000905",
      "uatcap_groom_west": "9000000906",
      "uatcap_groom_central": "9000000907",
      "uatcap_train_ft": "9000000931",
      "uatcap_train_east": "9000000932",
      "uatcap_train_south": "9000000933",
      "uatcap_train_north": "9000000934",
      "uatcap_train_west": "9000000935",
      "uatcap_train_central": "9000000936",
      "uatcap_train_ft_2": "9000000937",
      "uatcap_train_ft_3": "9000000938",
      "uatcap_train_ft_4": "9000000939",
      "uatcap_train_ft_5": "9000000940",
      "host_arjun_tara": "9000000970",
      "host_maa_meena": "9000000971",
      "host_maya_rohan": "9000000972",
      "host_priya_dev": "9000000973",
      "host_sana": "9000000974",
      "sit_asha": "9000000975",
      "sit_neha": "9000000976",
      "sit_sana": "9000000977",
      "taxi_imran": "9000000978",
      "taxi_maa_arun": "9000000979",
      "taxi_meera": "9000000980",
      "taxi_rahul": "9000000981",
      "uatcap_host_cm": "9000000982",
      "uatcap_sit_cm": "9000000983",
      "uatcap_taxi_ft": "9000000984",
      "uatcap_walk_ft": "9000000985",
      "walk_asha": "9000000986",
      "walk_kiran": "9000000987",
      "walk_maa_divya": "9000000988",
      "walk_nisha": "9000000989",
      "uatcap_groom_east_2": "9000000911",
      "uatcap_groom_east_3": "9000000912",
      "uatcap_groom_south_2": "9000000913",
      "uatcap_groom_south_3": "9000000914",
      "uatcap_groom_north_2": "9000000915",
      "uatcap_groom_north_3": "9000000916",
      "uatcap_groom_west_2": "9000000917",
      "uatcap_groom_west_3": "9000000918",
      "uatcap_groom_central_2": "9000000919",
      "uatcap_groom_central_3": "9000000920",
      "uatcap_groom_east_4": "9000000921",
      "uatcap_groom_east_5": "9000000922",
      "uatcap_groom_south_4": "9000000923",
      "uatcap_groom_south_5": "9000000924",
      "uatcap_groom_north_4": "9000000925",
      "uatcap_groom_north_5": "9000000926",
      "uatcap_groom_west_4": "9000000927",
      "uatcap_groom_west_5": "9000000928",
      "uatcap_groom_central_4": "9000000929",
      "uatcap_groom_central_5": "9000000930",
      "uatcap_host_east_1": "9000003101",
      "uatcap_host_east_2": "9000003102",
      "uatcap_host_east_3": "9000003103",
      "uatcap_host_east_4": "9000003104",
      "uatcap_host_east_5": "9000003105",
      "uatcap_host_east_6": "9000003106",
      "uatcap_host_east_7": "9000003107",
      "uatcap_host_south_1": "9000003201",
      "uatcap_host_south_2": "9000003202",
      "uatcap_host_south_3": "9000003203",
      "uatcap_host_south_4": "9000003204",
      "uatcap_host_south_5": "9000003205",
      "uatcap_host_south_6": "9000003206",
      "uatcap_host_south_7": "9000003207",
      "uatcap_host_north_1": "9000003301",
      "uatcap_host_north_2": "9000003302",
      "uatcap_host_north_3": "9000003303",
      "uatcap_host_north_4": "9000003304",
      "uatcap_host_north_5": "9000003305",
      "uatcap_host_north_6": "9000003306",
      "uatcap_host_north_7": "9000003307",
      "uatcap_host_west_1": "9000003401",
      "uatcap_host_west_2": "9000003402",
      "uatcap_host_west_3": "9000003403",
      "uatcap_host_west_4": "9000003404",
      "uatcap_host_west_5": "9000003405",
      "uatcap_host_west_6": "9000003406",
      "uatcap_host_west_7": "9000003407",
      "uatcap_host_central_1": "9000003501",
      "uatcap_host_central_2": "9000003502",
      "uatcap_host_central_3": "9000003503",
      "uatcap_host_central_4": "9000003504",
      "uatcap_host_central_5": "9000003505",
      "uatcap_host_central_6": "9000003506",
      "uatcap_host_central_7": "9000003507",
      "uatcap_sit_east_1": "9000004101",
      "uatcap_sit_east_2": "9000004102",
      "uatcap_sit_east_3": "9000004103",
      "uatcap_sit_east_4": "9000004104",
      "uatcap_sit_east_5": "9000004105",
      "uatcap_sit_east_6": "9000004106",
      "uatcap_sit_east_7": "9000004107",
      "uatcap_sit_east_8": "9000004108",
      "uatcap_sit_south_1": "9000004201",
      "uatcap_sit_south_2": "9000004202",
      "uatcap_sit_south_3": "9000004203",
      "uatcap_sit_south_4": "9000004204",
      "uatcap_sit_south_5": "9000004205",
      "uatcap_sit_south_6": "9000004206",
      "uatcap_sit_south_7": "9000004207",
      "uatcap_sit_south_8": "9000004208",
      "uatcap_sit_north_1": "9000004301",
      "uatcap_sit_north_2": "9000004302",
      "uatcap_sit_north_3": "9000004303",
      "uatcap_sit_north_4": "9000004304",
      "uatcap_sit_north_5": "9000004305",
      "uatcap_sit_north_6": "9000004306",
      "uatcap_sit_north_7": "9000004307",
      "uatcap_sit_north_8": "9000004308",
      "uatcap_sit_west_1": "9000004401",
      "uatcap_sit_west_2": "9000004402",
      "uatcap_sit_west_3": "9000004403",
      "uatcap_sit_west_4": "9000004404",
      "uatcap_sit_west_5": "9000004405",
      "uatcap_sit_west_6": "9000004406",
      "uatcap_sit_west_7": "9000004407",
      "uatcap_sit_west_8": "9000004408",
      "uatcap_sit_central_1": "9000004501",
      "uatcap_sit_central_2": "9000004502",
      "uatcap_sit_central_3": "9000004503",
      "uatcap_sit_central_4": "9000004504",
      "uatcap_sit_central_5": "9000004505",
      "uatcap_sit_central_6": "9000004506",
      "uatcap_sit_central_7": "9000004507",
      "uatcap_sit_central_8": "9000004508",
      "uatcap_taxi_east_1": "9000005101",
      "uatcap_taxi_east_2": "9000005102",
      "uatcap_taxi_east_3": "9000005103",
      "uatcap_taxi_east_4": "9000005104",
      "uatcap_taxi_east_5": "9000005105",
      "uatcap_taxi_east_6": "9000005106",
      "uatcap_taxi_east_7": "9000005107",
      "uatcap_taxi_east_8": "9000005108",
      "uatcap_taxi_east_9": "9000005109",
      "uatcap_taxi_east_10": "9000005110",
      "uatcap_taxi_south_1": "9000005201",
      "uatcap_taxi_south_2": "9000005202",
      "uatcap_taxi_south_3": "9000005203",
      "uatcap_taxi_south_4": "9000005204",
      "uatcap_taxi_south_5": "9000005205",
      "uatcap_taxi_south_6": "9000005206",
      "uatcap_taxi_south_7": "9000005207",
      "uatcap_taxi_south_8": "9000005208",
      "uatcap_taxi_south_9": "9000005209",
      "uatcap_taxi_south_10": "9000005210",
      "uatcap_taxi_north_1": "9000005301",
      "uatcap_taxi_north_2": "9000005302",
      "uatcap_taxi_north_3": "9000005303",
      "uatcap_taxi_north_4": "9000005304",
      "uatcap_taxi_north_5": "9000005305",
      "uatcap_taxi_north_6": "9000005306",
      "uatcap_taxi_north_7": "9000005307",
      "uatcap_taxi_north_8": "9000005308",
      "uatcap_taxi_north_9": "9000005309",
      "uatcap_taxi_north_10": "9000005310",
      "uatcap_taxi_west_1": "9000005401",
      "uatcap_taxi_west_2": "9000005402",
      "uatcap_taxi_west_3": "9000005403",
      "uatcap_taxi_west_4": "9000005404",
      "uatcap_taxi_west_5": "9000005405",
      "uatcap_taxi_west_6": "9000005406",
      "uatcap_taxi_west_7": "9000005407",
      "uatcap_taxi_west_8": "9000005408",
      "uatcap_taxi_west_9": "9000005409",
      "uatcap_taxi_west_10": "9000005410",
      "uatcap_taxi_central_1": "9000005501",
      "uatcap_taxi_central_2": "9000005502",
      "uatcap_taxi_central_3": "9000005503",
      "uatcap_taxi_central_4": "9000005504",
      "uatcap_taxi_central_5": "9000005505",
      "uatcap_taxi_central_6": "9000005506",
      "uatcap_taxi_central_7": "9000005507",
      "uatcap_taxi_central_8": "9000005508",
      "uatcap_taxi_central_9": "9000005509",
      "uatcap_taxi_central_10": "9000005510"
    });
  }
});

// three-chat-release-review/lib/customer-phone.ts
function phoneDigitsSql(column) {
  return `replace(replace(replace(replace(replace(replace(COALESCE(${column},''),'+',''),' ',''),'-',''),'(',''),')',''),'.','')`;
}
function samePhoneForms(tenDigits) {
  return [tenDigits, `91${tenDigits}`, `0${tenDigits}`, `091${tenDigits}`, `0091${tenDigits}`];
}
function samePhoneSql(column) {
  return `${phoneDigitsSql(column)} IN (?,?,?,?,?)`;
}
var init_customer_phone = __esm({
  "three-chat-release-review/lib/customer-phone.ts"() {
  }
});

// atlas-revision-diagnostic-review/lib/staging-fixture-isolation.ts
var staging_fixture_isolation_exports = {};
__export(staging_fixture_isolation_exports, {
  STAGING_FIXTURE_ISOLATION_PATH: () => STAGING_FIXTURE_ISOLATION_PATH,
  fixtureRecipientExclusion: () => fixtureRecipientExclusion,
  handleStagingFixtureIsolation: () => handleStagingFixtureIsolation
});
function fixtureRecipientExclusion(env, phones, emails = []) {
  const generic = list(env.PAWSPACE_COMMUNICATION_UAT_ALLOWLIST);
  const meta = list(env.META_WHATSAPP_UAT_ALLOWLIST || env.PAWSPACE_COMMUNICATION_UAT_ALLOWLIST);
  const p = phones.map(text).filter(Boolean), e = emails.map(text).filter(Boolean);
  return {
    genericExcluded: p.every((phone) => !generic.some((entry) => entry === phone || digits(phone) !== "" && digits(entry) === digits(phone))) && e.every((email) => !generic.some((entry) => entry.toLowerCase() === email.toLowerCase())),
    metaExcluded: p.every((phone) => !meta.some((entry) => digits(entry) === digits(phone))),
    voiceExcluded: p.every((phone) => !isVoiceAllowlisted(env, phone))
  };
}
async function handleStagingFixtureIsolation(request, db, env) {
  const url = new URL(request.url);
  if (url.pathname !== STAGING_FIXTURE_ISOLATION_PATH) return null;
  if (text(env.PAWSPACE_DEPLOYMENT_ENV) !== "staging" || text(env.PAWSPACE_ENV) !== "staging" || text(env.FORBID_PRODUCTION) !== "true" || text(env.PAWSPACE_PRODUCTION_ENFORCE) !== "false" || !/^pawspace-staging\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) || url.protocol !== "https:") return json({ ok: false, code: "not_found" }, 404);
  if (request.method !== "GET") return json({ ok: false, code: "method_not_allowed" }, 405);
  try {
    const actor = await resolveUatStaffActor(db, request, env);
    if (!actor) return json({ ok: false, code: "authentication_required" }, 401);
    if (actor.roleCode !== "founder" || !actor.permissions.includes("*")) return json({ ok: false, code: "founder_required" }, 403);
    if ([...url.searchParams.keys()].some((key) => !["expectedSha", "scope"].includes(key)) || url.searchParams.getAll("expectedSha").length !== 1 || !SHA.test(url.searchParams.get("expectedSha") || "")) return json({ ok: false, code: "expected_revision_required" }, 400);
    const scope2 = url.searchParams.get("scope") ?? "bengaluru_roster";
    if (url.searchParams.getAll("scope").length > 1 || !["bengaluru_roster", "grooming_strict"].includes(scope2)) return json({ ok: false, code: "fixed_scope_required" }, 400);
    const strictGrooming = scope2 === "grooming_strict";
    const expectedSha = url.searchParams.get("expectedSha");
    const metadata = env.PAWSPACE_VERSION_METADATA;
    const revisionProven = SHA.test(text(env.PAWSPACE_STAGING_BUILD_SHA)) && expectedSha === text(env.PAWSPACE_STAGING_BUILD_SHA) && UUID.test(text(metadata?.id)) && Number.isFinite(Date.parse(text(metadata?.timestamp)));
    if (!revisionProven) return json({ ok: false, code: "revision_unproven", checks: { buildShaValid: SHA.test(text(env.PAWSPACE_STAGING_BUILD_SHA)), buildShaMatchesExpected: expectedSha === text(env.PAWSPACE_STAGING_BUILD_SHA), versionIdValid: UUID.test(text(metadata?.id)), versionTimestampValid: Number.isFinite(Date.parse(text(metadata?.timestamp))) } }, 409);
    const gates = {
      paymentSandbox: text(env.PAWSPACE_PAYMENT_ENV) === "sandbox" && text(env.PAWSPACE_PAYMENT_LIVE_APPROVED) === "false",
      payoutsSandbox: text(env.PAWSPACE_RAZORPAYX_ENV) === "sandbox" && text(env.PAWSPACE_RAZORPAYX_LIVE_APPROVED) === "false",
      communicationsUat: text(env.PAWSPACE_COMMUNICATION_ENV) === "uat",
      voiceNotLive: ["uat", "disabled"].includes(text(env.PAWSPACE_VOICE_ENV)),
      customerLiveOtpDisabled: text(env.PAWSPACE_STAGING_LIVE_CUSTOMER_OTP) === "false",
      productionOtpDisabled: text(env.PAWSPACE_DEPLOYMENT_ENV) === "staging",
      schedulerUat: text(env.PAWSPACE_SCHEDULING_ENV) === "uat"
    };
    if (!Object.values(gates).every(Boolean)) return json({ ok: false, code: "runtime_isolation_unproven", checks: gates }, 409);
    const customers = await db.prepare("SELECT id,city_id,primary_phone,secondary_phone,email,source FROM canonical_customers WHERE id='CUS0000'").all();
    const customer = customers.results?.[0];
    const customerProven = customers.results?.length === 1 && customer?.city_id === "blr" && customer?.source === "uat_seed" && text(customer?.primary_phone) === "9100000000" && !text(customer?.secondary_phone) && !text(customer?.email);
    const customerOtpTargets = await db.prepare(`SELECT id FROM canonical_customers WHERE ${samePhoneSql("primary_phone")} ORDER BY id LIMIT 2`).bind(...samePhoneForms("9100000000")).all();
    const customerOtpTargetUnambiguous = customerOtpTargets.results?.length === 1 && customerOtpTargets.results[0].id === "CUS0000";
    const roster = await db.prepare(strictGrooming ? "SELECT p.id,p.city_id capacity_city_id,p.updated_by,p.services_json,p.live,p.status,p.provider_model,c.id canonical_id,c.city_id,c.phone,c.email,c.source FROM provider_capacity_profiles p LEFT JOIN canonical_providers c ON c.id=p.id WHERE p.id='uatcap_groom_ft' ORDER BY p.id LIMIT 2" : "SELECT p.id,p.city_id capacity_city_id,p.updated_by,p.services_json,c.id canonical_id,c.city_id,c.phone,c.email,c.source FROM provider_capacity_profiles p LEFT JOIN canonical_providers c ON c.id=p.id WHERE p.city_id='blr' OR EXISTS (SELECT 1 FROM boarding_host_profiles h WHERE h.provider_id=p.id AND h.city_id='blr') ORDER BY p.id LIMIT 257").all();
    const rows = roster.results || [];
    const providerProven = (row) => Object.hasOwn(STAGING_PROVIDER_FIXTURES, text(row.id)) && row.canonical_id === row.id && row.capacity_city_id === "blr" && row.city_id === "blr" && row.source === "uat_staging_seed" && row.updated_by === "founder_seed" && text(row.phone) === STAGING_PROVIDER_FIXTURES[text(row.id)] && !text(row.email);
    const fixedProvidersProven = REQUIRED_PROVIDERS.every((id) => rows.some((row) => row.id === id && providerProven(row)));
    const rosterProven = rows.length > 0 && rows.length <= 256 && new Set(rows.map((row) => row.id)).size === rows.length && rows.every(providerProven);
    const recipients = [...customer ? [customer.primary_phone, customer.secondary_phone] : [], ...rows.map((row) => row.phone)];
    const emails = [...customer ? [customer.email] : [], ...rows.map((row) => row.email)];
    const exclusion = fixtureRecipientExclusion(env, recipients, emails);
    let groomingServiceProven = false;
    if (strictGrooming && rows.length === 1) {
      try {
        const services = JSON.parse(text(rows[0].services_json));
        groomingServiceProven = Array.isArray(services) && services.includes("grooming");
      } catch {
      }
    }
    const strictGroomerProven = strictGrooming && rows.length === 1 && providerProven(rows[0]) && rows[0].id === "uatcap_groom_ft" && rows[0].provider_model === "full_time" && Number(rows[0].live) === 1 && rows[0].status === "active" && groomingServiceProven;
    const groomerOtpTargets = strictGrooming ? await db.prepare("SELECT id FROM canonical_providers WHERE phone='9000000901' ORDER BY id LIMIT 2").all() : null;
    const groomerOtpTargetUnambiguous = groomerOtpTargets?.results?.length === 1 && groomerOtpTargets.results[0].id === "uatcap_groom_ft";
    const checks = { ...gates, customerFixtureProven: customerProven, customerOtpTargetUnambiguous, ...strictGrooming ? { specificGroomerFixtureProven: strictGroomerProven, groomerOtpTargetUnambiguous } : { fixedProviderFixturesProven: fixedProvidersProven, bengaluruCapacityRosterProven: rosterProven }, ...exclusion };
    const ok = Object.values(checks).every(Boolean);
    const fixtureSnapshotId = ok ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ scope: scope2, customer, roster: rows, checks })))), (byte) => byte.toString(16).padStart(2, "0")).join("") : null;
    return json({ ok, fixtureSnapshotId, code: ok ? "fixed_fixture_snapshot_attested" : "fixed_fixture_isolation_unproven", scope: strictGrooming ? "grooming_strict" : "documented_synthetic_customer_and_bengaluru_capacity_roster", checks, version: { id: text(metadata?.id), buildSha: expectedSha }, observedAt: (/* @__PURE__ */ new Date()).toISOString(), strictProviderSelectionRequired: strictGrooming, automaticAssignmentCovered: false, reassignmentRecoveryCovered: false, assignmentLock: false, bookingMutationAuthorized: false, staffFallbackRecipientsCovered: false, alternateProviderTablesCovered: false, productionReadiness: false, requiresMatchingDeploymentIsolationCertificate: true }, ok ? 200 : 409);
  } catch {
    return json({ ok: false, code: "read_only_evidence_unavailable" }, 503);
  }
}
var STAGING_FIXTURE_ISOLATION_PATH, text, digits, list, SHA, UUID, REQUIRED_PROVIDERS, json;
var init_staging_fixture_isolation = __esm({
  "atlas-revision-diagnostic-review/lib/staging-fixture-isolation.ts"() {
    init_uat_staging_auth();
    init_voice_call_gate();
    init_staging_fixture_provider_manifest();
    init_customer_phone();
    STAGING_FIXTURE_ISOLATION_PATH = "/__staging/fixture-isolation";
    text = (value) => String(value ?? "").trim();
    digits = (value) => text(value).replace(/\D/g, "");
    list = (value) => text(value).split(",").map(text).filter(Boolean);
    SHA = /^[0-9a-f]{40}$/;
    UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    REQUIRED_PROVIDERS = ["uatcap_groom_ft", "uatcap_train_ft", "uatcap_train_ft_3", "uatcap_train_ft_5", "uatcap_host_cm", "uatcap_sit_cm", "uatcap_taxi_ft", "uatcap_walk_ft"];
    json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store, private", "pragma": "no-cache", "x-content-type-options": "nosniff" } });
  }
});

// atlas-revision-diagnostic-review/lib/atlas-native-boundary.mjs
import { AsyncLocalStorage } from "node:async_hooks";

// atlas-revision-diagnostic-review/lib/atlas-generation-shape-guard.mjs
var END = Date.parse("2026-10-04T03:30:00Z");
var START = Date.parse("2026-10-04T02:21:19Z");
var fail = () => {
  throw new Error("FINANCE_TEST_OUTBOUND_DENIED");
};
function installGenerationGuard(target = globalThis, now = () => Date.now()) {
  const native = target.fetch.bind(target);
  const guarded = async (input, init) => {
    if (now() < START || now() >= END || typeof input !== "string" || !init) fail();
    const method = init.method, bodyString = init.body, headerInput = init.headers, signalInput = init.signal;
    if (method !== "POST" || typeof bodyString !== "string") fail();
    const u = new URL(input);
    if (input !== "https://api.openai.com/v1/responses" || u.search || u.hash || u.username || u.password || u.port) fail();
    if (new TextEncoder().encode(bodyString).length > 2e4) fail();
    let p;
    try {
      p = JSON.parse(bodyString);
    } catch {
      fail();
    }
    if (!p || Array.isArray(p) || Object.keys(p).sort().join(",") !== "input,instructions,max_output_tokens,model,prompt_cache_options,service_tier,store,truncation") fail();
    if (p.model !== "gpt-5.6-terra" || typeof p.instructions !== "string" || typeof p.input !== "string" || !Number.isSafeInteger(p.max_output_tokens) || p.max_output_tokens < 1 || p.max_output_tokens > 1200 || p.store !== false || p.service_tier !== "default" || p.truncation !== "disabled" || !p.prompt_cache_options || Object.keys(p.prompt_cache_options).join(",") !== "mode" || p.prompt_cache_options.mode !== "explicit") fail();
    const headers = new Headers(headerInput);
    if (headers.get("content-type") !== "application/json" || !/^Bearer [^\s]+$/.test(headers.get("authorization") ?? "")) fail();
    if ([...headers.keys()].some((k) => !["authorization", "content-type"].includes(k))) fail();
    const remaining = END - now();
    if (remaining <= 0) fail();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("FINANCE_TEST_OUTBOUND_TIMEOUT")), Math.min(3e4, remaining));
    const signal = AbortSignal.any([deadline.signal, ...signalInput ? [signalInput] : []]);
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason ?? new Error("FINANCE_TEST_OUTBOUND_TIMEOUT"));
    signal.addEventListener("abort", onAbort, { once: true });
    let reader;
    try {
      if (signal.aborted) throw signal.reason;
      const response = await Promise.race([native(input, { method: "POST", body: bodyString, headers, credentials: "omit", redirect: "manual", signal }), aborted]);
      if (response.status >= 300 && response.status < 400) fail();
      reader = response.body?.getReader();
      let bytes = 0;
      const chunks = [];
      if (reader) while (true) {
        if (signal.aborted) throw signal.reason;
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 262144) fail();
        chunks.push(value);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (reader) void reader.cancel(error).catch(() => {
      });
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
  Object.defineProperty(target, "fetch", { value: guarded, writable: false, configurable: false });
  Object.defineProperty(target, "WebSocket", { value: class {
    constructor() {
      fail();
    }
  }, writable: false, configurable: false });
  return guarded;
}

// atlas-revision-diagnostic-review/lib/atlas-native-boundary.mjs
var scope = new AsyncLocalStorage();
var deny = () => {
  throw new Error("ATLAS_NATIVE_TRANSPORT_DENIED");
};
var installed = false;
function installAtlasNativeBoundary(target = globalThis) {
  if (installed) return;
  installed = true;
  const native = target.fetch.bind(target), NativeWebSocket = target.WebSocket;
  const shapeTarget = { fetch: native };
  const exactGeneration = installGenerationGuard(shapeTarget);
  Object.defineProperty(target, "fetch", { configurable: false, writable: false, value: async (input, init) => {
    const context = scope.getStore();
    if (!context) deny();
    if (context.kind === "ordinary") return native(input, init);
    if (!init || typeof input !== "string") deny();
    const snapshot = { method: init.method, body: init.body, headers: init.headers, signal: init.signal };
    const permit = context.permit;
    if (!permit || permit.used || input !== "https://api.openai.com/v1/responses" || snapshot.method !== "POST" || snapshot.body !== permit.body || Date.now() >= permit.expiresAt) deny();
    permit.used = true;
    return exactGeneration(input, snapshot);
  } });
  Object.defineProperty(target, "WebSocket", { configurable: false, writable: false, value: class {
    constructor(...args) {
      if (scope.getStore()?.kind !== "ordinary" || !NativeWebSocket) deny();
      return Reflect.construct(NativeWebSocket, args);
    }
  } });
}
function withAtlasNativeScope(kind, operation) {
  if (kind !== "ordinary" && kind !== "atlas") deny();
  return scope.run({ kind, permit: null }, operation);
}

// atlas-revision-diagnostic-review/worker/atlas-api-entry.ts
installAtlasNativeBoundary();
function assertBindings(env) {
  for (const [name, value] of Object.entries(env)) {
    if (name === "DB") {
      if (!value || typeof value !== "object" || !("prepare" in value) || "fetch" in value) throw Error("Atlas D1 binding invalid");
      continue;
    }
    if (name === "PAWSPACE_VERSION_METADATA") {
      if (!value || typeof value !== "object" || Object.values(value).some((v) => typeof v !== "string")) throw Error("Atlas metadata invalid");
      continue;
    }
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw Error("Atlas alternate binding denied");
  }
}
var atlas_api_entry_default = { async fetch(request, env, ctx) {
  if (env.PAWSPACE_DEPLOYMENT_ENV !== "staging" || env.PAWSPACE_PAYMENT_ENV !== "sandbox" || env.PAWSPACE_ISOLATED_FINANCE_TEST !== "true" || !String(env.PAWSPACE_ATLAS_TEXT_TEST_JOB_ID ?? "").trim()) return new Response("Atlas job disabled", { status: 503 });
  const url = new URL(request.url);
  if (url.origin !== env.FINANCE_TEST_ORIGIN || request.headers.has("origin") && request.headers.get("origin") !== url.origin) return new Response("Atlas origin denied", { status: 403 });
  if (request.method !== "GET" || url.pathname !== "/__staging/fixture-isolation") return new Response("Atlas diagnostic route denied", { status: 403 });
  return withAtlasNativeScope("atlas", async () => {
    assertBindings(env);
    const { env: actualEnv } = await import("cloudflare:workers");
    assertBindings(actualEnv);
    const { handleStagingFixtureIsolation: handleStagingFixtureIsolation2 } = await Promise.resolve().then(() => (init_staging_fixture_isolation(), staging_fixture_isolation_exports));
    return await handleStagingFixtureIsolation2(request, env.DB, env) ?? new Response("Not found", { status: 404 });
  });
} };
export {
  atlas_api_entry_default as default
};
