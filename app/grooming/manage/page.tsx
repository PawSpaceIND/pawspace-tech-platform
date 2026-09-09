import GroomingCustomerBooking from "./grooming-customer-booking";

export default async function GroomingManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}) {
 const params=await searchParams;
 return <GroomingCustomerBooking bookingId={String(params.bookingId||"")}/>;
}
