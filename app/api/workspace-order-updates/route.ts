import {authError,authorize,database,requirePermission,authFailure} from "../../../lib/server-auth";
import {hasPermission} from "../../../lib/platform-security";
import {isManagerScopedActor,resolveManagerOrganizationalScope} from "../../../lib/organizational-scope";
import {GET as partnerFeed} from "../partner-job-feed/route";
import {ensureWorkspaceOrderTables,readStaffWorkspaceOrderUpdates,workspaceOrderUpdate,uniqueWorkspaceUpdates,type WorkspaceOrderCursor} from "../../../lib/workspace-order-updates";
const json=(data:unknown)=>Response.json({data},{headers:{'cache-control':'no-store'}});
async function ownerKey(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join('');}
function readCursor(request:Request):WorkspaceOrderCursor|undefined{
 const url=new URL(request.url);if([...url.searchParams.keys()].some(k=>k!=='cursor'))throw authFailure('Only an update cursor may be supplied',400);
 let cursor:WorkspaceOrderCursor|undefined;const encoded=url.searchParams.get('cursor');if(encoded){try{const c=JSON.parse(encoded);if(!Number.isSafeInteger(c.at)||c.at<0||typeof c.id!=='string'||!c.id||c.id.length>200)throw new Error();cursor=c;}catch{throw authFailure('Invalid update cursor',400);}}
 return cursor;
}
export async function GET(request:Request){try{
 const actor=await authorize(request,'bookings.view');
 if(hasPermission(actor.permissions,'bookings.manage')){
  requirePermission(actor,'bookings.manage');const db=await database(),scope=await resolveManagerOrganizationalScope(db,actor);if(isManagerScopedActor(actor)&&!scope)throw authFailure('Current organizational scope required',403);
  const cursor=readCursor(request);
  const owner=await ownerKey(`staff:${actor.email.toLowerCase()}:${actor.roleCode}:${scope?.cityId??'*'}`);
  return json({owner,audience:'staff',checkedAt:Date.now(),...await readStaffWorkspaceOrderUpdates(db,scope?.cityId??null,owner,cursor)});
 }
 // The existing feed resolves the authenticated provider and enforces ownership; no provider override.
 const response=await partnerFeed(new Request(new URL('/api/partner-job-feed',request.url),{headers:request.headers}));if(!response.ok)return response;
 readCursor(request);
 const feed=(await response.json()).data;
 const jobs=['needsAction','today','upcoming','completed','needsOperations','past'].flatMap(k=>feed[k]??[]);
 const items=uniqueWorkspaceUpdates(jobs.map((j:Record<string,unknown>)=>workspaceOrderUpdate({id:j.bookingId,service_code:j.serviceCode,status:j.status,updated_at:Date.parse(String(j.scheduledStart))}))).filter(i=>!['payment_pending','awaiting_payment','pending_payment'].includes(i.status));
 const owner=await ownerKey(`provider:${feed.providerId}`),db=await database(),reads=new Map<string,number>();
 await ensureWorkspaceOrderTables(db);
 for(let offset=0;offset<items.length;offset+=64){const keys=items.slice(offset,offset+64).map(i=>i.id);const rows=await db.prepare(`SELECT event_id,read_at FROM workspace_order_reads WHERE recipient_key=? AND event_id IN (${keys.map(()=>'?').join(',')})`).bind(owner,...keys).all<{event_id:string;read_at:number}>();for(const row of rows.results)reads.set(row.event_id,Number(row.read_at));}
 return json({owner,audience:'provider',items:items.map(i=>({...i,readAt:reads.get(i.id)??null})),unread:items.filter(i=>!reads.has(i.id)).length,nextCursor:null,checkedAt:Date.now(),sourceStatus:{assignedJobs:'available',food:'not_in_provider_feed'}});
}catch(error){return authError(error,'Unable to load workspace order updates');}}

export async function POST(request:Request){try{
 const actor=await authorize(request,'bookings.view');const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw authFailure('Cross-origin acknowledgement blocked',403);
 const body=await request.json();if(!body||Object.keys(body).some(k=>k!=='eventId')||typeof body.eventId!=='string'||body.eventId.length>400)throw authFailure('An update ID is required',400);
 const eventId=body.eventId,parts=eventId.split(':'),kind=parts.shift(),status=parts.pop(),recordId=parts.join(':');if((kind!=='booking'&&kind!=='food')||!status||!recordId)throw authFailure('Invalid update ID',400);
 const db=await database();let owner:string;
 if(hasPermission(actor.permissions,'bookings.manage')){
  const scope=await resolveManagerOrganizationalScope(db,actor);if(isManagerScopedActor(actor)&&!scope)throw authFailure('Current organizational scope required',403);
  const row=await db.prepare(`SELECT id,status FROM ${kind==='food'?'food_orders':'canonical_bookings'} WHERE id=? ${scope?'AND lower(city_id)=lower(?)':''}`).bind(recordId,...(scope?[scope.cityId]:[])).first<{id:string;status:string}>();if(!row||row.status!==status)throw authFailure('Update is no longer available in your scope',403);
  owner=await ownerKey(`staff:${actor.email.toLowerCase()}:${actor.roleCode}:${scope?.cityId??'*'}`);
 }else{
  const response=await partnerFeed(new Request(new URL('/api/partner-job-feed',request.url),{headers:request.headers}));if(!response.ok)return response;const feed=(await response.json()).data;
  const jobs=['needsAction','today','upcoming','completed','needsOperations','past'].flatMap(k=>feed[k]??[]);
  if(kind!=='booking'||['payment_pending','awaiting_payment','pending_payment'].includes(status)||!jobs.some((j:Record<string,unknown>)=>j.bookingId===recordId&&j.status===status))throw authFailure('Update is no longer assigned to you',403);
  owner=await ownerKey(`provider:${feed.providerId}`);
 }
 await ensureWorkspaceOrderTables(db);
 const readAt=Date.now();await db.prepare('INSERT OR IGNORE INTO workspace_order_reads (recipient_key,event_id,read_at) VALUES (?,?,?)').bind(owner,eventId,readAt).run();
 return json({eventId,read:true});
}catch(error){return authError(error,'Unable to acknowledge workspace order update');}}
