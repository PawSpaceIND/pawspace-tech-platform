import FoodCustomerManagement from"./food-customer-management";
export default async function FoodManagePage({searchParams}:{searchParams:Promise<{orderId?:string}>}){const params=await searchParams;return <FoodCustomerManagement orderId={String(params.orderId||"")}/>}
