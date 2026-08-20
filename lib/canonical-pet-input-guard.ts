type Db={prepare(query:string):{bind(...values:unknown[]):{first<T=Record<string,unknown>>():Promise<T|null>}}};

function isLegacyBlankSourceId(value:unknown){
  return value==null||(typeof value==="string"&&value.trim()==="")||(Array.isArray(value)&&value.length===0);
}

/**
 * Guard the canonical-booking HTTP boundary against non-text pet identity material that can throw
 * during String coercion inside the legacy route normalizer. Existing idempotency/schedule-group rows
 * deliberately bypass this guard so the route's replay/conflict lookup remains authoritative and
 * historical malformed payloads stay replayable without any new writes.
 */
export async function malformedCanonicalPetIdentityResponse(request:Request,db:Db):Promise<Response|null>{
  const url=new URL(request.url);
  if(url.pathname!=="/api/canonical-bookings"||request.method.toUpperCase()!=="POST")return null;
  const body=await request.clone().json().catch(()=>null) as null|{idempotencyKey?:unknown;scheduleGroupId?:unknown;pets?:Array<{sourceId?:unknown}>};
  if(!body||!Array.isArray(body.pets))return null;
  const malformed=body.pets.some(pet=>!isLegacyBlankSourceId(pet?.sourceId)&&typeof pet?.sourceId!=="string");
  if(!malformed)return null;

  const idempotencyKey=typeof body.idempotencyKey==="string"?body.idempotencyKey:"";
  const scheduleGroupId=typeof body.scheduleGroupId==="string"?body.scheduleGroupId:"";
  if(idempotencyKey||scheduleGroupId){
    try{
      const existing=await db.prepare("SELECT id FROM canonical_bookings WHERE idempotency_key=? OR schedule_group_id=? LIMIT 1").bind(idempotencyKey,scheduleGroupId).first<{id:string}>();
      if(existing)return null;
    }catch{
      // A missing/unavailable table cannot contain a historical replay. The route will create its
      // tables later, but malformed NEW identity material is still rejected before that route runs.
    }
  }
  return Response.json({error:"A pet source id must be text"},{status:400});
}
