export type PartnerJobWorkspaceInput={bookingId:string;serviceCode:string};

export function partnerJobWorkspaceHref(job:PartnerJobWorkspaceInput){
 const bookingId=String(job.bookingId||"").trim();
 if(!bookingId)return null;
 const encoded=encodeURIComponent(bookingId),service=String(job.serviceCode||"").trim();
 if(service==="grooming")return "/partner-app?bookingId="+encoded;
 if(service==="dog_training")return "/trainer?bookingId="+encoded;
 if(service==="boarding")return "/host?bookingId="+encoded;
 if(service==="dog_walking"||service==="pet_walking")return `/walker?bookingId=${encoded}`;
 if(service==="pet_taxi")return `/driver?bookingId=${encoded}`;
 if(service==="pet_sitting")return `/sitter?bookingId=${encoded}`;
 return null;
}
