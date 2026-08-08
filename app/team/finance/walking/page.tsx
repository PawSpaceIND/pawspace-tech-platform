import WalkingFinanceWorkspace from"./walking-finance-workspace";
export default async function WalkingFinancePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <WalkingFinanceWorkspace initialBookingId={String(params.bookingId||"")}/>}
