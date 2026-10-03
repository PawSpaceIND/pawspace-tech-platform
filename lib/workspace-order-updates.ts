/** Read-only in-app evidence. A booking status is never payment-capture evidence. */
export type WorkspaceOrderUpdate={id:string;recordId:string;kind:'booking'|'food';serviceCode:string;status:string;title:string;at:number;readAt?:number|null};
export type WorkspaceOrderCursor={at:number;id:string};
export async function ensureWorkspaceOrderTables(db:D1Database){
 await db.prepare(`CREATE TABLE IF NOT EXISTS workspace_order_reads (recipient_key TEXT NOT NULL,event_id TEXT NOT NULL,read_at INTEGER NOT NULL,PRIMARY KEY(recipient_key,event_id))`).run();
}
const pending=new Set(['payment_pending','awaiting_payment','pending_payment']);
export function workspaceOrderUpdate(row:Record<string,unknown>,kind:'booking'|'food'='booking'):WorkspaceOrderUpdate{
 const recordId=String(row.id),status=String(row.status),serviceCode=kind==='food'?'fresh_food':String(row.service_code);
 const title=pending.has(status)?'Order recorded · payment pending':status==='confirmed'?'Booking confirmed':kind==='food'?'Food order recorded · '+status.replaceAll('_',' '):'Booking update · '+status.replaceAll('_',' ');
 return {id:`${kind}:${recordId}:${status}`,recordId,kind,serviceCode,status,title,at:Number(row.updated_at??row.created_at)};
}
export function uniqueWorkspaceUpdates(items:WorkspaceOrderUpdate[]){return [...new Map(items.map(item=>[item.id,item])).values()].sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));}
/** Latest canonical rows, paginated and city-scoped; only the acknowledgement schema is initialized. */
export async function readStaffWorkspaceOrderUpdates(db:D1Database,cityId:string|null,recipientKey:string,before?:WorkspaceOrderCursor){
 await ensureWorkspaceOrderTables(db);
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('canonical_bookings','food_orders')").all<{name:string}>();
 if(!tables.results.some(t=>t.name==='canonical_bookings'))throw new Error('Booking updates unavailable');
 const food=tables.results.some(t=>t.name==='food_orders');
 const source="SELECT 'booking' kind,id,service_code,status,COALESCE(updated_at,created_at) at,city_id FROM canonical_bookings"+(food?" UNION ALL SELECT 'food' kind,id,'fresh_food' service_code,status,COALESCE(updated_at,created_at) at,city_id FROM food_orders":'');
 const clauses=[...(cityId?["lower(city_id)=lower(?)"]:[]),...(before?["(at<? OR (at=? AND kind||':'||id<?))"]:[])];
 const values=[recipientKey,...(cityId?[cityId]:[]),...(before?[before.at,before.at,before.id]:[])];
 const joined=`(${source}) source LEFT JOIN workspace_order_reads seen ON seen.recipient_key=? AND seen.event_id=source.kind||':'||source.id||':'||source.status`;
 const rows=await db.prepare(`SELECT source.*,seen.read_at FROM ${joined} ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY at DESC,kind||':'||id DESC LIMIT 101`).bind(...values).all<Record<string,unknown>>();
 const page=rows.results.slice(0,100),last=page.at(-1);
 return {items:uniqueWorkspaceUpdates(page.map(r=>({...workspaceOrderUpdate({...r,updated_at:r.at},r.kind as 'booking'|'food'),readAt:r.read_at===null?null:Number(r.read_at)}))),nextCursor:rows.results.length>100&&last?{at:Number(last.at),id:String(last.kind)+':'+String(last.id)}:null,unread:Number((await db.prepare(`SELECT COUNT(*) n FROM ${joined} WHERE seen.read_at IS NULL ${cityId?'AND lower(city_id)=lower(?)':''}`).bind(recipientKey,...(cityId?[cityId]:[])).first<{n:number}>())?.n??0),sourceStatus:{bookings:'available',food:food?'available':'unavailable'}};
}
