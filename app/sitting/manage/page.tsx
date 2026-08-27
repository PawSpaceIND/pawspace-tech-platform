import SittingCustomerBooking from"./sitting-customer-booking";
import SittingCustomerIncidents from"./sitting-customer-incidents";

export default async function SittingManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams,bookingId=String(params.bookingId||"");return <SittingCustomerBooking bookingId={bookingId}><div style={{maxWidth:980,margin:"0 auto",padding:"32px 0 0"}}><SittingCustomerIncidents bookingId={bookingId}/></div></SittingCustomerBooking>;}
