import TaxiCustomerManagement from"./taxi-customer-management";
export default async function TaxiManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <TaxiCustomerManagement bookingId={String(params.bookingId||"")}/>}
