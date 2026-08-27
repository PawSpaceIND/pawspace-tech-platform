import FoodCustomerManagement from"./food-customer-management";
import FoodCustomerIncidents from"./food-customer-incidents";
export default async function FoodManagePage({searchParams}:{searchParams:Promise<{orderId?:string}>}){const params=await searchParams,orderId=String(params.orderId||"");return <FoodCustomerManagement orderId={orderId}><div style={{maxWidth:920,margin:"0 auto",padding:"28px 0 0"}}><FoodCustomerIncidents orderId={orderId}/></div></FoodCustomerManagement>}
