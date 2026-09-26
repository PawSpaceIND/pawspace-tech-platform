import {authError,database} from '../../../lib/server-auth';
import {resolvePlatformSession} from '../../../lib/platform-session';
import {createMeetGreetRequest,listMeetGreetRequests,type MeetGreetFormat} from '../../../lib/meet-and-greet';
import {stayMeetingPolicy,validateMeetingTime} from '../../../lib/stay-meeting-policy';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
async function context(request:Request){const db=await database(),session=await resolvePlatformSession(db,request);if(session?.subjectType!=='customer')throw new Response('Customer sign-in is required.',{status:401});return{db,customerId:String(session.subjectId)};}
async function eligible(db:D1Database,providerId:string,serviceCode:string){
 if(!['boarding','pet_sitting'].includes(serviceCode))throw new Response('Select Boarding or Sitting.',{status:400});
 const row=await db.prepare("SELECT services_json FROM provider_capacity_profiles WHERE id=? AND status='active' AND live=1").bind(providerId).first<{services_json:string}>();
 if(!row||!JSON.parse(row.services_json).includes(serviceCode))throw new Response('The selected caregiver is not available for this service.',{status:409});
}
export async function GET(request:Request){try{const {db,customerId}=await context(request),q=new URL(request.url).searchParams,providerId=q.get('providerId')||'',policy=stayMeetingPolicy(q.get('start'),q.get('end'));await eligible(db,providerId,q.get('serviceCode')||'');return json({data:{policy,requests:(await listMeetGreetRequests(db,{customerId,hostProviderId:providerId})).slice(0,25),paymentCollected:false}});}catch(error){return fail(error);}}
export async function POST(request:Request){try{
 const origin=request.headers.get('origin');if(origin&&origin!==new URL(request.url).origin)throw new Response('Cross-origin request refused.',{status:403});
 const {db,customerId}=await context(request),b=await request.json() as Record<string,unknown>;
 if(b.customerId&&b.customerId!==customerId)throw new Response('Request your own meeting only.',{status:403});
 if(b.consent!==true)throw new Response('Confirm that you want a separate meeting request.',{status:400});
 const format=b.format as MeetGreetFormat;if(!['phone','house_visit'].includes(format))throw new Response('Select a valid meeting format.',{status:400});
 const providerId=String(b.hostProviderId||''),start=String(b.intendedStayStart||''),end=String(b.intendedStayEnd||''),key=String(b.idempotencyKey||'').trim();
 if(!key||key.length>160)throw new Response('A bounded request identity is required.',{status:400});
 await eligible(db,providerId,String(b.serviceCode||''));const policy=stayMeetingPolicy(start,end);validateMeetingTime(format,Number(b.preferredAt),start);
 const result=await createMeetGreetRequest(db,{customerId,hostProviderId:providerId,format,preferredAt:Number(b.preferredAt),intendedStayStart:start,intendedStayEnd:end,intendedStayDays:policy.intendedStayDays,idempotencyKey:key,notes:'Customer explicitly requested a separate pre-stay introduction. No payment or confirmed slot is represented by this request.'},`customer:${customerId}`);
 return json({data:{request:result,policy,paymentCollected:false,paymentStatus:result.priceCharged===0?'no_fee_due':'separate_payment_not_collected'}},201);
}catch(error){return fail(error);}}
async function fail(error:unknown){if(error instanceof Response)return json({error:await error.text()},error.status);if(error instanceof Error&&/meet|Host|Preferred|House visits|request key/.test(error.message))return json({error:error.message},409);return authError(error,'Unable to process the introduction request.');}
