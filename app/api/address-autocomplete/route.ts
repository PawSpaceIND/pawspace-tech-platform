import{authError}from"../../../lib/server-auth";
import{parseReverseGeocodeCoordinates,resolvePlaceToAddress,reverseGeocode,searchAddressSuggestions}from"../../../lib/address-autocomplete";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){
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
      const coordinates=parseReverseGeocodeCoordinates(url.searchParams);
      if(!coordinates)return json({error:"Valid latitude and longitude are required"},400);
      const data=await reverseGeocode(coordinates);
      return json({data});
    }
    return json({error:"Unsupported address lookup mode"},400);
  }catch(error){return authError(error,"Unable to process address lookup");}
}
