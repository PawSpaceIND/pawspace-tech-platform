import TaxiCustomerManagement from"./taxi-customer-management";
import TaxiCustomerIncidents from"./taxi-customer-incidents";
export default async function TaxiManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams,bookingId=String(params.bookingId||"");return <><TaxiCustomerManagement bookingId={bookingId}/><div style={{maxWidth:980,margin:"0 auto",padding:"0 28px 28px"}}><TaxiCustomerIncidents bookingId={bookingId}/></div></>}
