export function trainingProgrammeRequestId(input:{customerId:string;petIds:readonly string[];packageCode:string;scheduledStart:string;frequency:string;trainingCategory?:string;healthSafetyNotes?:string;behaviourNotes?:string}):string{
 const customerId=input.customerId.trim(),packageCode=input.packageCode.trim(),scheduledStart=input.scheduledStart.trim(),frequency=input.frequency.trim().replace(/\\s+/g,"");
 const petIds=[...input.petIds].map(value=>value.trim()).filter(Boolean).sort();
 if(!customerId||petIds.length===0||!packageCode||!scheduledStart||!frequency)throw new Error("Training booking identity requires customer, pets, package, start and frequency");
 const base=["training",customerId,petIds.join(","),packageCode,scheduledStart,frequency];
 const details=[input.trainingCategory,input.healthSafetyNotes,input.behaviourNotes].map(value=>String(value??"").trim().replace(/\\s+/g," "));
 if(details.every(value=>!value))return base.join(":");
 return [...base,...details.map(value=>encodeURIComponent(value))].join(":");
}
