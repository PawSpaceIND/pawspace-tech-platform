type Job={bookingId:string;workOrderId:string;status:string};
/** Training has several work orders per booking; selection must identify the session. */
export function selectPartnerWorkOrder(jobs:Job[],currentId:string,requestedBookingId=""){
 if(jobs.some(job=>job.workOrderId===currentId))return currentId;
 const requested=jobs.filter(job=>job.bookingId===requestedBookingId),scope=requested.length?requested:jobs;
 return(scope.find(job=>!["completed","cancelled","locked","no_show"].includes(job.status))??scope[0])?.workOrderId??"";
}
