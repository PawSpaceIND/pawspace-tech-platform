import{authError}from"../../../lib/server-auth";
import{pawspaceServices}from"../../../lib/service-control";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export const INQUIRY_SERVICE_CATEGORIES=[
 ...pawspaceServices.map(service=>({code:service.code,name:service.name,group:service.group})),
 {code:"veterinary",name:"Doorstep Veterinary",group:"Health"},
]as const;

type InquiryCategory=(typeof INQUIRY_SERVICE_CATEGORIES)[number];

const aliases:Record<string,string>={
 training:"dog_training",dog_training:"dog_training",
 sitting:"pet_sitting",pet_sitting:"pet_sitting",
 taxi:"pet_taxi",pet_taxi:"pet_taxi",
 walking:"dog_walking",dog_walking:"dog_walking",
 funeral:"funeral_memorial",memorial:"funeral_memorial",funeral_memorial:"funeral_memorial",
 vet:"veterinary",veterinary:"veterinary",doorstep_vet:"veterinary",
};

function serviceCategory(value:unknown):InquiryCategory|undefined{
 const raw=String(value??"").trim().toLowerCase().replace(/[\s-]+/g,"_");
 const code=aliases[raw]||raw;
 return INQUIRY_SERVICE_CATEGORIES.find(category=>category.code===code);
}

export async function GET(){
 try{return json({ok:true,data:{serviceCategories:INQUIRY_SERVICE_CATEGORIES}});}
 catch(error){return authError(error,"Unable to load inquiry services");}
}

export async function POST(request:Request){
 try{
  let body:Record<string,unknown>;
  try{body=await request.json()as Record<string,unknown>;}catch{return json({ok:false,error:"Request body must be valid JSON",code:"INQUIRY_JSON_INVALID"},400);}
  const category=serviceCategory(body.service||body.serviceCode||body.category);
  if(!category)return json({ok:false,error:"Please select a supported PawSpace service",code:"INQUIRY_SERVICE_INVALID",serviceCategories:INQUIRY_SERVICE_CATEGORIES},400);

  // Keep one CRM write path: /api/public-contact owns rate limiting, validation, lead assignment,
  // CRM activity/task creation and WhatsApp-AI handoff. This route only constrains the public service
  // vocabulary, then delegates to that hardened create-only boundary instead of duplicating its writes.
  const{POST:capturePublicContact}=await import("../public-contact/route");
  const forwarded=new Request(request.url,{method:"POST",headers:request.headers,body:JSON.stringify({...body,service:category.name})});
  const response=await capturePublicContact(forwarded);
  if(!response.ok)return response;
  const payload=await response.json()as Record<string,unknown>;
  return json({...payload,service:{code:category.code,name:category.name}},response.status);
 }catch(error){return authError(error,"Unable to submit your enquiry - please try again");}
}
