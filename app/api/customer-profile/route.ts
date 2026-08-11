import { authError, database, resolveActor } from "../../../lib/server-auth";

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    if (actor.principalType !== "identity_subject" || !actor.identitySource.includes("otp") || !actor.email.startsWith("customer:")) {
      return Response.json({ error: "Customer session required" }, { status: 401 });
    }
    const customerId = actor.email.slice("customer:".length);
    const db = await database();
    const row = await db.prepare("SELECT id,name,primary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<{ id: string; name: string; primary_phone: string }>();
    if (!row) return Response.json({ error: "Customer not found" }, { status: 404 });
    return Response.json({ data: { customerId: row.id, customerName: row.name, phone: row.primary_phone } });
  } catch (error) {
    return authError(error, "Unable to load profile");
  }
}
