import { GET as sharedGet, POST as sharedPost } from "../../razorpay-checkout-return/route";

/** Reuse the existing bounded receipt parser. Only the local presentation destination changes. */
async function v2Return(request: Request, handler: (request: Request) => Promise<Response>) {
  const response = await handler(request);
  const location = response.headers.get("location");
  if (response.status !== 303 || !location) return response;
  const target = new URL(location), source = new URL(request.url);
  // The shared adapter selects the V2 presentation when the callback carries scope=v2.
  // Accept both the legacy intermediate target and the already-scoped V2 target so a
  // Razorpay redirect is not rejected with a 400 before it can reach the booking page.
  if (target.origin !== source.origin ||
      !["/mobile-app/booking-confirmation", "/v2/booking-confirmation"].includes(target.pathname)) {
    return new Response("Invalid checkout return destination", { status: 400 });
  }
  target.pathname = "/v2/grooming";
  return new Response(null, { status: 303, headers: {
    location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}
export async function GET(request: Request) { return v2Return(request, sharedGet); }
export async function POST(request: Request) { return v2Return(request, sharedPost); }
