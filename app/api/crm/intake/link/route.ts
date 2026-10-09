import {authorize,authError,database} from '../../../../../lib/server-auth';
import {CRM_MANAGER_DOMAIN,requireManagerDomain,resolveManagerOrganizationalScope} from '../../../../../lib/organizational-scope';
import {validateBookingOrigin} from '../../../../../lib/lead-conversion-attribution';
import {readBoundedRequestText,VoiceFetchRefused} from '../../../../../lib/voice-safe-fetch';
import {BridgeRefusal,recordCanonicalLink,verifiedBookingHandoff} from '../../../../../lib/crm-intake-bridge.mjs';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&v===v.trim()&&!/[\u0000-\u001f\u007f]/.test(v);
export async function POST(request:Request){
 try{
  const {env}=await import('cloudflare:workers');const runtime=env as unknown as Record<string,unknown>;
  if(runtime.CRM_PLATFORM_INTAKE_ENABLED!=='true'||runtime.CRM_PLATFORM_CANONICAL_LINK_ENABLED!=='true')return json({error:'canonical_link_disabled'},503);
  if(request.method!=='POST')return json({error:'method_not_allowed'},405);
  // Existing actor/RBAC/MFA; an operator token or client-provided reviewed flag grants nothing.
  const actor=await authorize(request,'customers.manage');
  if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return json({error:'cross_origin_write_denied'},403);
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return json({error:'json_required'},415);
  let raw:string;try{raw=await readBoundedRequestText(request,65_536);}catch(error){if(error instanceof VoiceFetchRefused)return json({error:'body_too_large'},413);throw error;}
  let body:Record<string,unknown>;try{const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return json({error:'invalid_link_fields'},400);body=parsed as Record<string,unknown>;}catch{return json({error:'invalid_json'},400);}
  const fields=['inquiryKey','customerId','leadId'];
  if(Object.keys(body).length!==3||Object.keys(body).some(k=>!fields.includes(k))||!fields.every(k=>validId(body[k]))||!/^[a-f0-9]{64}$/.test(String(body.inquiryKey)))return json({error:'invalid_link_fields'},400);
  const accountId=String(runtime.CRM_PLATFORM_INTAKE_EXOTEL_ACCOUNT??'').trim(),cityId=String(runtime.CRM_PLATFORM_INTAKE_CITY_ID??'').trim();
  if(!accountId||!cityId)return json({error:'source_scope_not_configured'},503);
  const db=await database(),scope=await resolveManagerOrganizationalScope(db,actor);requireManagerDomain(scope,CRM_MANAGER_DOMAIN);
  if(scope&&scope.cityId!==cityId)return json({error:'canonical_link_scope_denied'},403);
  const {inquiryKey,customerId,leadId}=body as {inquiryKey:string;customerId:string;leadId:string};
  const staged=await db.prepare('SELECT source,account_id,service_code,canonical_lead_id,canonical_customer_id FROM crm_intake_bridge_inquiries WHERE inquiry_key=?').bind(inquiryKey).first<Record<string,unknown>>();
  if(!staged)return json({error:'unknown_external_inquiry'},404);
  if(staged.source!=='exotel'||staged.account_id!==accountId)return json({error:'canonical_link_scope_denied'},403);
  const receipt=await db.prepare("SELECT event_key FROM crm_intake_bridge_events WHERE inquiry_key=? AND source='exotel' AND account_id=? LIMIT 1").bind(inquiryKey,accountId).first<Record<string,unknown>>();
  if(!receipt)return json({error:'immutable_enquiry_receipt_required'},409);
  // Before bridge state changes; explicit real canonical origin, no fabricated thread.
  await validateBookingOrigin(db,{customerId,leadId,serviceCode:String(staged.service_code)});
  const replay=staged.canonical_lead_id===leadId&&staged.canonical_customer_id===customerId;
  const linked=await recordCanonicalLink({db,inquiryKey,customerId,leadId,reviewed:true,scope:{accountId,cityId}});
  const handoff=await verifiedBookingHandoff({db,inquiryKey,scope:{accountId,cityId}});
  return json({ok:true,replay,link:linked,handoff,schedulingInvoked:false,bookingCreated:false,externalEffects:false});
 }catch(error){if(error instanceof BridgeRefusal)return json({error:error.code},error.status);return authError(error,'Canonical link requires review');}
}
