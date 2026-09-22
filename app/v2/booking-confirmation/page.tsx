import BookingConfirmationView from "../../mobile-app/booking-confirmation/booking-confirmation-view";
export const dynamic = "force-dynamic";
type Params = Record<string, string | string[] | undefined>;
const one = (value: unknown) => typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
export default async function V2BookingConfirmationPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  return <BookingConfirmationView routeScope="v2" bookingId={one(params.bookingId)} orderId={one(params.orderId)} paymentId={one(params.paymentId)} signature={one(params.signature)} payment={one(params.payment)} code={one(params.code)} />;
}
