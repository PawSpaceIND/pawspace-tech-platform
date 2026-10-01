type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const refuse = (message: string, status = 409) => new Response(message, { status });

/** Address routing, vehicle capacity and fares come from the existing Taxi quote endpoint. */
export async function prepareTaxiSalesQuote(_db: D1Database, input: { schedule: Row; booking: Row; petCount: number }): Promise<Row> {
 const { schedule, booking } = input, taxi = object(booking.taxi);
 const allowed = ["originLabel","destinationLabel","returnDropLabel","passengerCount","luggageCount","tripType","ridePurpose","waitingMinutes","vehicleClass","hyperactivePet"];
 if (Object.keys(taxi).some(key => !allowed.includes(key))) throw refuse("Taxi route and fare fields must come from the server",400);
 if (booking.paymentMode !== "split_50_50") throw refuse("Taxi requires confirmation of its 50 percent booking fee terms",400);
 if (!text(taxi.originLabel) || !text(taxi.destinationLabel) || text(taxi.originLabel) !== text(schedule.serviceAddress)) throw refuse("Confirm the complete pickup address, its PIN and the drop address",400);
 if (!Number.isInteger(taxi.passengerCount) || !Number.isInteger(taxi.luggageCount) || !Number.isInteger(taxi.waitingMinutes)
  || typeof taxi.hyperactivePet !== "boolean" || !["one_way","round_trip"].includes(text(taxi.tripType)) || !["regular","airport"].includes(text(taxi.ridePurpose))) {
  throw refuse("Confirm passenger and luggage counts, trip type, purpose, waiting time and pet handling needs",400);
 }
 if (schedule.occurrences !== undefined && Number(schedule.occurrences) !== 1 || schedule.cadenceDays !== undefined || schedule.weekdays !== undefined) throw refuse("Taxi uses one quoted trip window",400);
 if (booking.requirements !== undefined || booking.boardingRequirements !== undefined) throw refuse("Provide Taxi handling needs in the ride details",400);
 const { POST } = await import("../app/api/taxi-commercial/route");
 const response = await POST(new Request("https://internal.pawspace/api/taxi-commercial",{
  method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
   originLabel:taxi.originLabel,destinationLabel:taxi.destinationLabel,returnDropLabel:taxi.returnDropLabel,
   passengerCount:taxi.passengerCount,luggageCount:taxi.luggageCount,petCount:input.petCount,
   tripType:taxi.tripType,ridePurpose:taxi.ridePurpose,waitingMinutes:taxi.waitingMinutes,scheduledStart:schedule.scheduledStart,
  }),
 }));
 const payload = await response.json() as { data?: Row; error?: string };
 if (!response.ok || !payload.data) throw refuse(payload.error || "The Taxi route and fare could not be verified",response.status >= 500 ? 409 : response.status);
 const quote=payload.data,vehicleClass=text(taxi.vehicleClass)||text(quote.recommendedVehicleClass),fare=object(object(quote.fareOptions)[vehicleClass]);
 if (!["citroen_ec3","xuv"].includes(vehicleClass) || fare.eligible!==true || !Number.isFinite(fare.quotedTotal) || Number(fare.quotedTotal)<=0
  || !Number.isFinite(fare.bookingFee) || Number(fare.bookingFee)<=0 || !text(quote.quoteId) || !text(quote.scheduledEnd)) throw refuse("No verified eligible Taxi fare is available for the selected vehicle");
 schedule.vehicleClass=vehicleClass;schedule.scheduledEnd=quote.scheduledEnd;schedule.occurrences=1;
 booking.taxiQuoteId=quote.quoteId;booking.vehicleClass=vehicleClass;booking.hyperactivePet=taxi.hyperactivePet;booking.packageCode=vehicleClass;
 delete booking.taxi;
 return {...quote,vehicleClass,packageCode:vehicleClass,packageName:text(fare.vehicleLabel),totalAmount:Number(fare.quotedTotal),amountDueNow:Number(fare.bookingFee)};
}

export async function confirmedTaxiSalesPayload(db:D1Database,input:{threadId:string;customerId:string;args:Row;petCount:number}) {
 const quoteId=text(input.args.taxiQuoteId),vehicleClass=text(input.args.vehicleClass);
 const owner=await db.prepare("SELECT quote_json FROM voice_sales_offers WHERE thread_id=? AND customer_id=? AND service_code='pet_taxi' AND status='executing' AND json_extract(quote_json,'$.quoteId')=? LIMIT 1").bind(input.threadId,input.customerId,quoteId).first<Row>();
 if (!owner) throw refuse("Taxi quote does not belong to this confirmed conversation",403);
 const saved=JSON.parse(text(owner.quote_json)) as Row;
 const quote=await db.prepare("SELECT * FROM taxi_ride_quotes WHERE id=? AND status='open' AND expires_at>=?").bind(quoteId,Date.now()).first<Row>();
 if (!quote || Number(quote.pet_count)!==input.petCount || saved.vehicleClass!==vehicleClass || input.args.paymentMode!=="split_50_50"
  || typeof input.args.hyperactivePet!=="boolean") throw refuse("The confirmed Taxi quote expired or changed");
 const fare=object(object(JSON.parse(text(quote.fare_options_json)))[vehicleClass]);
 if (fare.eligible!==true || Number(fare.quotedTotal)!==Number(saved.totalAmount) || Number(fare.bookingFee)!==Number(saved.amountDueNow)) throw refuse("The confirmed Taxi fare changed");
 return {taxiQuoteId:quoteId,vehicleClass,totalAmount:Number(fare.quotedTotal),amountDueNow:Number(fare.bookingFee),hyperactivePet:input.args.hyperactivePet};
}
