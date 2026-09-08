import{authError,database,requireCustomerOwnership,resolveActor}from"../../../lib/server-auth";
import{listOrderNotifications,markOrderNotificationRead}from"../../../lib/order-notification-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){
 try{
  const actor=await resolveActor(request),url=new URL(request.url),customerId=String(url.searchParams.get("customerId")||"").trim();
  const db=await database();await requireCustomerOwnership(db,actor,customerId);
  if(!customerId)return json({error:"Customer ID is required"},400);
  const limit=Number(url.searchParams.get("limit")||50);
  if(!Number.isInteger(limit)||limit<1||limit>200)return json({error:"Limit must be an integer from 1 to 200"},400);
  let before:{at:number;id:string}|undefined;
  const cursor=url.searchParams.get("cursor");
  if(cursor){try{const value=JSON.parse(cursor);if(!Number.isSafeInteger(value?.at)||value.at<0||typeof value.id!=="string"||!value.id||value.id.length>100)throw new Error("Invalid cursor");before={at:value.at,id:value.id};}catch{return json({error:"Invalid notification cursor"},400);}}
  const rows=await listOrderNotifications(db,customerId,limit+1,before),items=rows.slice(0,limit),last=items.at(-1);
  const unread=await db.prepare("SELECT COUNT(*) count FROM order_notifications WHERE customer_id=? AND status='unread'").bind(customerId).first<{count:number}>();
  return json({data:{items:items.map(({id,booking_id,order_id,service_code,event_type,severity,status,title,body,created_at,read_at})=>({id,booking_id,order_id,service_code,event_type,severity,status,title,body,created_at,read_at})),unread:Number(unread?.count||0),nextCursor:rows.length>limit&&last?{at:Number(last.created_at),id:String(last.id)}:null}});
 }catch(error){return authError(error,"Unable to load order notifications")}
}

export async function POST(request:Request){try{const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json({error:"Cross-origin notification write blocked"},403);const actor=await resolveActor(request),body=await request.json() as{customerId?:string;notificationId?:string;action?:string},customerId=String(body.customerId||"").trim(),notificationId=String(body.notificationId||"").trim();const db=await database();await requireCustomerOwnership(db,actor,customerId);if(!customerId||!notificationId||body.action!=="mark_read")return json({error:"Customer, notification and mark_read action are required"},400);return json({data:await markOrderNotificationRead(db,{customerId,notificationId})})}catch(error){return authError(error,"Unable to update order notification")}}
