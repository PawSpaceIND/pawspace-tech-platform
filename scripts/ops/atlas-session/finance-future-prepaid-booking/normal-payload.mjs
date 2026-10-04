export const GROUP='FINANCE-TEST-OPS-GROOMING-01-PREPAID-20261005-01';
export const KEY=GROUP+'-CANONICAL-PREPAID';
export function canonicalPayload(request,customer,pet,provider,quote){return{
 idempotencyKey:KEY,scheduleGroupId:GROUP,
 customer:{id:customer.id,name:customer.name,primaryPhone:customer.primary_phone,secondaryPhone:customer.secondary_phone||undefined,email:customer.email||undefined},
 pets:[{sourceId:String(pet.source_pet_id||pet.id),name:pet.name,species:pet.species==='cat'?'cat':pet.species==='dog'?'dog':'other',breed:pet.breed||undefined,vaccinationStatus:pet.vaccination_status}],
 cityId:request.cityId,zoneId:request.zoneId,serviceCode:'grooming',packageCode:quote.packageCode,packageName:quote.packageName,
 scheduledStart:request.scheduledStart,scheduledEnd:request.scheduledEnd,
 provider:{id:provider.id,name:provider.name,model:provider.model},totalAmount:quote.finalPrice,amountDueNow:quote.finalPrice,
 payment:{method:'card',mode:'prepaid',status:'created',detail:'Prepaid; awaiting genuine Razorpay TEST checkout; no collection claimed'},pricing:{discount:0}
}}
