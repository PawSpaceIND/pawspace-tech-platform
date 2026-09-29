import { authError, database, requirePermission, resolveActor } from "../../../lib/server-auth";
import { buildAccountsBusinessView } from "../../../lib/accounts-business-view";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    requirePermission(actor, "finance.view");
    const db = await database();
    const bookingId = new URL(request.url).searchParams.get("bookingId")?.trim() || "";
    if (bookingId.length > 160) return json({ error: "Booking ID is invalid" }, 400);
    const data = await buildAccountsBusinessView(db, bookingId ? { bookingId } : {});
    return json({ data, source: "booking_invoices_and_payments" });
  } catch (error) {
    return authError(error, "Unable to load accounts business view");
  }
}
