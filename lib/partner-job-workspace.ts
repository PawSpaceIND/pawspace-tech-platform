export type PartnerJobWorkspaceInput={bookingId:string;serviceCode:string};

export function partnerJobWorkspaceHref(job:PartnerJobWorkspaceInput,options:{v2?:boolean}={}){
 const bookingId=String(job.bookingId||"").trim();
 if(!bookingId)return null;
 const encoded=encodeURIComponent(bookingId),service=String(job.serviceCode||"").trim(),prefix=options.v2?"/v2/partner":"";
 if(service==="grooming")return "/partner-app?bookingId="+encoded;
 if(service==="dog_training")return `${prefix}/trainer?bookingId=${encoded}`;
 if(service==="boarding")return `${prefix}/host?bookingId=${encoded}`;
 if(service==="dog_walking"||service==="pet_walking")return `${prefix}/walker?bookingId=${encoded}`;
 if(service==="pet_taxi")return `${prefix}/driver?bookingId=${encoded}`;
 if(service==="pet_sitting")return `${prefix}/sitter?bookingId=${encoded}`;
 return null;
}
