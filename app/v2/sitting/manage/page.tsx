import ManagePage from "../../../sitting/manage/page";
export default function V2ManagePage(props:{searchParams:Promise<{bookingId?:string}>}){return <ManagePage {...props} routeScope="v2"/>;}
