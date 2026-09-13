import BookingConfirmationView from "./booking-confirmation-view";

export const dynamic = "force-dynamic";

type Params = { bookingId?: string; orderId?: string; paymentId?: string; signature?: string; payment?: string; code?: string };
const one = (value: unknown) => (typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "");

/**
 * The booking confirmation route. Razorpay's redirect-mode callback lands here (via
 * /api/razorpay-checkout-return) and so does the in-page modal flow after any reload: the page
 * verifies the receipt with the customer's own session and shows the canonical booking state.
 */
export default async function BookingConfirmationPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  return <BookingConfirmationView bookingId={one(params.bookingId)} orderId={one(params.orderId)} paymentId={one(params.paymentId)}
    signature={one(params.signature)} payment={one(params.payment)} code={one(params.code)} />;
}
