import { GET as sharedGet, POST as sharedPost } from "../../razorpay-checkout-return/route";

/** Reuse the existing bounded receipt parser. Only the local presentation destination changes. */
async function v2Return(request: Request, handler: (request: Request) => Promise<Response>) {
  const response = await handler(request);
  const location = response.headers.get("location");
  if (response.status !== 303 || !location) return response;
  const target = new URL(location), source = new URL(request.url);
  if (target.origin !== source.origin || target.pathname !== "/mobile-app/booking-confirmation") {
    return new Response("Invalid checkout return destination", { status: 400 });
  }
  target.pathname = "/v2/grooming";
  return new Response(null, { status: 303, headers: {
    location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}
export async function GET(request: Request) { return v2Return(request, sharedGet); }
export async function POST(request: Request) { return v2Return(request, sharedPost); }
