import{authError}from"../../../lib/server-auth";
import{parseReverseGeocodeCoordinates,resolvePlaceToAddress,reverseGeocode,searchAddressSuggestions}from"../../../lib/address-autocomplete";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
// Conservative internal-preview burst protection; not a replacement for deployment-wide quotas.
let windowStart=0,lookupCount=0;
function lookupBudget(){const now=Date.now();if(now-windowStart>=60000){windowStart=now;lookupCount=0;}return ++lookupCount<=60;}
function safeResult(data:{status:string;error?:string}){return data.error?{...data,error:"Address search is temporarily unavailable. Please try again or contact PawSpace support."}:data;}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),mode=url.searchParams.get("mode")||"search";
    if(!lookupBudget())return json({error:"Please wait a moment before searching again."},429);
    if(url.search.length>2048)return json({error:"Please shorten your address search."},400);
    if(mode==="search"){
      const query=url.searchParams.get("query")||"",sessionToken=url.searchParams.get("sessionToken")||undefined;
      const data=await searchAddressSuggestions({query,sessionToken});
      return json({data:safeResult(data)});
    }
    if(mode==="resolve"){
      const placeId=url.searchParams.get("placeId")||"",sessionToken=url.searchParams.get("sessionToken")||undefined;
      if(!placeId)return json({error:"placeId is required"},400);
      const data=await resolvePlaceToAddress({placeId,sessionToken});
      return json({data:safeResult(data)});
    }
    if(mode==="reverse"){
      const coordinates=parseReverseGeocodeCoordinates(url.searchParams);
      if(!coordinates)return json({error:"Valid latitude and longitude are required"},400);
      const data=await reverseGeocode(coordinates);
      return json({data:safeResult(data)});
    }
    return json({error:"Unsupported address lookup mode"},400);
  }catch(error){return authError(error,"Unable to process address lookup");}
}
