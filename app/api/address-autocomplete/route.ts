import{refuseUnlessGatewayPermits}from"../../../lib/api-gateway";
import{resolvePlaceToAddress,reverseGeocode,searchAddressSuggestions}from"../../../lib/address-autocomplete";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;
  try{
    const url=new URL(request.url),mode=url.searchParams.get("mode")||"search";
    if(mode==="search"){
      const query=url.searchParams.get("query")||"",sessionToken=url.searchParams.get("sessionToken")||undefined;
      const data=await searchAddressSuggestions({query,sessionToken});
      return json({data});
    }
    if(mode==="resolve"){
      const placeId=url.searchParams.get("placeId")||"",sessionToken=url.searchParams.get("sessionToken")||undefined;
      if(!placeId)return json({error:"placeId is required"},400);
      const data=await resolvePlaceToAddress({placeId,sessionToken});
      return json({data});
    }
    if(mode==="reverse"){
      const latitude=Number(url.searchParams.get("latitude")),longitude=Number(url.searchParams.get("longitude"));
      if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return json({error:"Valid latitude and longitude are required"},400);
      const data=await reverseGeocode({latitude,longitude});
      return json({data});
    }
    return json({error:"Unsupported address lookup mode"},400);
  }catch(error){return json({error:error instanceof Error?error.message:"Unable to process address lookup"},500);}
}
