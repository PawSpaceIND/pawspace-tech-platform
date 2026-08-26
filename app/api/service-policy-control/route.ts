import{authError,authorize,requirePermission,securityAudit}from"../../../lib/server-auth";
import{listServicePolicies,servicePolicyAudit,servicePolicyDomain,servicePolicyDomains,writeServicePolicy}from"../../../lib/service-policy-governance";

/*
 * Control Center: business policy by vertical and city.
 *
 * These are rules the business owns and changes as it needs to - the refund ladder, what a city status
 * means, which verification a service demands, who may see a customer's address, when quiet hours may be
 * overridden. Before this route each of them was welded into a code path: invisible to the people who
 * decide them, identical in every city, and changeable only by a deploy.
 *
 * READ is `launch.view`, which every Control Center operator (admin, manager, founder, superuser) holds,
 * because an operator running a city must be able to see the rules they are running under.
 * WRITE is the permission the DOMAIN itself declares - `settings.manage` for all of them today, held only
 * by founder and superuser. Both gates are named here rather than assumed: lib/api-gateway.ts is the
 * first gate and this handler is the second, which is the convention this repository already follows.
 *
 * Every write carries a reason of at least five characters, bumps the version, writes a before/after row
 * to service_policy_audit, and writes a security_audit_events row. Reads never mutate.
 */
type Row=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status});
async function database(){const{env}=await import("cloudflare:workers");return env.DB;}

async function failure(error:unknown,message:string){
  if(error instanceof Response&&error.status>=400&&error.status<500){
    const body=await error.clone().text().catch(()=>"");
    try{return json(JSON.parse(body),error.status);}catch{return json({error:body||message},error.status);}
  }
  return authError(error,message);
}

export async function GET(request:Request){
  try{
    await authorize(request,"launch.view");
    const db=await database();
    const url=new URL(request.url);
    const domain=String(url.searchParams.get("domain")||"").trim();
    if(!domain)return json({data:{domains:servicePolicyDomains()}});
    const spec=servicePolicyDomain(domain);
    if(!spec)return json({error:`Unknown policy domain ${domain}`,code:"unknown_policy_domain"},404);
    const [policies,audit]=await Promise.all([listServicePolicies(db,domain),servicePolicyAudit(db,domain)]);
    return json({data:{domain:spec.domain,label:spec.label,managePermission:spec.managePermission,defaults:spec.defaults,policies,audit}});
  }catch(error){return failure(error,"Unable to load business policy configuration");}
}

export async function POST(request:Request){
  try{
    /*
     * AUTHORIZE BEFORE ANY BODY WORK. tests/route-authorization-class.test.mjs enforces this ordering for
     * every guarded route and caught two earlier drafts of this handler: one that resolved the policy
     * domain before authenticating, and one that answered an authenticated-but-unauthorised caller
     * "unknown policy domain" instead of 403. Neither leaked much, but the class of mistake is exactly
     * what that control exists to stop, so the floor is checked first.
     *
     * `settings.manage` is the FLOOR - the same permission lib/api-gateway.ts maps this path to for a
     * write, named here as the second gate. Each domain's own managePermission is then applied below,
     * so authorization to change a lenient policy is never authorization to change a stricter one.
     */
    const actor=await authorize(request,"settings.manage");
    const db=await database();
    const body=await request.json() as {domain?:string;serviceCode?:string;cityId?:string;config?:Record<string,unknown>;notes?:string;effectiveFrom?:string;effectiveTo?:string|null;active?:boolean;reason?:string};
    const domain=String(body.domain||"").trim();
    const spec=servicePolicyDomain(domain);
    if(!spec)return json({error:`Unknown policy domain ${domain||"(none)"}`,code:"unknown_policy_domain"},400);
    requirePermission(actor,spec.managePermission);
    if(!body.config||typeof body.config!=="object")return json({error:"A policy configuration object is required"},400);
    const reason=String(body.reason||"").trim();
    if(reason.length<5)return json({error:"A clear change reason is required"},400);
    const record=await writeServicePolicy(db,{
      domain,serviceCode:body.serviceCode??null,cityId:body.cityId??null,config:body.config,
      notes:body.notes,effectiveFrom:body.effectiveFrom,effectiveTo:body.effectiveTo??null,active:body.active,
    },actor.email,reason);
    await securityAudit(db,actor,"business_policy.write","service_policy",record.id,"completed",{domain,serviceCode:record.serviceCode,cityId:record.cityId,version:record.version,reason});
    return json({data:record},201);
  }catch(error){return failure(error,"Unable to save business policy configuration");}
}
