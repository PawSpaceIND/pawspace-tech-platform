/** Bound both the fetch and response-body read; never accept an HTTP error as report data. */
export async function readReportJson<T>(url:string):Promise<T>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{
  const response=await fetch(url,{cache:"no-store",signal:controller.signal});
  const body:unknown=await response.json();
  if(!response.ok){const detail=body&&typeof body==="object"&&"error"in body&&typeof body.error==="string"?body.error:null;throw new Error(detail||"Report unavailable. Please try again.");}
  if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("The report response is incomplete. Please try again.");
  return body as T;
 }catch(error){if(controller.signal.aborted)throw new Error("The report request timed out. Please try again.");if(error instanceof SyntaxError)throw new Error("The report response could not be read. Please try again.");throw error;}
 finally{clearTimeout(timer);}
}
