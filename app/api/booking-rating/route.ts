import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{listCustomerRatableBookings,submitBookingRating}from"../../../lib/booking-rating";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin booking rating write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    const ratable=await listCustomerRatableBookings(db,customerId);
    return json({data:{ratableBookings:ratable}});
  }catch(error){return authError(error,"Unable to load ratable bookings");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {customerId?:string;bookingId?:string;stars?:number;comment?:string};
    if(!body.bookingId||!body.stars)return json({error:"Booking ID and a star rating are required"},400);
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    const result=await submitBookingRating(db,{customerId,bookingId:body.bookingId,stars:body.stars,comment:body.comment,actorId:customerId});
    await securityAudit(db,actor,"booking.rating.submit","customer",customerId,"completed",{bookingId:body.bookingId,stars:body.stars,providerId:result.providerId});
    return json({data:result},201);
  }catch(error){return authError(error,"Unable to submit rating");}
}
