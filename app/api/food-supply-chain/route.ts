import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{createFoodPurchaseOrder,foodSupplyChainSnapshot,receiveFoodPurchaseOrder,recordFoodWastage,saveFoodKitchen,saveFoodSupplier,setFoodReorderPolicy,sweepExpiredFoodBatches}from"../../../lib/food-supply-chain";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function GET(request:Request){try{
 const db=await database(),actor=await resolveActor(request);requirePermission(actor,"bookings.manage");
 const asOfDate=String(new URL(request.url).searchParams.get("asOfDate")||"").trim()||undefined;
 return json({data:await foodSupplyChainSnapshot(db,{asOfDate})});
}catch(error){return authError(error,"Unable to load the Food supply chain");}}

export async function POST(request:Request){try{
 const db=await database(),actor=await resolveActor(request);requirePermission(actor,"bookings.manage");
 const body=await request.json() as Record<string,unknown>,action=String(body.action||"").trim();
 let data:unknown;
 if(action==="save_supplier")data=await saveFoodSupplier(db,{id:body.id?String(body.id):undefined,name:String(body.name||""),contactPhone:String(body.contactPhone||""),status:body.status==="paused"?"paused":"active",actorId:actor.email});
 else if(action==="save_kitchen")data=await saveFoodKitchen(db,{id:body.id?String(body.id):undefined,name:String(body.name||""),zoneId:String(body.zoneId||""),status:body.status==="paused"?"paused":"active",actorId:actor.email});
 else if(action==="create_po")data=await createFoodPurchaseOrder(db,{supplierId:String(body.supplierId||""),kitchenId:body.kitchenId?String(body.kitchenId):undefined,sku:String(body.sku||""),zoneId:String(body.zoneId||""),quantity:Number(body.quantity),unitCost:Number(body.unitCost),expectedAt:body.expectedAt?String(body.expectedAt):undefined,idempotencyKey:String(body.idempotencyKey||""),actorId:actor.email});
 else if(action==="receive_po")data=await receiveFoodPurchaseOrder(db,{purchaseOrderId:String(body.purchaseOrderId||""),preparationDate:String(body.preparationDate||""),expiryDate:String(body.expiryDate||""),actorId:actor.email});
 else if(action==="record_wastage")data=await recordFoodWastage(db,{batchId:String(body.batchId||""),quantity:Number(body.quantity),reason:String(body.reason||""),idempotencyKey:String(body.idempotencyKey||""),actorId:actor.email});
 else if(action==="set_reorder_policy")data=await setFoodReorderPolicy(db,{sku:String(body.sku||""),zoneId:String(body.zoneId||""),minAvailableUnits:Number(body.minAvailableUnits),reorderQuantity:Number(body.reorderQuantity),actorId:actor.email});
 else if(action==="expiry_sweep")data=await sweepExpiredFoodBatches(db,{actorId:actor.email,asOfDate:body.asOfDate?String(body.asOfDate):undefined});
 else return json({error:"Unsupported Food supply-chain action"},400);
 await securityAudit(db,actor,`food.supply_chain.${action}`,"food_supply_chain",String(body.purchaseOrderId||body.batchId||body.sku||body.id||"*"),"completed",{liveMoney:false});
 return json({data});
}catch(error){return authError(error,"Unable to update the Food supply chain");}}
