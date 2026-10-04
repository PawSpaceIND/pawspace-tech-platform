// three-chat-release-review/lib/employee-exit-access.ts
async function employeeAccessHasEnded(db, email, asOf = Date.now()) {
  const exists = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_exit_cases'").first();
  if (!exists) return false;
  return Boolean(await db.prepare(EMPLOYEE_EXIT_CUTOFF_SQL).bind(email.trim().toLowerCase(), email.trim().toLowerCase(), asOf).first());
}
var EMPLOYEE_EXIT_CUTOFF_SQL = "SELECT id FROM employee_exit_cases WHERE (identity_email=? OR user_id IN (SELECT id FROM app_users WHERE lower(email)=?)) AND status IN ('approved','access_revoked','settled_sandbox') AND access_ends_at<=? LIMIT 1";

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

// three-chat-release-review/lib/security-crypto.ts
var encoder = new TextEncoder();
var CONSTANT_TIME_COMPARE_BYTES = 512;
function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left ?? "")), b = encoder.encode(String(right ?? ""));
  if (a.length > CONSTANT_TIME_COMPARE_BYTES || b.length > CONSTANT_TIME_COMPARE_BYTES) return false;
  let diff = a.length ^ b.length;
  for (let index = 0; index < CONSTANT_TIME_COMPARE_BYTES; index++) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

// three-chat-release-review/lib/d1-transient.ts
var REFUSED_BEFORE_EXECUTION = /Currently processing a long-running import|D1 DB is overloaded|Too many requests queued/i;
function messageOf(value) {
  if (value instanceof Error) return `${value.message} ${value.cause instanceof Error ? value.cause.message : ""}`;
  return typeof value === "string" ? value : "";
}
function isTransientD1Refusal(value) {
  return REFUSED_BEFORE_EXECUTION.test(messageOf(value));
}

// three-chat-release-review/lib/uat-staging-auth.ts
var COOKIE = "pawspace_uat";
var enc = new TextEncoder();
var UAT_SIGNING_KEY_MIN_LENGTH = 32;
function uatLoginEnabled(env) {
  return String(env?.PAWSPACE_UAT_LOGIN || "") === "on" && String(env?.PAWSPACE_UAT_SIGNING_KEY || "").length >= UAT_SIGNING_KEY_MIN_LENGTH;
}
function signInRequiredResponse(env) {
  if (!uatLoginEnabled(env)) return Response.json({ error: "Authentication required" }, { status: 401 });
  return Response.json({ error: "Your staging sign-in has expired. Open /staging-login to sign in again.", code: "sign_in_required", signInUrl: "/staging-login" }, { status: 401, headers: { "cache-control": "no-store" } });
}
function uatAccessCodeValid(env, code) {
  const expected = String(env?.PAWSPACE_UAT_ACCESS_CODE || "");
  return expected.length > 0 && constantTimeEqual(String(code || ""), expected);
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
async function issueUatToken(env, email, ttlSeconds) {
  const exp = Date.now() + Math.max(60, ttlSeconds) * 1e3;
  const payload = b64url(enc.encode(JSON.stringify({ email: String(email).trim().toLowerCase(), exp })));
  const sig = await hmac(String(env.PAWSPACE_UAT_SIGNING_KEY), payload);
  return `${payload}.${sig}`;
}
function uatCookie(token, ttlSeconds) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(60, ttlSeconds)}`;
}
function clearUatCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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
var uatActorReads = /* @__PURE__ */ new WeakMap();
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
async function uatStaffIdentityAllowed(db, email) {
  const row = await readStaffDirectory(() => db.prepare("SELECT status,role_code FROM app_users WHERE email=?").bind(String(email).trim().toLowerCase()).first());
  if (!row || String(row.status) !== "active") return false;
  if (await employeeAccessHasEnded(db, email)) return false;
  const roleCode = String(row.role_code || "").trim();
  if (!roleCode) return false;
  const role = await readStaffDirectory(() => db.prepare("SELECT code FROM role_definitions WHERE code=?").bind(roleCode).first());
  return Boolean(role);
}
export {
  UAT_SIGNING_KEY_MIN_LENGTH,
  clearUatCookie,
  issueUatToken,
  resolveUatStaffActor,
  signInRequiredResponse,
  uatAccessCodeValid,
  uatCookie,
  uatLoginEnabled,
  uatStaffIdentityAllowed
};
