import FoodCustomerManagement from "./food-customer-management";
import FoodCustomerIncidents from "./food-customer-incidents";
export default async function FoodManagePage({searchParams,routeScope="legacy"}:{searchParams:Promise<{orderId?:string}>;routeScope?:"legacy"|"v2"}){const params=await searchParams,orderId=String(params.orderId||"");return <FoodCustomerManagement orderId={orderId} routeScope={routeScope}><div style={{maxWidth:920,margin:"0 auto",padding:"28px 0 0"}}><FoodCustomerIncidents orderId={orderId}/></div></FoodCustomerManagement>;}
