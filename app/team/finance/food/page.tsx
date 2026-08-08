import FoodFinanceWorkspace from"./food-finance-workspace";
export default async function FoodFinancePage({searchParams}:{searchParams:Promise<{orderId?:string}>}){const params=await searchParams;return <FoodFinanceWorkspace initialOrderId={String(params.orderId||"")}/>}
