import V2BoardingTaxiExperience from "../v2/taxi/boarding-taxi-experience";
export default async function TaxiPage({searchParams}:{searchParams:Promise<{sourceBookingId?:string|string[]}>}){
 const params=await searchParams;
 const sourceBookingId=typeof params.sourceBookingId==="string"?params.sourceBookingId.trim():"";
 return <V2BoardingTaxiExperience routeScope="legacy" sourceBookingId={sourceBookingId||undefined}/>;
}
