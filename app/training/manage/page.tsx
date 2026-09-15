import TrainingCustomerManagement from"./training-customer-management";
export default async function TrainingManagePage({searchParams}:{searchParams:Promise<{bookingId?:string}>}){const params=await searchParams;return <TrainingCustomerManagement bookingId={String(params.bookingId||"")}/>;}
