import { authError, database, requireCustomerOwnership, resolveActor } from "../../../../lib/server-auth";
import { resolvePlatformSession } from "../../../../lib/platform-session";
import { readV2GroomingCheckoutReadiness } from "../../../../lib/v2/grooming-checkout-readiness";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
export async function GET(request: Request) {
  try {
    const bookingId = new URL(request.url).searchParams.get("bookingId") || "";
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(bookingId)) return json({ error: "A valid booking reference is required." }, 400);
    const db = await database(), session = await resolvePlatformSession(db, request);
    if (session?.subjectType !== "customer" || !session.subjectId) return json({ error: "Sign in to the customer account that made this booking." }, 401);
    await requireCustomerOwnership(db, await resolveActor(request), session.subjectId);
    return json({ data: await readV2GroomingCheckoutReadiness(db, session.subjectId, bookingId) });
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to verify your grooming checkout.");
  }
}
