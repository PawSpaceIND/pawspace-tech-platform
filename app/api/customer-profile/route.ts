import { authError, database } from "../../../lib/server-auth";
import { resolvePlatformSession } from "../../../lib/platform-session";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
export async function GET(request: Request) {
  try {
    const db = await database();
    // Reconstruct the profile from the validated customer binding, not an OTP-source label
    // or a caller-supplied customer id. Staging test sessions are validated by the same resolver.
    const session = await resolvePlatformSession(db, request);
    if (!session || session.subjectType !== "customer" || session.roleCode !== "customer") {
      return json({ error: "Customer session required" }, 401);
    }
    const row = await db.prepare("SELECT id,name,primary_phone FROM canonical_customers WHERE id=?").bind(session.subjectId).first<{ id: string; name: string; primary_phone: string }>();
    if (!row) return json({ error: "Customer not found" }, 404);
    return json({ data: { customerId: row.id, customerName: row.name, phone: row.primary_phone } });
  } catch (error) {
    return authError(error, "Unable to load profile");
  }
}
