import WalkingCustomerManagement from"./walking-customer-management";
export default async function WalkingManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <WalkingCustomerManagement bookingId={String(params.bookingId||"")}/>}
