import{ensureAiBusinessConfiguration}from"./ai-business-configuration";
import{ensureCatalogueTables}from"./catalogue-governance";
import{groomingCatalogue,seedDefaultGroomingSubscriptionPlans}from"./grooming-governance";

type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??"")) as T}catch{return fallback}};

export type AiKnowledgePackage={code:string;name:string;offerType:string;price:number;multiPetPrice:number|null;currency:string;eligiblePetTypes:string[];description:string|null;version:string;source:"catalogue_db"|"grooming_catalogue"};
export type AiKnowledgeSubscription={code:string;name:string;price:number;currency:string;sessions:number;validityValue:number;validityUnit:string;eligiblePetTypes:string[];servicePackageCode:string;version:string};
export type AiKnowledgeEntry={id:string;sourceKey:string;title:string;sourceType:string;content:string;immutableHash:string;version:number};
export type AiKnowledgeSnapshot={market:{cityId:string;zoneId:string|null};serviceCode:"grooming";currency:"INR";packages:AiKnowledgePackage[];subscriptions:AiKnowledgeSubscription[];faqs:AiKnowledgeEntry[];groundingRefs:string[];pricingNote:string;generatedAt:number};

function queryTerms(query:string){return[...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(item=>item.length>=3))];}
function relevant(row:AiKnowledgeEntry,terms:string[]){if(!terms.length)return true;const hay=`${row.title} ${row.sourceType} ${row.content}`.toLowerCase();return terms.some(term=>hay.includes(term));}
function visible(value:unknown,scopes:string[]){const rowScopes=parse<string[]>(value,[]).map(item=>String(item).toLowerCase());return scopes.some(scope=>rowScopes.includes(scope.toLowerCase()));}

/**
 * Governed, read-only context for conversational channels. Commercial data is taken from active,
 * effective Bengaluru catalogue/subscription rows when present; the long-standing server-owned
 * grooming catalogue is the cold-database fallback. FAQ/policy text is restricted to active/current
 * AI knowledge versions and allowed visibility scopes. No draft/review/retired knowledge is exposed.
 */
export async function loadAiKnowledgeCenter(db:D1Database,input:{cityId?:string;zoneId?:string|null;query?:string;visibilityScopes?:string[];faqLimit?:number;asOf?:number}={}):Promise<AiKnowledgeSnapshot>{
  await Promise.all([ensureAiBusinessConfiguration(db),ensureCatalogueTables(db),seedDefaultGroomingSubscriptionPlans(db)]);
  const now=input.asOf??Date.now(),today=new Date(now).toISOString().slice(0,10),cityId=text(input.cityId)||"blr",zoneId=text(input.zoneId)||null,scopes=input.visibilityScopes?.length?input.visibilityScopes:["public"];

  const packageRows=await db.prepare("SELECT * FROM catalogue_packages WHERE service_code='grooming' AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) AND (city_id=? OR city_id='ALL') ORDER BY package_code,version DESC").bind(today,today,cityId).all<Row>().catch(()=>({results:[]}));
  const best=new Map<string,{row:Row;score:number}>();
  for(const row of packageRows.results){
    const rowZone=text(row.zone_id),rowCity=text(row.city_id);let score=0;
    if(rowZone)score=zoneId&&rowZone===zoneId?3:0;else if(rowCity===cityId)score=2;else if(rowCity==="ALL")score=1;
    if(!score)continue;const code=text(row.package_code),prior=best.get(code);if(!prior||score>prior.score||(score===prior.score&&Number(row.version)>Number(prior.row.version)))best.set(code,{row,score});
  }
  const packages:AiKnowledgePackage[]=best.size?[...best.values()].map(({row})=>({code:text(row.package_code),name:text(row.name),offerType:"regular",price:Number(row.base_price),multiPetPrice:null,currency:text(row.currency)||"INR",eligiblePetTypes:[],description:text(row.description)||null,version:`catalogue:${text(row.id)}:v${Number(row.version)}`,source:"catalogue_db" as const})):
    groomingCatalogue.filter(item=>item.active&&item.offerType!=="subscription").map(item=>({code:item.code,name:item.name,offerType:item.offerType,price:item.singlePrice,multiPetPrice:item.multiPetPrice??null,currency:"INR",eligiblePetTypes:item.eligiblePetTypes,description:null,version:item.version,source:"grooming_catalogue" as const}));

  const subscriptionRows=await db.prepare("SELECT * FROM grooming_subscription_plans WHERE service_code='grooming' AND city_id=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) AND (zone_id IS NULL OR zone_id=?) ORDER BY plan_code,CASE WHEN zone_id=? THEN 0 ELSE 1 END,version DESC").bind(cityId,today,today,zoneId||"",zoneId||"").all<Row>();
  const seenPlans=new Set<string>();
  const subscriptions:AiKnowledgeSubscription[]=[];
  for(const row of subscriptionRows.results){const code=text(row.plan_code);if(seenPlans.has(code))continue;seenPlans.add(code);subscriptions.push({code,name:text(row.name),price:Number(row.price),currency:text(row.currency)||"INR",sessions:Number(row.session_count),validityValue:Number(row.validity_value),validityUnit:text(row.validity_unit)||"months",eligiblePetTypes:parse<string[]>(row.eligible_pet_types_json,[]),servicePackageCode:text(row.service_package_code),version:`${cityId}:${code}:v${Number(row.version)}`});}

  const knowledgeRows=await db.prepare("SELECT id,source_key,version,title,source_type,content_text,visibility_scope_json,immutable_hash FROM ai_knowledge_source_versions WHERE status='active' AND (effective_from IS NULL OR effective_from<=?) AND (effective_to IS NULL OR effective_to>=?) ORDER BY version DESC,updated_at DESC LIMIT 100").bind(now,now).all<Row>();
  const terms=queryTerms(text(input.query)),limit=Math.max(1,Math.min(Number(input.faqLimit)||12,30));
  const faqs:AiKnowledgeEntry[]=knowledgeRows.results.filter(row=>visible(row.visibility_scope_json,scopes)).map(row=>({id:text(row.id),sourceKey:text(row.source_key),title:text(row.title),sourceType:text(row.source_type),content:text(row.content_text).slice(0,4000),immutableHash:text(row.immutable_hash),version:Number(row.version)})).filter(row=>relevant(row,terms)).slice(0,limit);

  return{market:{cityId,zoneId},serviceCode:"grooming",currency:"INR",packages,subscriptions,faqs,groundingRefs:faqs.flatMap(row=>[row.id,row.immutableHash]).filter(Boolean),pricingNote:"Package prices are governed reference prices. Final scheduled quotes must still use PawSpace's live pricing/booking governance before commitment.",generatedAt:now};
}
