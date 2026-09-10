export type TaxiVehicleClass="citroen_ec3"|"xuv";
export type TaxiTripType="one_way"|"round_trip";
export type TaxiRidePurpose="regular"|"airport";

export const TAXI_HANDLER_CHARGE=300;
export const TAXI_CLEANING_CHARGE=500;
export const TAXI_RESERVATION_MINUTES=180;
export const TAXI_BOOKING_FEE_PERCENT=50;
export const TAXI_MAX_PASSENGERS=6;
export const TAXI_MAX_PETS=6;
export const TAXI_MAX_LUGGAGE_ITEMS=6;
export const TAXI_MAX_WAITING_MINUTES=12*60;

export const TAXI_VEHICLES={
 citroen_ec3:{
  code:"citroen_ec3" as const,label:"Citroen eC3",category:"Mini SUV",firstKm:5,baseFare:500,extraKmRate:35,waitingPer30Min:150,airportFare:2300,
  passengerComfortMax:3,petComfortMax:3,luggageComfortMax:3,longDriveThresholdKm:70,
  features:["AC","Pet-care trained driver","Carefree pet ride","Pet restraint available","GPS trip tracking","Masked calling"] as const,
 },
 xuv:{
  code:"xuv" as const,label:"XUV",category:"SUV",firstKm:5,baseFare:600,extraKmRate:40,waitingPer30Min:200,airportFare:2600,
  passengerComfortMax:6,petComfortMax:6,luggageComfortMax:6,longDriveThresholdKm:Number.POSITIVE_INFINITY,
  features:["AC","Pet-care trained driver","Extra cabin & luggage space","Pet restraint available","GPS trip tracking","Masked calling"] as const,
 },
} as const;

const money=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
const integer=(value:number,label:string,min:number,max:number)=>{if(!Number.isInteger(value)||value<min||value>max)throw new Error(`${label} must be ${min}-${max}`);return value};

export function validateTaxiParty(input:{passengerCount:number;petCount:number;luggageCount:number}){
 return{
  passengerCount:integer(input.passengerCount,"Passenger count",0,TAXI_MAX_PASSENGERS),
  petCount:integer(input.petCount,"Pet count",1,TAXI_MAX_PETS),
  luggageCount:integer(input.luggageCount,"Luggage count",0,TAXI_MAX_LUGGAGE_ITEMS),
 };
}

export function validateTaxiWaitingMinutes(tripType:TaxiTripType,waitingMinutes:number){
 if(!Number.isInteger(waitingMinutes)||waitingMinutes<0||waitingMinutes>TAXI_MAX_WAITING_MINUTES||waitingMinutes%30!==0)throw new Error("Waiting time must be selected in 30-minute increments");
 if(tripType==="one_way"&&waitingMinutes!==0)throw new Error("Waiting time applies only to round trips");
 return waitingMinutes;
}

export function taxiVehicleRecommendation(input:{passengerCount:number;petCount:number;luggageCount:number;distanceKm:number}){
 const party=validateTaxiParty(input),distanceKm=Number(input.distanceKm);
 if(!Number.isFinite(distanceKm)||distanceKm<=0)throw new Error("Route distance must be positive");
 const reasons:string[]=[];
 if(party.passengerCount>3)reasons.push("more_than_3_passengers");
 if(party.petCount>3)reasons.push("more_than_3_pets");
 if(party.luggageCount>3)reasons.push("more_than_3_luggage_items");
 if(distanceKm>70)reasons.push("route_over_70_km");
 return{recommendedVehicle:(reasons.length?"xuv":"citroen_ec3") as TaxiVehicleClass,citroenEligible:reasons.length===0,reasons};
}

