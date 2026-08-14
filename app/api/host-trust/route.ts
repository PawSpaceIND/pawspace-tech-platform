import{submitHostReview,listHostReviews,ensureHostReviewsTables,seedHostReviews}from"../../../lib/host-reviews";
import{computeHostStats,computeHostBadges}from"../../../lib/host-badges";
import{resolveActor,requirePermission}from"../../../lib/server-auth";

type Db=D1Database;

async function ensureDb():Promise<Db>{
  const{env}=await import("cloudflare:workers");
  return(env as{DB:Db}).DB;
}

export async function GET(request:Request):Promise<Response>{
  const url=new URL(request.url);
  const hostProviderId=url.searchParams.get("hostProviderId");
  const limit=parseInt(url.searchParams.get("limit")||"10",10);
  const offset=parseInt(url.searchParams.get("offset")||"0",10);

  try{
    if(!hostProviderId)return new Response(JSON.stringify({error:"hostProviderId required"}),{status:400,headers:{"content-type":"application/json"}});

    const db=await ensureDb();
    await ensureHostReviewsTables(db);

    const stats=await computeHostStats(db,hostProviderId);
    const badges=computeHostBadges(stats);
    const{reviews,stats:aggregateStats}=await listHostReviews(db,hostProviderId,{limit,offset});

    return new Response(JSON.stringify({
      data:{
        hostProviderId,
        stats,
        badges,
        reviews,
        aggregateStats,
        productionReady:false,
      },
    }),{status:200,headers:{"content-type":"application/json"}});
  }catch(e){
    const message=e instanceof Error?e.message:String(e);
    return new Response(JSON.stringify({error:message}),{status:500,headers:{"content-type":"application/json"}});
  }
}

export async function POST(request:Request):Promise<Response>{
  try{
    // D4 remediation: this write was fully public. It now requires a real staff session holding
    // providers.manage (host trust/reputation is provider-management data). resolveActor throws a
    // 401/403 Response when the caller is anonymous or under-privileged; we surface it below.
    const actor=requirePermission(await resolveActor(request),"providers.manage");
    const body=await request.json() as Record<string,unknown>;
    const db=await ensureDb();

    // Handle seed action
    if(body.action==="seed"){
      // Synthetic fixture seeding is fail-closed: even an authorized staff member may only run it on a
      // staging/UAT build with the explicit switch on. In production PAWSPACE_UAT_LOGIN is never set, so
      // seeding host reviews can never run there regardless of who is calling.
      const{env}=await import("cloudflare:workers");
      if(String((env as Record<string,unknown>).PAWSPACE_UAT_LOGIN||"")!=="on"){
        return new Response(JSON.stringify({error:"Host review seeding is only available on UAT/staging"}),{status:403,headers:{"content-type":"application/json"}});
      }
      await seedHostReviews(db);
      return new Response(JSON.stringify({message:"Host reviews seeded",seededBy:actor.email,productionReady:false}),{status:200,headers:{"content-type":"application/json"}});
    }

    // Submit review
    const input={
      hostProviderId:String(body.hostProviderId||"").trim(),
      customerId:String(body.customerId||"").trim(),
      bookingId:String(body.bookingId||"").trim(),
      rating:Number(body.rating||0),
      title:String(body.title||"").trim(),
      body:String(body.body||"").trim(),
    };

    if(!input.hostProviderId||!input.customerId||!input.bookingId){
      return new Response(JSON.stringify({error:"hostProviderId, customerId, and bookingId are required"}),{status:400,headers:{"content-type":"application/json"}});
    }

    const review=await submitHostReview(db,input);
    return new Response(JSON.stringify({data:review,productionReady:false}),{status:201,headers:{"content-type":"application/json"}});
  }catch(e){
    // resolveActor/requirePermission throw a ready-made 401/403 Response — propagate it verbatim so an
    // auth failure is not masked as a 400 validation error.
    if(e instanceof Response)return e;
    const message=e instanceof Error?e.message:String(e);
    return new Response(JSON.stringify({error:message}),{status:400,headers:{"content-type":"application/json"}});
  }
}
