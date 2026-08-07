export async function saveGroomingServiceLocation(input:{bookingId:string;customerId:string;address:string;latitude?:number;longitude?:number}){
  const response=await fetch("/api/grooming-service-location",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  const body=await response.json() as {data?:{bookingId:string;addressSaved:boolean;coordinatesSaved:boolean;navigationUrl:string};error?:string};
  if(!response.ok||!body.data)throw new Error(body.error||"Unable to save doorstep location");
  return body.data;
}
