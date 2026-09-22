import GroomingCustomerBooking from "./grooming-customer-booking";

export default async function GroomingManagePage({searchParams,routeScope="legacy"}:{searchParams:Promise<{bookingId?:string}>;routeScope?:"legacy"|"v2"}) {
 const params=await searchParams;
 return <GroomingCustomerBooking routeScope={routeScope} bookingId={String(params.bookingId||"")}/>;
}
