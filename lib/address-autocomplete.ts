export type AddressSuggestion={placeId:string;mainText:string;secondaryText:string;fullText:string};
export type AutocompleteResult={status:"configured"|"configuration_required"|"provider_error";suggestions:AddressSuggestion[];error?:string};
export type ResolvedAddress={status:"configured"|"configuration_required"|"provider_error";address?:string;pincode?:string;latitude?:number;longitude?:number;error?:string};

type AddressComponent={types?:string[];longText?:string;long_name?:string};
/** Postal codes are structured Google data, not guaranteed to appear in display labels. */
export function postalCodeFromComponents(components:AddressComponent[]|undefined):string|undefined{
  const value=components?.find(component=>component.types?.includes("postal_code"));
  const code=value?.longText||value?.long_name;
  return code&&/^[1-9]\d{5}$/.test(code)?code:undefined;
}

/** A Google lookup that accepts the connection and never answers must not hold a booking step open. */
const MAPS_LOOKUP_TIMEOUT_MS=8_000;

async function mapsCredentials(){
  const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;
  const mode=String(runtime.PAWSPACE_MAPS_ENV||"sandbox").toLowerCase();
  if(mode!=="sandbox")return{ok:false as const,error:"Maps UAT adapter is locked to sandbox"};
  const key=String(runtime.GOOGLE_MAPS_SERVER_API_KEY_UAT||"").trim();
  const testFixture=String(runtime.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE||"").trim().toLowerCase()==="on";
  if(!key&&testFixture)return{ok:true as const,key:"__pawspace_explicit_uat_fixture__",fixture:true as const};
  if(!key)return{ok:false as const,error:"GOOGLE_MAPS_SERVER_API_KEY_UAT is not configured"};
  return{ok:true as const,key,fixture:false as const};
}

function validCoordinates(latitude:number,longitude:number){
  return Number.isFinite(latitude)&&Number.isFinite(longitude)&&latitude>=-90&&latitude<=90&&longitude>=-180&&longitude<=180;
}

export function parseReverseGeocodeCoordinates(searchParams:URLSearchParams){
  const latitudeParam=searchParams.get("latitude"),longitudeParam=searchParams.get("longitude");
  if(!latitudeParam?.trim()||!longitudeParam?.trim())return null;
  const latitude=Number(latitudeParam),longitude=Number(longitudeParam);
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return null;
  return{latitude,longitude};
}

export async function searchAddressSuggestions(input:{query:string;sessionToken?:string}):Promise<AutocompleteResult>{
  const query=input.query.trim();
  if(query.length<3)return{status:"configured",suggestions:[]};
  const creds=await mapsCredentials();
  if(!creds.ok)return{status:"configuration_required",suggestions:[],error:creds.error};
  if(creds.fixture)return{status:"configured",suggestions:[{placeId:"pawspace-e2e-indiranagar",mainText:"42, Indiranagar Double Road",secondaryText:"Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038",fullText:"42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038"}]};
  try{
    const response=await fetch("https://places.googleapis.com/v1/places:autocomplete",{
      method:"POST",signal:AbortSignal.timeout(MAPS_LOOKUP_TIMEOUT_MS),
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
  if(creds.fixture)return{status:"configured",address:"42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038",latitude:12.9783692,longitude:77.6408356};
  try{
    const url=new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(input.placeId)}`);
    if(input.sessionToken)url.searchParams.set("sessionToken",input.sessionToken);
    const response=await fetch(url.toString(),{signal:AbortSignal.timeout(MAPS_LOOKUP_TIMEOUT_MS),headers:{"X-Goog-Api-Key":creds.key,"X-Goog-FieldMask":"formattedAddress,location,addressComponents"}});
    const body=await response.json() as{formattedAddress?:string;addressComponents?:AddressComponent[];location?:{latitude?:number;longitude?:number};error?:{message?:string}};
    if(!response.ok)return{status:"provider_error",error:body.error?.message||`Places API returned ${response.status}`};
    const latitude=body.location?.latitude,longitude=body.location?.longitude;
    let pincode=postalCodeFromComponents(body.addressComponents);
    // Areas and roads can omit postal components. Resolve their Google coordinates, never guess a PIN.
    if(!pincode&&typeof latitude==="number"&&typeof longitude==="number"&&validCoordinates(latitude,longitude)){
      const reverse=await reverseGeocode({latitude,longitude});
      if(reverse.status==="configured")pincode=reverse.pincode;
    }
    return{status:"configured",address:body.formattedAddress,pincode,latitude,longitude};
  }catch(error){return{status:"provider_error",error:error instanceof Error?error.message:"Unable to resolve place details"};}
}

/** Server-side forward geocoding for a customer-owned service address.
 * The booking client may supply address text and a PIN, but it never supplies authoritative coordinates:
 * matching coordinates are obtained with the server-held Maps credential and then persisted by the
 * service-discovery authority before provider ranking begins. */
export async function geocodeAddress(input:{address:string}):Promise<ResolvedAddress>{
  const address=input.address.trim();
  if(address.length<8)return{status:"provider_error",error:"A complete service address is required"};
  const creds=await mapsCredentials();
  if(!creds.ok)return{status:"configuration_required",error:creds.error};
  if(creds.fixture)return{status:"configured",address,latitude:12.9783692,longitude:77.6408356};
  try{
    const url=new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address",address);
    url.searchParams.set("region","in");
    url.searchParams.set("key",creds.key);
    const response=await fetch(url.toString(),{signal:AbortSignal.timeout(MAPS_LOOKUP_TIMEOUT_MS)});
    const body=await response.json() as{results?:Array<{formatted_address?:string;geometry?:{location?:{lat?:number;lng?:number}}}>;status?:string;error_message?:string};
    const result=body.results?.[0],latitude=Number(result?.geometry?.location?.lat),longitude=Number(result?.geometry?.location?.lng);
    if(!response.ok||body.status!=="OK"||!result||!validCoordinates(latitude,longitude))return{status:"provider_error",error:body.error_message||body.status||"No geocoded service address found"};
    return{status:"configured",address:result.formatted_address||address,latitude,longitude};
  }catch(error){return{status:"provider_error",error:error instanceof Error?error.message:"Unable to geocode this service address"};}
}

export async function reverseGeocode(input:{latitude:number;longitude:number}):Promise<ResolvedAddress>{
  if(!validCoordinates(input.latitude,input.longitude))return{status:"provider_error",error:"Invalid coordinates"};
  const creds=await mapsCredentials();
  if(!creds.ok)return{status:"configuration_required",error:creds.error};
  try{
    const url=new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("latlng",`${input.latitude},${input.longitude}`);
    url.searchParams.set("key",creds.key);
    const response=await fetch(url.toString(),{signal:AbortSignal.timeout(MAPS_LOOKUP_TIMEOUT_MS)});
    const body=await response.json() as{results?:Array<{formatted_address?:string;address_components?:AddressComponent[]}>;status?:string;error_message?:string};
    if(!response.ok||body.status!=="OK"||!body.results?.length)return{status:"provider_error",error:body.error_message||body.status||"No address found for this location"};
    return{status:"configured",address:body.results[0].formatted_address,pincode:postalCodeFromComponents(body.results[0].address_components),latitude:input.latitude,longitude:input.longitude};
  }catch(error){return{status:"provider_error",error:error instanceof Error?error.message:"Unable to reverse-geocode this location"};}
}