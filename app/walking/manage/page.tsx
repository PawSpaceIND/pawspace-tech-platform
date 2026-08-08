import WalkingCustomerBooking from"./walking-customer-booking";
export default async function WalkingManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <WalkingCustomerBooking bookingId={String(params.bookingId||"")}/>;}
