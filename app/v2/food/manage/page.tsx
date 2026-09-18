import FoodManagePage from "../../../food/manage/page";
export default function V2FoodManagePage(props:{searchParams:Promise<{orderId?:string}>}){return <FoodManagePage {...props} routeScope="v2"/>;}
