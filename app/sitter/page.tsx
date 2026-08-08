import SittingWorkspace from"./sitting-workspace";

export default async function SitterPage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <SittingWorkspace bookingId={String(params.bookingId||"")}/>;}