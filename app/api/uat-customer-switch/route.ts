import { database } from "../../../lib/server-auth";
import { ensureCustomerAccountTables } from "../../../lib/customer-account";
import { ensureIdentityBindingTables, upsertIdentityBinding } from "../../../lib/identity-binding";
import { issuePlatformSession, platformSessionCookie } from "../../../lib/platform-session";
import { clearUatCookie, uatAccessCodeValid } from "../../../lib/uat-staging-auth";
import { UAT_CUSTOMER_PERSONAS, UAT_CUSTOMER_SOURCE, uatCustomerTestingEnabled } from "../../../lib/uat-customer-testing";

const json = (value: unknown, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return Response.json(value, { status, headers });
};
export async function GET(request: Request) {
  const { env } = await import("cloudflare:workers");
  if (!uatCustomerTestingEnabled(request, env as unknown as Record<string, unknown>)) return json({ enabled: false }, 404);
  return json({ enabled: true, personas: UAT_CUSTOMER_PERSONAS.map(({ key, name }) => ({ key, name })) });
}
export async function POST(request: Request) {
  const { env } = await import("cloudflare:workers");
  if (!uatCustomerTestingEnabled(request, env as unknown as Record<string, unknown>)) return json({ error: "Test customer access is not enabled here" }, 404);
  if (request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "Same-origin test access is required" }, 403);
  const body = await request.json().catch(() => null) as { code?: unknown; persona?: unknown } | null;
  if (!body || !uatAccessCodeValid(env as never, body.code)) return json({ error: "Invalid UAT access code" }, 401);
  const persona = UAT_CUSTOMER_PERSONAS.find(item => item.key === body.persona);
  if (!persona) return json({ error: "Choose a listed synthetic customer" }, 400);
  try {
    const db = await database();
    await ensureCustomerAccountTables(db);
    const collision = await db.prepare("SELECT id FROM canonical_customers WHERE primary_phone=? AND id<>? LIMIT 1").bind(persona.phone, persona.id).first();
    if (collision) return json({ error: "Synthetic phone conflicts with another customer; no session issued" }, 409);
    const now = Date.now(), expiresAt = now + 86_400_000;
    await db.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,'blr',?,?,NULL,NULL,?,?,?,?)")
      .bind(persona.id, persona.name, persona.phone, UAT_CUSTOMER_SOURCE, JSON.stringify({ marketing: false, whatsapp: false, sms: false, email: false }), now, now).run();
    const customer = await db.prepare("SELECT id,name,primary_phone,source FROM canonical_customers WHERE id=?").bind(persona.id).first<Record<string, unknown>>();
    // Normal profile edits can update source; an existing issuer-owned binding preserves fixture provenance.
    await ensureIdentityBindingTables(db);
    const principalKey = `uat-customer:${persona.id}`;
    const issuedBefore = await db.prepare("SELECT id FROM identity_bindings WHERE identity_source='uat_persona' AND principal_key=? AND subject_type='customer' AND subject_id=? AND created_by='uat-customer-switch' LIMIT 1").bind(principalKey, persona.id).first();
    if (!customer || (customer.source !== UAT_CUSTOMER_SOURCE && !issuedBefore) || customer.primary_phone !== persona.phone)
      return json({ error: "Synthetic customer fixture conflicts with an existing record; no session issued" }, 409);
    const binding = await upsertIdentityBinding(db, {
      identitySource: "uat_persona", principalType: "identity_subject", principalKey,
      subjectType: "customer", subjectId: persona.id, cityId: "blr", verificationState: "verified", expiresAt,
      metadata: { synthetic: true, phoneOwnershipVerified: false }, actorId: "uat-customer-switch",
      reason: "Explicit staging test-customer selection; no real phone ownership asserted",
    });
    const issued = await issuePlatformSession(db, {
      bindingId: String(binding?.id || ""), identitySource: "uat_persona", principalType: "identity_subject", principalKey,
      subjectType: "customer", subjectId: persona.id, ttlSeconds: 86_400, metadata: { synthetic: true, cityId: "blr" },
    });
    return json({ data: { customerId: persona.id, customerName: customer.name, synthetic: true, expiresAt: issued.session.expiresAt } }, 200, [platformSessionCookie(issued.token, issued.ttlSeconds), clearUatCookie()]);
  } catch { return json({ error: "Unable to start a synthetic customer session; no successful sign-in confirmed" }, 500); }
}
