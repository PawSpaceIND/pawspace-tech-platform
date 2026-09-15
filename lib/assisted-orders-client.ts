export type AssistedOrderPet={sourceId:string;canonicalId?:string;name:string;species:"dog"|"cat"|"other";breed?:string;vaccinationStatus?:string};
export type AssistedOrderCustomer={id:string;name:string;primaryPhone:string;secondaryPhone?:string;email?:string;pets:AssistedOrderPet[]};
export type AssistedOrderPackage={code:string;name:string;eligiblePetTypes:Array<"dog"|"cat"|"other">;singlePrice:number;multiPetPrice:number;version:string};
export type AssistedOrderConfig={environment:"UAT";testOnly:true;liveMoney:false;serviceCode:"grooming";customers:AssistedOrderCustomer[];packages:AssistedOrderPackage[]};
export type AssistedOrderInput={idempotencyKey:string;customer:Omit<AssistedOrderCustomer,"pets">;pets:AssistedOrderPet[];cityId:string;zoneId:string;packageCode:string;scheduledStart:string;scheduledEnd:string;consent:{captured:boolean;method:"recorded_call"|"whatsapp"|"email"|"in_person";reference:string;note?:string}};
/*
 * The DUPLICATE REPLAY is the same result with less in it. [R3-C/F6]
 *
 * /api/assisted-orders answers a replayed idempotency key with the existing order rather than creating
 * a second one - and that answer carried no provider and no total. This type declared both as
 * REQUIRED, so app/assisted-booking rendered {result.provider.name} unconditionally, threw
 * `Cannot read properties of undefined`, and the React error boundary replaced the whole screen with
 * "This page didn't load" - leaving the operator never told that the booking already exists.
 *
 * The route now reads the existing booking back and fills these in where it can, but a replay of an
 * order whose booking row is gone still cannot, so the TYPE says so and the screen handles it.
 */
export type AssistedOrderResult={assistedOrderId:string;bookingId:string;customerId?:string;scheduleGroupId?:string|null;provider?:{id:string;name:string;model:string}|null;totalAmount?:number|null;amountDueNow?:number|null;status:string;duplicatePrevented:boolean;lead?:{leadId:string|null;converted:boolean;reason:string};testOnly?:boolean;liveMoney?:boolean};

export async function loadAssistedOrderConfig(){const response=await fetch("/api/assisted-orders",{cache:"no-store"});const body=await response.json() as {data?:AssistedOrderConfig;error?:string};if(!response.ok||!body.data)throw new Error(body.error??"Assisted Orders UAT configuration is unavailable");return body.data;}
export async function createAssistedOrder(input:AssistedOrderInput){const response=await fetch("/api/assisted-orders",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});const body=await response.json() as {data?:AssistedOrderResult;error?:string};if(!response.ok||!body.data)throw new Error(body.error??"Assisted Order UAT could not be created");return body.data;}
