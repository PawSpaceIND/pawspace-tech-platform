import CanonicalTaxiPage from "../../taxi/canonical-taxi-page";
import V2BoardingTaxiExperience from "./boarding-taxi-experience";
export default async function V2TaxiPage({searchParams}:{searchParams:Promise<{sourceBookingId?:string|string[]}>}){
 const params=await searchParams;
 const sourceBookingId=typeof params.sourceBookingId==="string"?params.sourceBookingId.trim():"";
 return sourceBookingId?<V2BoardingTaxiExperience sourceBookingId={sourceBookingId}/>:<CanonicalTaxiPage routeScope="v2"/>;
}
