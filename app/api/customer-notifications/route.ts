import { authError, database, requireCustomerOwnership, resolveActor } from "../../../lib/server-auth";
import { resolvePlatformSession } from "../../../lib/platform-session";
import { listCustomerSupportNotifications } from "../../../lib/customer-support-notifications";

export async function GET(request: Request) {
  try {
    const db = await database(), actor = await resolveActor(request), url = new URL(request.url);
    const session = await resolvePlatformSession(db, request);
    const customerId = (url.searchParams.get("customerId") || (session?.subjectType === "customer" ? session.subjectId : "")).trim();
    if (!customerId) return Response.json({ error: "Verified customer identity is required" }, { status: 401 });
    await requireCustomerOwnership(db, actor, customerId);
    let before: { at: number; id: string } | undefined;
    const cursor = url.searchParams.get("cursor");
    if (cursor) {
      try {
        const value = JSON.parse(cursor);
        if (!Number.isSafeInteger(value.at) || value.at < 0 || typeof value.id !== "string" || !value.id || value.id.length > 100) throw new Error("Invalid cursor");
        before = { at: value.at, id: value.id };
      } catch { return Response.json({ error: "Invalid notification cursor" }, { status: 400 }); }
    }
    return Response.json({ data: await listCustomerSupportNotifications(db, customerId, before) }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return authError(error, "Unable to load your notifications"); }
}
