import{submitHostReview,listHostReviews,ensureHostReviewsTables}from"../../../lib/host-reviews";
import{computeHostStats,computeHostBadges}from"../../../lib/host-badges";

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
    const body=await request.json() as Record<string,unknown>;
    const db=await ensureDb();
    await ensureHostReviewsTables(db); // schema only (idempotent DDL) — never synthetic data

    // Finding D4: seeding synthetic reviews is a write that must NEVER be reachable through this public,
    // unauthenticated endpoint. The public seed path is removed; review seeding runs through staff
    // tooling/migrations only. (The review-submit path below is unchanged — it already validates
    // booking/customer/provider ownership at the data layer.)
    if(body.action==="seed"){
      return new Response(JSON.stringify({error:"Seeding is not available on this public endpoint. Run review seeding through staff tooling."}),{status:405,headers:{"content-type":"application/json","allow":"POST"}});
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
    const message=e instanceof Error?e.message:String(e);
    return new Response(JSON.stringify({error:message}),{status:400,headers:{"content-type":"application/json"}});
  }
}
