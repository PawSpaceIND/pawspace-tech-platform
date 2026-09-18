import TaxiCustomerManagement from "./taxi-customer-management";
import TaxiCustomerIncidents from "./taxi-customer-incidents";
export default async function TaxiManagePage({searchParams,routeScope="legacy"}:{searchParams:Promise<{bookingId?:string}>;routeScope?:"legacy"|"v2"}){const params=await searchParams,bookingId=String(params.bookingId||"");return <TaxiCustomerManagement bookingId={bookingId} routeScope={routeScope}><div style={{maxWidth:980,margin:"0 auto",padding:"28px 0 0"}}><TaxiCustomerIncidents bookingId={bookingId}/></div></TaxiCustomerManagement>;}
