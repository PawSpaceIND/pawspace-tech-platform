import SittingFinanceWorkspace from"./sitting-finance-workspace";

export default async function SittingFinancePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <SittingFinanceWorkspace initialBookingId={String(params.bookingId||"")}/>;}