export function calculateTaxiFare(input:{vehicleClass:TaxiVehicleClass;tripType:TaxiTripType;ridePurpose:TaxiRidePurpose;distanceKm:number;passengerCount:number;petCount:number;luggageCount:number;waitingMinutes:number}){
 const party=validateTaxiParty(input),waitingMinutes=validateTaxiWaitingMinutes(input.tripType,input.waitingMinutes),vehicle=TAXI_VEHICLES[input.vehicleClass],distanceKm=money(Number(input.distanceKm));
 if(!Number.isFinite(distanceKm)||distanceKm<=0)throw new Error("Route distance must be positive");
 const recommendation=taxiVehicleRecommendation({...party,distanceKm});
 if(input.vehicleClass==="citroen_ec3"&&!recommendation.citroenEligible)throw new Error(`Citroen eC3 is not eligible for this ride: ${recommendation.reasons.join(",")}`);
 const distanceFare=input.ridePurpose==="airport"?vehicle.airportFare:money(vehicle.baseFare+Math.max(0,distanceKm-vehicle.firstKm)*vehicle.extraKmRate);
 const waitingCharge=input.tripType==="round_trip"?waitingMinutes/30*vehicle.waitingPer30Min:0;
 const handlerCharge=party.passengerCount===0?TAXI_HANDLER_CHARGE:0;
 const quotedTotal=money(distanceFare+waitingCharge+handlerCharge);
 const bookingFee=money(quotedTotal*TAXI_BOOKING_FEE_PERCENT/100);
 return{
  vehicleClass:input.vehicleClass,vehicleLabel:vehicle.label,tripType:input.tripType,ridePurpose:input.ridePurpose,distanceKm,...party,waitingMinutes,
  distanceFare,waitingCharge,handlerCharge,quotedTotal,bookingFee,finalBalanceBeforeAdjustments:money(quotedTotal-bookingFee),
  bookingFeePercent:TAXI_BOOKING_FEE_PERCENT,reservationMinutes:TAXI_RESERVATION_MINUTES,recommendation,
 };
}

export function calculateTaxiAdjustment(input:{vehicleClass:TaxiVehicleClass;type:"parking"|"cleaning"|"extra_waiting"|"extra_distance";amount?:number;minutes?:number;distanceKm?:number}){
 const vehicle=TAXI_VEHICLES[input.vehicleClass];
 if(input.type==="cleaning")return{type:input.type,amount:TAXI_CLEANING_CHARGE,proofRequired:true,incidentRequired:true};
 if(input.type==="parking"){
  const amount=money(Number(input.amount));if(!Number.isFinite(amount)||amount<=0)throw new Error("Parking charge must be a positive amount");
  return{type:input.type,amount,proofRequired:true,incidentRequired:false};
 }
 if(input.type==="extra_waiting"){
  const minutes=validateTaxiWaitingMinutes("round_trip",Number(input.minutes));if(minutes===0)throw new Error("Extra waiting must be at least 30 minutes");
  return{type:input.type,amount:money(minutes/30*vehicle.waitingPer30Min),proofRequired:false,incidentRequired:false,minutes};
 }
 const distanceKm=money(Number(input.distanceKm));if(!Number.isFinite(distanceKm)||distanceKm<=0)throw new Error("Extra distance must be positive");
 return{type:input.type,amount:money(distanceKm*vehicle.extraKmRate),proofRequired:false,incidentRequired:false,distanceKm};
}

export function taxiVehicleEconomics(registrationSuffix:string,vehicleClass:TaxiVehicleClass){
 const suffix=String(registrationSuffix).replace(/\D/g,"").slice(-4);
 if(suffix==="9179")return{ownership:"company" as const,pawspaceSharePercent:100,ownerCommissionPercent:0,gstRate:18,gstBase:"full_fare" as const};
 if(suffix==="9188"||vehicleClass==="xuv")return{ownership:"founder_owned" as const,pawspaceSharePercent:50,ownerCommissionPercent:50,gstRate:18,gstBase:"pawspace_share" as const};
 throw new Error("Taxi vehicle commercial ownership is not configured");
}
