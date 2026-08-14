import{ensurePricingControlRuntime}from"../lib/pricing-control-runtime";
import{createTrainingQuote,governTrainingBooking}from"../lib/training-commercial-governance";
import{createLiveBoardingQuote,createLiveSittingQuote}from"../lib/live-commercial-quotes";
import{governBoardingBooking}from"../lib/boarding-governance";
import{governSittingBooking}from"../lib/sitting-governance";
import{governGroomingBookingWithLiveMultiPet}from"../lib/live-grooming-governance";

type Env={DB:D1Database};
const eq=(actual:number,expected:number,label:string)=>{if(Math.round(actual)!==Math.round(expected))throw new Error(`${label}: expected ${expected}, got ${actual}`);};

async function run(db:D1Database){
 await ensurePricingControlRuntime(db);
 const base=Date.now(),scheduledStart=new Date(base+48*3_600_000).toISOString(),scheduledEnd=new Date(base+72*3_600_000).toISOString();
 // Seeded canonical rows are intentionally inactive: deploying the bridge must preserve current money.
 const trainingFallback=await createTrainingQuote(db,{packageCode:"training-8-basic",petCount:1,scheduledStart,paymentMode:"prepaid"});eq(trainingFallback.totalAmount,12000,"Training fallback");
 const boardingFallback=await createLiveBoardingQuote(db,{packageCode:"boarding-24h",petCount:2,scheduledStart,scheduledEnd,paymentMode:"prepaid",cityId:"blr",zoneId:"blr-east"});eq(boardingFallback.totalAmount,1398,"Boarding fallback");
 const sittingFallback=await createLiveSittingQuote(db,{packageCode:"sitting-overnight",petCount:2,scheduledStart,scheduledEnd,paymentMode:"prepaid",cityId:"blr",zoneId:"blr-east"});eq(sittingFallback.totalAmount,1198,"Sitting fallback");
 const groomingFallback=await governGroomingBookingWithLiveMultiPet(db,{packageCode:"dog-basic",packageName:"Bath & Basic",pets:[{species:"dog"},{species:"dog"}],submittedTotal:3298,submittedAmountDueNow:3298,paymentMode:"prepaid",cityId:"blr",zoneId:"blr-east",scheduledStart});eq(groomingFallback.totalAmount,3298,"Grooming fallback");

 await db.batch([
  db.prepare("UPDATE service_packages SET active=1,base_price=13000,version=version+1 WHERE package_code='training-8-basic'"),
  db.prepare("UPDATE service_packages SET active=1,base_price=800,version=version+1 WHERE package_code='boarding-24h'"),
  db.prepare("UPDATE service_packages SET active=1,base_price=900,version=version+1 WHERE package_code='sitting-overnight'"),
  db.prepare("UPDATE service_packages SET active=1,base_price=450,version=version+1 WHERE package_code='sitting-overnight__extra_pet'"),
  db.prepare("UPDATE service_packages SET active=1,base_price=3600,version=version+1 WHERE package_code='dog-basic__2_pets'"),
 ]);

 const training=await createTrainingQuote(db,{packageCode:"training-8-basic",petCount:1,scheduledStart,paymentMode:"prepaid"});eq(training.totalAmount,13000,"Training live");
 await governTrainingBooking(db,{quoteId:training.quoteId,packageCode:training.packageCode,packageName:training.packageName,petCount:1,scheduledStart,submittedTotal:13000,submittedAmountDueNow:13000,paymentMode:"prepaid",paymentStatus:"captured",reservationCount:8});
 const boarding=await createLiveBoardingQuote(db,{packageCode:"boarding-24h",petCount:2,scheduledStart,scheduledEnd,paymentMode:"prepaid",cityId:"blr",zoneId:"blr-east"});eq(boarding.totalAmount,1600,"Boarding live");
 await governBoardingBooking(db,{quoteId:boarding.quoteId,packageCode:boarding.packageCode,packageName:boarding.packageName,petCount:2,scheduledStart,scheduledEnd,submittedTotal:1600,submittedAmountDueNow:1600,paymentMode:"prepaid",paymentStatus:"captured",reservationCount:1,providerId:"host_sana",cityId:"blr",zoneId:"blr-east",species:["dog","cat"],vaccinationStatuses:["verified","verified"]});
 const sitting=await createLiveSittingQuote(db,{packageCode:"sitting-overnight",petCount:2,scheduledStart,scheduledEnd,paymentMode:"prepaid",cityId:"blr",zoneId:"blr-east"});eq(sitting.totalAmount,1350,"Sitting live");
 await governSittingBooking(db,{quoteId:sitting.quoteId,packageCode:sitting.packageCode,packageName:sitting.packageName,petCount:2,scheduledStart,scheduledEnd,submittedTotal:1350,submittedAmountDueNow:1350,paymentMode:"prepaid",paymentStatus:"captured",reservationCount:1});
 let oldGroomingRejected=false;try{await governGroomingBookingWithLiveMultiPet(db,{packageCode:"dog-basic",packageName:"Bath & Basic",pets:[{species:"dog"},{species:"dog"}],submittedTotal:3298,submittedAmountDueNow:3298,paymentMode:"prepaid",cityId:"blr",zoneId:"blr-east",scheduledStart});}catch{oldGroomingRejected=true;}if(!oldGroomingRejected)throw new Error("Grooming old multi-pet total was not rejected");
 const grooming=await governGroomingBookingWithLiveMultiPet(db,{packageCode:"dog-basic",packageName:"Bath & Basic",pets:[{species:"dog"},{species:"dog"}],submittedTotal:3600,submittedAmountDueNow:3600,paymentMode:"prepaid",cityId:"blr",zoneId:"blr-east",scheduledStart});eq(grooming.totalAmount,3600,"Grooming live");
 const active=await db.prepare("SELECT COUNT(*) count FROM service_packages WHERE active=1 AND package_code IN ('training-8-basic','boarding-24h','sitting-overnight','sitting-overnight__extra_pet','dog-basic__2_pets')").first<{count:number}>();
 return{ok:true,assertions:{training:training.totalAmount,boarding:boarding.totalAmount,sitting:sitting.totalAmount,grooming:grooming.totalAmount,activeCanonicalRows:Number(active?.count||0)},oldGroomingRejected};
}

export default{async fetch(request:Request,env:Env){const path=new URL(request.url).pathname;if(path==="/health")return Response.json({ok:true});if(path!=="/run")return new Response("Not found",{status:404});try{return Response.json(await run(env.DB));}catch(error){return Response.json({ok:false,error:error instanceof Error?error.message:String(error)},{status:500});}}};
