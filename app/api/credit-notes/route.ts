import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{getCreditNote,listCreditNotes,renderCreditNoteHtml}from"../../../lib/credit-notes";

/*
 * Credit notes for refunds after completion (lib/credit-notes.ts), for Finance (finance.view).
 *   GET                      the latest credit notes (?bookingId= narrows to one booking)
 *   GET ?id=                 one credit note
 *   GET ?id=&format=html     the printable A4 note (browser "Save as PDF")
 */
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){
 try{
  const actor=await resolveActor(request);requirePermission(actor,"finance.view");
  const url=new URL(request.url),id=String(url.searchParams.get("id")||"").trim(),db=await database();
  if(!id)return json({data:{creditNotes:await listCreditNotes(db,{limit:Number(url.searchParams.get("limit")||100),bookingId:String(url.searchParams.get("bookingId")||"")})}});
  const note=await getCreditNote(db,id);
  if(!note)return json({error:"Credit note not found"},404);
  if(url.searchParams.get("format")==="html")return new Response(renderCreditNoteHtml(note),{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'"}});
  const{snapshot_json:omitRaw,...rest}=note;void omitRaw;
  return json({data:rest});
 }catch(error){return authError(error,"Unable to load credit notes");}
}
