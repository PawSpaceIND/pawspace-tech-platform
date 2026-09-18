import WalkingCustomerManagement from "./walking-customer-management";
export default async function WalkingManagePage({searchParams,routeScope="legacy"}:{searchParams:Promise<{bookingId?:string}>;routeScope?:"legacy"|"v2"}){const params=await searchParams;return <WalkingCustomerManagement bookingId={String(params.bookingId||"")} routeScope={routeScope}/>;}
