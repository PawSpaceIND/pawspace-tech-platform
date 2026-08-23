export type AddressSuggestion={placeId:string;mainText:string;secondaryText:string;fullText:string};
export type AutocompleteResult={status:"configured"|"configuration_required"|"provider_error";suggestions:AddressSuggestion[];error?:string};
export type ResolvedAddress={status:"configured"|"configuration_required"|"provider_error";address?:string;latitude?:number;longitude?:number;error?:string};

async function mapsCredentials(){
  const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;
  const mode=String(runtime.PAWSPACE_MAPS_ENV||"sandbox").toLowerCase();
  if(mode!=="sandbox")return{ok:false as const,error:"Maps UAT adapter is locked to sandbox"};
  const key=String(runtime.GOOGLE_MAPS_SERVER_API_KEY_UAT||"").trim();
  if(!key)return{ok:false as const,error:"GOOGLE_MAPS_SERVER_API_KEY_UAT is not configured"};
  return{ok:true as const,key};
}

function validCoordinates(latitude:number,longitude:number){
  return Number.isFinite(latitude)&&Number.isFinite(longitude)&&latitude>=-90&&latitude<=90&&longitude>=-180&&longitude<=180;
}

export async function searchAddressSuggestions(input:{query:string;sessionToken?:string}):Promise<AutocompleteResult>{
  const query=input.query.trim();
  if(query.length<3)return{status:"configured",suggestions:[]};
  const creds=await mapsCredentials();
  if(!creds.ok)return{status:"configuration_required",suggestions:[],error:creds.error};
  try{
    const response=await fetch("https://places.googleapis.com/v1/places:autocomplete",{
      method:"POST",
      headers:{"content-type":"application/json","X-Goog-Api-Key":creds.key},
      body:JSON.stringify({input:query,includedRegionCodes:["in"],languageCode:"en",sessionToken:input.sessionToken}),
    });
    const body=await response.json() as{suggestions?:Array<{placePrediction?:{placeId?:string;text?:{text?:string};structuredFormat?:{mainText?:{text?:string};secondaryText?:{text?:string}}}}>;error?:{message?:string}};
    if(!response.ok)return{status:"provider_error",suggestions:[],error:body.error?.message||`Places API returned ${response.status}`};
    const suggestions=(body.suggestions||[]).map(item=>{const p=item.placePrediction;return{placeId:String(p?.placeId||""),mainText:String(p?.structuredFormat?.mainText?.text||p?.text?.text||""),secondaryText:String(p?.structuredFormat?.secondaryText?.text||""),fullText:String(p?.text?.text||"")};}).filter(item=>item.placeId&&item.fullText);
    return{status:"configured",suggestions};
  }catch(error){return{status:"provider_error",suggestions:[],error:error instanceof Error?error.message:"Unable to call Places Autocomplete API"};}
}

export async function resolvePlaceToAddress(input:{placeId:string;sessionToken?:string}):Promise<ResolvedAddress>{
  const creds=await mapsCredentials();
  if(!creds.ok)return{status:"configuration_required",error:creds.error};
  try{
    const url=new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(input.placeId)}`);
    if(input.sessionToken)url.searchParams.set("sessionToken",input.sessionToken);
    const response=await fetch(url.toString(),{headers:{"X-Goog-Api-Key":creds.key,"X-Goog-FieldMask":"formattedAddress,location"}});
    const body=await response.json() as{formattedAddress?:string;location?:{latitude?:number;longitude?:number};error?:{message?:string}};
    if(!response.ok)return{status:"provider_error",error:body.error?.message||`Places API returned ${response.status}`};
    return{status:"configured",address:body.formattedAddress,latitude:body.location?.latitude,longitude:body.location?.longitude};
  }catch(error){return{status:"provider_error",error:error instanceof Error?error.message:"Unable to resolve place details"};}
}

export async function reverseGeocode(input:{latitude:number;longitude:number}):Promise<ResolvedAddress>{
  if(!validCoordinates(input.latitude,input.longitude))return{status:"provider_error",error:"Invalid coordinates"};
  const creds=await mapsCredentials();
  if(!creds.ok)return{status:"configuration_required",error:creds.error};
  try{
    const url=new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng",`${input.latitude},${input.longitude}`);
    url.searchParams.set("key",creds.key);
    const response=await fetch(url.toString());
    const body=await response.json() as{results?:Array<{formatted_address?:string}>;status?:string;error_message?:string};
    if(!response.ok||body.status!=="OK"||!body.results?.length)return{status:"provider_error",error:body.error_message||body.status||"No address found for this location"};
    return{status:"configured",address:body.results[0].formatted_address,latitude:input.latitude,longitude:input.longitude};
  }catch(error){return{status:"provider_error",error:error instanceof Error?error.message:"Unable to reverse-geocode this location"};}
}
