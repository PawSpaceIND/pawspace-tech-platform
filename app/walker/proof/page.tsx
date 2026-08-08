import WalkingProofWorkspace from"./walking-proof-workspace";
export default async function WalkingProofPage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <WalkingProofWorkspace bookingId={String(params.bookingId||"")}/>;}
