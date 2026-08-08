import SittingCustomerBooking from"./sitting-customer-booking";

export default async function SittingManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <SittingCustomerBooking bookingId={String(params.bookingId||"")}/>;}
