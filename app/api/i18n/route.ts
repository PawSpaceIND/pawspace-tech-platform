import{authError,database,requirePermission,resolveActor}from"../../../lib/server-auth";
import{resolveMessages,resolveLocale,setTranslation,publishTranslation,aiTranslateMissing,setUserLocale,getUserLocale,i18nCoverage,SUPPORTED_LOCALES}from"../../../lib/i18n-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin i18n write blocked",{status:403});}
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// UI translations for the active locale (any authenticated user), + i18n administration (settings.manage).
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);
    if(url.searchParams.get("mode")==="coverage"){requirePermission(actor,"settings.manage");return json({data:await i18nCoverage(db)});}
    const preferred=await getUserLocale(db,actor.principalKey||actor.email);
    const locale=resolveLocale({explicit:url.searchParams.get("locale"),preferred,acceptLanguage:request.headers.get("accept-language")});
    return json({data:{...await resolveMessages(db,{locale}),supportedLocales:SUPPORTED_LOCALES}});
  }catch(error){return authError(error,"Unable to load translations");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);
    const b=await request.json().catch(()=>({})) as Record<string,unknown>;
    const action=String(b.action||"").trim();
    if(action==="set_user_locale"){const data=await setUserLocale(db,{subjectId:actor.principalKey||actor.email,locale:String(b.locale||"")});return json({data},201);}
    // management actions require settings.manage
    requirePermission(actor,"settings.manage");
    if(action==="set_translation"){const data=await setTranslation(db,{messageKey:String(b.messageKey||""),locale:String(b.locale||""),text:String(b.text||""),publish:Boolean(b.publish),aiAssisted:Boolean(b.aiAssisted),actorId:actor.email});return json({data},201);}
    if(action==="publish"){const data=await publishTranslation(db,{messageKey:String(b.messageKey||""),locale:String(b.locale||""),actorId:actor.email});return json({data},201);}
    if(action==="ai_translate"){const env=await runtime();const data=await aiTranslateMissing(db,env,{locale:String(b.locale||""),limit:b.limit as number,actorEmail:actor.email});return json({data},data.connected?201:200);}
    return json({error:"Unsupported action. Use set_user_locale | set_translation | publish | ai_translate"},400);
  }catch(error){return authError(error,"Unable to update translations");}
}
