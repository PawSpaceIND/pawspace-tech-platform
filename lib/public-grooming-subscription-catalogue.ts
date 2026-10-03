type Row=Record<string,unknown>;
/** Customer-safe published plan projection; never seeds defaults or reads customer wallets. Location
 * is a visitor selection, not verified ownership or booking/availability authorization. */
export async function publicGroomingSubscriptionCatalogue(db:D1Database,input:{cityId?:unknown;zoneId?:unknown;species?:'dog'|'cat'},asOf=Date.now()){
 const cityId=typeof input.cityId==='string'?input.cityId.trim():'',zoneId=typeof input.zoneId==='string'?input.zoneId.trim():'';
 if(!/^[a-z0-9_-]{1,80}$/i.test(cityId)||(zoneId&&!/^[a-z0-9_-]{1,80}$/i.test(zoneId)))return{status:'location_required' as const,plans:[]};
 try{
 const date=new Date(asOf).toISOString().slice(0,10);
 const rows=(await db.prepare("SELECT plan_code,name,price,currency,session_count,validity_value,validity_unit,eligible_pet_types_json,service_package_code,max_pets_per_booking,credits_per_pet,family_wallet,effective_from,effective_to,version,zone_id FROM grooming_subscription_plans WHERE service_code='grooming' AND city_id=? AND active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) AND (zone_id IS NULL OR zone_id=?) ORDER BY plan_code,CASE WHEN zone_id=? THEN 0 ELSE 1 END,version DESC,id DESC LIMIT 100").bind(cityId,date,date,zoneId,zoneId).all<Row>()).results;
 const seen=new Set<string>(),plans:Row[]=[];
 for(const row of rows){const code=String(row.plan_code);if(seen.has(code))continue;seen.add(code);let petTypes:unknown;try{petTypes=JSON.parse(String(row.eligible_pet_types_json));}catch{continue;}
 if(!Array.isArray(petTypes)||!petTypes.length||!petTypes.every(p=>p==='dog'||p==='cat')||(input.species&&!petTypes.includes(input.species))||!['days','months'].includes(String(row.validity_unit)))continue;
 if(!Number.isFinite(Number(row.price))||Number(row.price)<=0||![row.session_count,row.validity_value,row.max_pets_per_booking,row.credits_per_pet].every(x=>Number.isInteger(Number(x))&&Number(x)>0))continue;
 plans.push({code,name:String(row.name),price:Number(row.price),currency:String(row.currency),sessions:Number(row.session_count),validityValue:Number(row.validity_value),validityUnit:String(row.validity_unit),eligiblePetTypes:petTypes,servicePackageCode:String(row.service_package_code),maxPetsPerBooking:Number(row.max_pets_per_booking),creditsPerPet:Number(row.credits_per_pet),familyWallet:Number(row.family_wallet)===1,effectiveFrom:String(row.effective_from),effectiveTo:row.effective_to?String(row.effective_to):null,version:Number(row.version)});if(plans.length>=25)break;
 }
 return{status:plans.length?'published':'not_published',cityId,zoneId:zoneId||null,species:input.species||null,plans};
 }catch{return{status:'unavailable' as const,cityId,zoneId:zoneId||null,plans:[]};}
}
