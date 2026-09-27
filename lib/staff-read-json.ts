/** Bound read-only staff requests, including body streaming, so Refresh can recover. */
export async function staffReadJson<T>(url:string,timeoutMs=15_000):Promise<T>{
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetch(url,{cache:"no-store",signal:controller.signal});
  const payload=await response.json() as T & {error?:string};
  if(!response.ok)throw new Error(payload.error||`Request failed (HTTP ${response.status})`);
  return payload;
 }catch(error){
  if(controller.signal.aborted)throw new Error("This view took too long to load. Refresh to retry; existing records have not been changed.");
  throw error;
 }finally{clearTimeout(timer);}
}
