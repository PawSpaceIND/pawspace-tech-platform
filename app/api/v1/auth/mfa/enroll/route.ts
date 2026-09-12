import { database, resolvePrimaryActor, securityAudit } from "../../../../../../lib/server-auth";
import { ensureAdminMfaTables, newTotpSecret, privilegedRole, verifyTotp } from "../../../../../../lib/admin-mfa";

type Row = Record<string, unknown>;

export async function POST(request: Request) {
  const actor = await resolvePrimaryActor(request);
  if (!privilegedRole(actor.roleCode)) return Response.json({ error: "Privileged role required" }, { status: 403 });
  const db = await database();
  await ensureAdminMfaTables(db);
  const user = actor.userId
    ? await db.prepare("SELECT id,mfa_enabled,mfa_secret FROM app_users WHERE id=?").bind(actor.userId).first<Row>()
    : await db.prepare("SELECT id,mfa_enabled,mfa_secret FROM app_users WHERE email=?").bind(actor.email).first<Row>();
  if (!user) return Response.json({ error: "Privileged identity unavailable" }, { status: 403 });
  if (Number(user.mfa_enabled) === 1) return Response.json({ error: "MFA is already enrolled" }, { status: 409 });

  const body = await request.json().catch(() => ({})) as Row;
  const code = String(body.code ?? "").trim();
  const userId = String(user.id);
  if (code) {
    const secret = String(user.mfa_secret ?? "").trim();
    if (!secret) return Response.json({ error: "Start MFA enrollment first" }, { status: 409 });
    if (!await verifyTotp(secret, code)) return Response.json({ error: "Invalid MFA code" }, { status: 401 });
    await db.prepare("UPDATE app_users SET mfa_enabled=1,updated_at=? WHERE id=?").bind(Date.now(), userId).run();
    await securityAudit(db, { ...actor, userId }, "auth.mfa.enroll", "app_user", userId, "completed", { method: "totp" });
    return Response.json({ data: { enabled: true } }, { status: 200, headers: { "cache-control": "no-store" } });
  }

  const secret = String(user.mfa_secret ?? "").trim() || newTotpSecret();
  if (!String(user.mfa_secret ?? "").trim()) {
    await db.prepare("UPDATE app_users SET mfa_secret=?,mfa_enabled=0,updated_at=? WHERE id=?").bind(secret, Date.now(), userId).run();
  }
  const issuer = "PawSpace";
  const label = encodeURIComponent(`${issuer}:${actor.email}`);
  const otpauthUri = `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return Response.json({ data: { secret, otpauthUri, enabled: false } }, { status: 201, headers: { "cache-control": "no-store" } });
}
