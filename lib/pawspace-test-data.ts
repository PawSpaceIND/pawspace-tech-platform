export type TestService = "Grooming" | "Dog Training" | "Boarding" | "Pet Sitting" | "Pet Taxi" | "Dog Walking" | "Fresh Food" | "Relocation";
export type TestCustomer = {
  id:string; name:string; primary:string; secondary:string; area:string; segment:"New"|"Repeat"|"Subscriber"|"Dormant";
  petCount:number; pets:string; species:"Dog"|"Cat"|"Mixed"; service:TestService; packageName:string; amount:number;
  payment:"Paid online"|"Pay after service"|"Subscription credit"; subscription:string; credits:number; providerModel:"Full-time"|"Commission";
  nextAction:string; owner:string;
};

const firstNames=["Aarav","Aditi","Akash","Ananya","Arjun","Deepa","Dev","Diya","Farhan","Gauri","Harish","Ishita","Kabir","Kavya","Kiran","Meera","Naveen","Neha","Nikhil","Nisha","Pooja","Pranav","Priya","Rahul","Raj","Riya","Rohan","Sanjay","Shreya","Sneha","Tanya","Varun","Vikram","Zoya"];
const lastNames=["Rao","Shah","Menon","Nair","Patel","Kumar","Iyer","Reddy","Bhat","Singh","Kapoor","Das"];
const areas=["Koramangala","Indiranagar","Whitefield","HSR Layout","JP Nagar","Jayanagar","Marathahalli","Bellandur","Sarjapur","Electronic City"];
const petNames=["Bruno","Coco","Milo","Luna","Max","Oreo","Rocky","Simba","Bella","Leo","Misty","Toby","Rio","Zoe","Oscar","Mochi"];
const services:{service:TestService;packageName:string;amount:number}[]=[
  {service:"Grooming",packageName:"Bath & Basic",amount:1899},
  {service:"Dog Training",packageName:"Doorstep Assessment",amount:999},
  {service:"Boarding",packageName:"Home Stay",amount:1299},
  {service:"Pet Sitting",packageName:"Home Visit",amount:799},
  {service:"Pet Taxi",packageName:"Bengaluru Trip",amount:699},
  {service:"Dog Walking",packageName:"Tracked Walk",amount:399},
  {service:"Fresh Food",packageName:"500 g Fresh Meal",amount:299},
  {service:"Relocation",packageName:"Move Consultation",amount:1499},
];

export const testCustomers:TestCustomer[]=Array.from({length:100},(_,index)=>{
  const i=index+1; const service=services[index%services.length]; const petCount=index%19===0?4:index%11===0?3:index%5===0?2:1;
  const species:TestCustomer["species"]=petCount>1&&index%3===0?"Mixed":index%4===0?"Cat":"Dog";
  const pets=Array.from({length:petCount},(_,petIndex)=>petNames[(index+petIndex*3)%petNames.length]).join(", ");
  const segment=(index%10===0?"Dormant":index%4===0?"Subscriber":index%3===0?"Repeat":"New") as TestCustomer["segment"];
  const credits=segment==="Subscriber"?[2,4,7,10][index%4]:0;
  return {
    id:`TST-${String(i).padStart(3,"0")}`,name:`${firstNames[index%firstNames.length]} ${lastNames[(index*5)%lastNames.length]}`,
    primary:`90000 ${String(11000+i).slice(-5)}`,secondary:`98800 ${String(22000+i).slice(-5)}`,area:areas[index%areas.length],segment,
    petCount,pets,species,service:service.service,packageName:service.packageName,amount:service.amount*Math.min(petCount,3),
    payment:segment==="Subscriber"?"Subscription credit":index%2===0?"Paid online":"Pay after service",
    subscription:segment==="Subscriber"?`${[3,6,12][index%3]}-session plan`:"No active plan",credits,
    providerModel:index%3===0?"Commission":"Full-time",nextAction:segment==="Dormant"?"Win-back due":segment==="Subscriber"?"Next session reminder":"Welcome follow-up",owner:["Neha","Rahul","Sanjay","Asha"][index%4],
  };
});

export const testDataSummary={
  customers:testCustomers.length,
  pets:testCustomers.reduce((sum,customer)=>sum+customer.petCount,0),
  subscribers:testCustomers.filter(customer=>customer.segment==="Subscriber").length,
  services:new Set(testCustomers.map(customer=>customer.service)).size,
};
