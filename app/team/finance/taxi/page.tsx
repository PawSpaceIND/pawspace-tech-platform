import TaxiFinanceWorkspace from"./taxi-finance-workspace";
export default async function TaxiFinancePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <TaxiFinanceWorkspace initialBookingId={String(params.bookingId||"")}/>}
