import{database}from"../../../lib/server-auth";
import{createTrainingQuote,listTrainingPackages,type TrainingPaymentMode}from"../../../lib/training-commercial-governance";
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function failure(error:unknown){if(error instanceof Response)return error;return json({error:error instanceof Error?error.message:"Training commercial request failed"},500);}

export async function GET(){try{const db=await database(),packages=await listTrainingPackages(db);return json({data:{packages,source:"canonical_training_commercial",liveMoney:false}});}catch(error){return failure(error);}}

export async function POST(request:Request){try{const body=await request.json() as {packageCode?:string;petCount?:number;scheduledStart?:string;paymentMode?:TrainingPaymentMode;couponCode?:string};const packageCode=String(body.packageCode||"").trim(),scheduledStart=String(body.scheduledStart||"").trim(),paymentMode=body.paymentMode;if(!packageCode||!scheduledStart||!paymentMode)return json({error:"Package, scheduled start and payment mode are required"},400);const db=await database(),quote=await createTrainingQuote(db,{packageCode,petCount:Number(body.petCount||0),scheduledStart,paymentMode,couponCode:body.couponCode});return json({data:{...quote,liveMoney:false}},201);}catch(error){return failure(error);}}
