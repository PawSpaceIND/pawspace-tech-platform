export type PartnerJobWorkspaceInput={bookingId:string;serviceCode:string};

export type PartnerWorkspaceScope="legacy"|"v2";

export function partnerJobWorkspaceHref(job:PartnerJobWorkspaceInput,scope:PartnerWorkspaceScope="legacy"){
 const bookingId=String(job.bookingId||"").trim();
 if(!bookingId)return null;
 const encoded=encodeURIComponent(bookingId),service=String(job.serviceCode||"").trim();
 if(scope==="v2"){
  if(service==="grooming"||service==="dog_training")return `/v2/partner?bookingId=${encoded}`;
  if(service==="boarding")return `/v2/partner/boarding?bookingId=${encoded}`;
  if(service==="dog_walking"||service==="pet_walking")return `/v2/partner/walking?bookingId=${encoded}`;
  if(service==="pet_taxi")return `/v2/partner/taxi?bookingId=${encoded}`;
  if(service==="pet_sitting")return `/v2/partner/sitting?bookingId=${encoded}`;
 }
 if(service==="grooming")return "/partner-app?bookingId="+encoded;
 if(service==="dog_training")return "/trainer?bookingId="+encoded;
 if(service==="boarding")return "/host?bookingId="+encoded;
 if(service==="dog_walking"||service==="pet_walking")return `/walker?bookingId=${encoded}`;
 if(service==="pet_taxi")return `/driver?bookingId=${encoded}`;
 if(service==="pet_sitting")return `/sitter?bookingId=${encoded}`;
 return null;
}
