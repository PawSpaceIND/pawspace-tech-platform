import WalkerWorkspace from"./walking-workspace";
export default async function WalkerPage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <WalkerWorkspace bookingId={String(params.bookingId||"")}/>;}
