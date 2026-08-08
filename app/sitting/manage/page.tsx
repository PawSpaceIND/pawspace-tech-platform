import SittingCustomerBooking from"./sitting-customer-booking";
import SittingCustomerIncidents from"./sitting-customer-incidents";

export default async function SittingManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams,bookingId=String(params.bookingId||"");return <><SittingCustomerBooking bookingId={bookingId}/><div style={{maxWidth:980,margin:"0 auto",padding:"0 32px 32px"}}><SittingCustomerIncidents bookingId={bookingId}/></div></>;}
