import TaxiManagePage from "../../../taxi/manage/page";
export default function V2TaxiManagePage(props:{searchParams:Promise<{bookingId?:string}>}){return <TaxiManagePage {...props} routeScope="v2"/>;}
