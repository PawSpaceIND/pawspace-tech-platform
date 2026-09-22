import SittingCustomerBooking from"./sitting-customer-booking";
import SittingCustomerIncidents from"./sitting-customer-incidents";

export default async function SittingManagePage({searchParams,routeScope="legacy"}:{searchParams:Promise<{bookingId?:string}>;routeScope?:"legacy"|"v2"}){const params=await searchParams,bookingId=String(params.bookingId||"");return <SittingCustomerBooking routeScope={routeScope} bookingId={bookingId}><div style={{maxWidth:980,margin:"0 auto",padding:"32px 0 0"}}><SittingCustomerIncidents bookingId={bookingId}/></div></SittingCustomerBooking>;}
