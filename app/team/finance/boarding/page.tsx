import BoardingFinanceWorkspace from"./boarding-finance-workspace";
export default async function BoardingFinancePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <BoardingFinanceWorkspace initialBookingId={String(params.bookingId||"")}/>}
