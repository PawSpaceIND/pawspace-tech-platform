import WalkingManagePage from "../../../walking/manage/page";
export default function V2WalkingManagePage(props:{searchParams:Promise<{bookingId?:string}>}){return <WalkingManagePage {...props} routeScope="v2"/>;}
