/**
 * The PawSpace web chat bot: WATI-style guided flows with buttons, in front of PawSpace AI.
 *
 * The WATI parity project built its chatbot for WhatsApp only and listed website chat as out of scope,
 * so /v2/chat never had one: every message went straight to the language model. This is the web chat's
 * guided layer. A visitor picks a service from buttons and answers a short, WATI-style questionnaire
 * ("Please type your Name", "Please select the travel type: Domestic / International", "Travel date in
 * DD/MM format"). A question typed at the menu goes to PawSpace AI; asking for a person, a refund or an
 * emergency goes to a human at once.
 *
 * This module is a pure state machine: no database, no network. The route persists the state and acts
 * on the events it returns (`ai`, `human`, `completed`), which keeps every flow testable on its own.
 */

import{groomingCatalogue}from"./grooming-governance";
import{GROOMING_CLOSING_COUPON,GROOMING_CROSS_SELL_COUPON}from"./coupon-governance";

/** `value` is what the answer records when the button shows more than the answer (a price). */
export type BotChoice={id:string;label:string;value?:string};
type StepKind="choice"|"text"|"name"|"phone"|"email"|"date"|"end";
type Answers=Record<string,string>;
type Step={key:string;label:string;prompt:string|((answers:Answers)=>string);kind:StepKind;choices?:BotChoice[];hint?:string;
 /** Asked only when the visitor is not signed in: a signed-in customer's identity is already known. */
 anonymousOnly?:boolean;
 /** A WATI branch: the step is asked only when this holds for the answers so far. */
 when?:(answers:Answers)=>boolean;
 /** The flow ends once this step is answered (WATI's "existing customer - type your requirement"). */
 last?:boolean|((answers:Answers)=>boolean);
 /** Shows the details collected so far above the question (WATI's "Please confirm the following details"). */
 showSummary?:boolean;
 /** This answer sends the customer back to the start of the flow (WATI's "No" to "confirm the booking?"). */
 restartOn?:string;
 /** WATI's "invoke flow": this answer continues the conversation in another flow. */
 invoke?:Record<string,string>;
 max?:number};
type Flow={code:string;service:string;label:string;steps:Step[];
 /** What the customer is told when the flow is finished, as the WATI flow says it. */
 closing?:(answers:Answers)=>string;
 /** A finished enquiry a person follows up (an existing booking, an active subscription), not the AI. */
 teamFollowUp?:(answers:Answers)=>boolean;
 /** The Inbox queue a team follow-up goes to, when it is not the sales queue. */
 followUpReason?:"sensitive_relocation";
 /** Ends with WATI's grooming cross-sell ("Enjoy Rs 400 off Pet Grooming"). */
 groomingOffer?:boolean};

/* Bumped whenever a flow's steps change shape: a conversation saved under an older shape starts again
 * rather than resuming at a step index that now means a different question. */
const BOT_STATE_VERSION=2;
export type BotState={version:typeof BOT_STATE_VERSION;status:"menu"|"collecting"|"done";flow:string|null;step:number;answers:Record<string,string>;
 /** The CRM lead created for a visitor as soon as their number is known (web chat). */
 leadId?:string;
 /** When a stalled flow was last nudged by the follow-up sweep. */
 nudgedAt?:number;
 /** The service a lead enquired about (its WhatsApp template was for it): a short reply starts that flow. */
 preferredFlow?:string};
export type BotReply={text:string;choices:BotChoice[];inputHint:string|null};
export type BotEvent=
 |{type:"none"}
 |{type:"ai";question:string}
 |{type:"call"}
 |{type:"human";reason:"customer_requested_human"|"refund_payment_dispute"|"complaint"|"safety"|"urgent_funeral_memorial"}
 |{type:"completed";flow:string;service:string;answers:Record<string,string>;summary:string;followUp?:"team";followUpReason?:"sensitive_relocation"};
export type BotTurnResult={state:BotState;reply:BotReply;event:BotEvent;
 /** The customer's input as it should appear in the conversation (a button shows its label). */
 display:string};

const choice=(label:string):BotChoice=>({id:label.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,""),label});
const choices=(...labels:string[])=>labels.map(choice);
/** "₹1,349": the Indian grouping for the prices PawSpace shows (all under a lakh). */
export const rupees=(amount:number)=>`₹${amount>=1000?`${Math.floor(amount/1000)},${String(amount%1000).padStart(3,"0")}`:amount}`;
/* The grooming package buttons carry the catalogue's single-pet price, as WATI's did ("Essential - 1099"),
 * from lib/grooming-governance.ts so a price change there reaches the bot. The answer stays the package
 * name, and typing the name still picks the button. */
const groomingPackage=(code:string):BotChoice=>{const item=groomingCatalogue.find(row=>row.code===code&&row.active);if(!item)throw new Error(`Grooming package ${code} is not in the catalogue`);return{...choice(item.name),label:`${item.name} ${rupees(item.singlePrice)}`,value:item.name};};
const PET=choices("Dog","Cat");
const PET_COUNT=choices("1","2","3 & above");

const NAME:Step={key:"name",label:"Name",prompt:"Please type your Name",kind:"name",hint:"Your name",anonymousOnly:true};
const AREA:Step={key:"area",label:"Area",prompt:"Which area or pincode should we come to?",kind:"text",hint:"Area or pincode"};

/* ---------------------------------------------------------------------------------------------------
 * The WATI flows, mirrored from PawSpace's own WATI exports (pet_grooming_flow_app_option_mumbai,
 * Training_new_2025, Boarding_new_2025, Sitting_new_2025, New Pet Taxi short flow): the same questions,
 * buttons, lists, branches and closing messages. Two deliberate differences:
 *  - grooming package buttons carry PawSpace's catalogue package names, without prices: the WATI buttons
 *    carried prices that no longer match the live catalogue, and PawSpace AI quotes the live price;
 *  - where WATI writes the answers to a Google Sheet, the enquiry goes to the CRM and the Inbox instead.
 * --------------------------------------------------------------------------------------------------- */
const OTHER=new Set(["Others","Other"]);
const SHOW_MORE="Show more breeds";
const is=(key:string,...values:string[])=>(answers:Answers)=>values.includes(answers[key]);
const CITY:Step={key:"city",label:"City",prompt:"Select your CITY",kind:"choice",choices:choices("Bangalore","Hyderabad","Others")};
const OUT_OF_AREA:Step={key:"outOfArea",label:"Out of area",kind:"end",when:is("city","Others"),
 prompt:"Apologies - at present we are only available in Bangalore and Hyderabad.\nHope to serve in future.\nThank you for considering PawSpace."};
const CUSTOMER_STATUS=(service:string):Step=>({key:"customerStatus",label:"Customer",prompt:`Have you enquired about or availed of our ${service} services before?`,kind:"choice",choices:choices("First-time Enquiry","Existing Customer")});
const REQUIREMENT=(when:(answers:Answers)=>boolean):Step=>({key:"requirement",label:"Requirement",prompt:"Please type your requirement",kind:"text",hint:"Your requirement",when,last:true,max:600});
const ELDEST_AGE:Step={key:"petAge",label:"Eldest pet's age",prompt:"Select Eldest Pet Age",kind:"choice",choices:choices("Less than 6 months","6 months to 1 year","1 to 3 years","3+ years")};
const HAPPINESS_TEAM="Our dedicated Happiness Team will be reaching out to you soon to initiate the next steps of engagement.\nThank you.";

const DOG_BREEDS=choices("Indie","Shih Tzu","Labrador","Golden Retriever","German Shepherd","Beagle","Husky","Pomeranian","Lhasa Apso",SHOW_MORE);
const DOG_BREEDS_MORE=choices("Indian Pariah","Indian Spitz","Cocker Spaniel","Dachshund","Yorkshire Terrier","French Bulldog","Pug","Rottweiler","Great Dane","Others");
const CAT_BREEDS=choices("Indian Domestic Cat","Persian Cat","Siamese Cat","Maine Coon","British Shorthair","Siberian Cat","Bengal Cat","Bombay Cat","Ragdoll","Other");
const SERVICE_TIME=choices("9am-11am","11am-1pm","1pm-3pm","3pm-5pm","5pm-7pm");
const GROOMING_PITCH="Our packages (price for 1 pet):\n\n❌🚗 No travel stress\n❌⏳ No booking & waiting hassle\n🏅 Senior experienced & certified groomer\n🧴✂️ Imported products & equipment\n💨 Quick blow-dry\n✅ Safe & secure\n🧹 Post-service clean up\n🐾💯 Trusted by 12000+ pet parents\n\nPlease select the package\nDiscount coupons available on the Mobile app";
const ADD_ONS="\n\n1. Minor trimming\n2. Full body trimming\n3. Oil massage\n4. Tick treatment";
const LOCATION_HINT="(include house / flat number, street, locality & area)\n\nAlso, copy and paste the Google location link from maps here so we can reach you quickly without disturbing you for the route.";

const subscribed=is("subscription","Yes"),fresh=(answers:Answers)=>!subscribed(answers);
const petIs=(type:string)=>(answers:Answers)=>fresh(answers)&&answers.petType===type;
/** One or two pets are picked from the breed lists; three or more are typed, as in WATI. */
const listsBreeds=(answers:Answers)=>fresh(answers)&&answers.petCount!=="3 & above";
const breedSteps=(key:string,label:string,prompt:(answers:Answers)=>string,when:(answers:Answers)=>boolean):Step[]=>[
 {key,label,prompt,kind:"choice",choices:DOG_BREEDS,when:answers=>when(answers)&&answers.petType==="Dog"},
 {key,label,prompt,kind:"choice",choices:DOG_BREEDS_MORE,when:answers=>when(answers)&&answers.petType==="Dog"&&answers[key]===SHOW_MORE},
 {key,label,prompt,kind:"choice",choices:CAT_BREEDS,when:answers=>when(answers)&&answers.petType==="Cat"}];

const GROOMING:Flow={code:"grooming",service:"Grooming",label:"Grooming",steps:[NAME,
 {key:"subscription",label:"Active subscription",prompt:"Hi! Do you currently have an active grooming subscription with us?",kind:"choice",choices:choices("Yes","No")},
 // An active subscription: when, add-ons and address, then a person confirms (WATI assigns the team).
 {key:"date",label:"Service date",prompt:"Please type the date of service required in DD/MM format",kind:"date",hint:"DD/MM",when:subscribed},
 {key:"time",label:"Service time",prompt:"Please choose service time",kind:"choice",choices:SERVICE_TIME,when:subscribed},
 {key:"addOns",label:"Add-ons",prompt:`Do you want to avail any of the following add-ons?${ADD_ONS}`,kind:"choice",choices:choices("Yes","No"),when:subscribed},
 {key:"addOnList",label:"Add-ons list",prompt:`Please type the serial numbers of the add-ons required. eg: type 1 for Minor trimming${ADD_ONS}`,kind:"text",hint:"For example 1, 3",when:answers=>subscribed(answers)&&answers.addOns==="Yes"},
 {key:"sameAddress",label:"Address",prompt:"Is your service location (your address) the same as last time?",kind:"choice",choices:choices("Yes, it's same","No, it's changed"),when:subscribed,last:is("sameAddress","Yes, it's same")},
 {key:"newAddress",label:"New address",prompt:`Please type the NEW service location address ${LOCATION_HINT}`,kind:"text",hint:"Address and map link",when:subscribed,last:true,max:600},
 // A new booking.
 {key:"petType",label:"Pet type",prompt:"Please select the type of pet",kind:"choice",choices:PET,when:fresh},
 {key:"petCount",label:"Number of pets",prompt:"Please select the number of pets",kind:"choice",choices:PET_COUNT,when:fresh},
 ...breedSteps("breed","Breed",answers=>answers.petCount==="2"?"Please select the Breed of your 1st pet":"Please select the Breed of your pet",listsBreeds),
 ...breedSteps("breed2","2nd pet's breed",()=>"Please select the Breed of your 2nd pet",answers=>fresh(answers)&&answers.petCount==="2"&&!OTHER.has(answers.breed)),
 {key:"breedTyped",label:"Breed",prompt:"Please type the breed of the pet(s)",kind:"text",hint:"For example Labrador and Pug",when:answers=>fresh(answers)&&(answers.petCount==="3 & above"||OTHER.has(answers.breed)||OTHER.has(answers.breed2))},
 {key:"package",label:"Package",prompt:GROOMING_PITCH,kind:"choice",choices:["dog-bath","dog-basic","dog-makeover"].map(groomingPackage),when:petIs("Dog")},
 {key:"package",label:"Package",prompt:GROOMING_PITCH,kind:"choice",choices:["cat-routine","cat-basic","cat-makeover"].map(groomingPackage),when:petIs("Cat")},
 {key:"date",label:"Service date",prompt:"Please type the date of service required in DD/MM format",kind:"date",hint:"DD/MM",when:fresh},
 {key:"time",label:"Service time",prompt:"Please choose service time",kind:"choice",choices:SERVICE_TIME,when:fresh},
 {key:"address",label:"Address",prompt:`Please type the service location address ${LOCATION_HINT}`,kind:"text",hint:"Address and map link",when:fresh,max:600},
 {key:"confirm",label:"Confirmed",prompt:"Would you like me to confirm the booking?",kind:"choice",choices:choices("OK","No"),when:fresh,showSummary:true,restartOn:"No"}],
 closing:answers=>`Thank you for your order 🙏\nOur representative will reach out to you ${subscribed(answers)?"for order confirmation":"regarding the payment & confirmation"}.\n\nWhat do we require from you?\n1️⃣ Space for grooming\n2️⃣ Access to water\n3️⃣ Access to electricity`,
 teamFollowUp:subscribed};

const oneDog=is("dogCount","1"),severalDogs=is("dogCount","2","3 or more");
const trainingNew=(answers:Answers)=>answers.customerStatus!=="Existing Customer";
/* A first-time training enquiry; an existing customer only types their requirement. */
const TRAINING_ENQUIRY:Step[]=[
 {key:"dogCount",label:"Number of dogs",prompt:"Please state the number of dog(s) for which you are looking for training service.",kind:"choice",choices:choices("1","2","3 or more")},
 {key:"breed",label:"Breed",prompt:"Select the Breed",kind:"choice",choices:choices("Golden Retriever","Labrador","Shih Tzu","Poodle / Maltese","Pug","Lhasa Apso","Dachshund","Cocker Spaniel","Yorkshire Terrier","Show more"),when:oneDog},
 {key:"breed",label:"Breed",prompt:"Select the Breed",kind:"choice",choices:choices("Indian Dog(pariah)","German Shepherd","Siberian Husky","Beagle","Pomeranian/ Indian Spitz","Boxer","French Bull dog","Great Dane","Rottweiler","Others"),when:answers=>oneDog(answers)&&answers.breed==="Show more"},
 {key:"breedTyped",label:"Breed",prompt:"Please specify the Breed",kind:"text",hint:"Breed",when:answers=>oneDog(answers)&&answers.breed==="Others"},
 {key:"age",label:"Age",prompt:"How old is your pet?",kind:"choice",choices:choices("Pup - less than 1yr","Adult - 1-3 yrs","Adult- 3yrs+"),when:oneDog},
 {key:"gender",label:"Gender",prompt:"Please state the gender of your pet",kind:"choice",choices:choices("Female","Male"),when:oneDog},
 {key:"breedTyped",label:"Breeds",prompt:"Please specify the breed of the Dogs\nExample: Labrador and German Shepherd",kind:"text",hint:"Breeds",when:severalDogs},
 {key:"ages",label:"Ages",prompt:"Please specify the Age of your Pets\nExample: 4 months and 5 months",kind:"text",hint:"Ages",when:severalDogs},
 {key:"genders",label:"Genders",prompt:"Please specify the Gender of your Pets",kind:"text",hint:"Genders",when:severalDogs},
 {key:"concerns",label:"Type of training needed",prompt:"What type of training are you looking for?\nEg: Puppy Training, Basic obedience, Toilet training, Biting issues, Leash pulling-walk training, Separation anxiety, Behaviour training, house obedience training",kind:"text",hint:"Type of training",max:400},
 {key:"consultationDate",label:"Consultation date",prompt:"Please type the preferred date for phone consultation in DD/MM/YYYY format",kind:"date",hint:"DD/MM/YYYY"},
 {key:"consultationTime",label:"Consultation time",prompt:"Please choose consultation time",kind:"choice",choices:choices("11am-1pm","1pm-3pm","3pm-5pm","5pm-7pm")}];
const TRAINING:Flow={code:"training",service:"Dog Training",label:"Dog Training",steps:[NAME,CITY,OUT_OF_AREA,CUSTOMER_STATUS("training"),
 REQUIREMENT(is("customerStatus","Existing Customer")),
 ...TRAINING_ENQUIRY.map(step=>({...step,when:(answers:Answers)=>trainingNew(answers)&&(!step.when||step.when(answers))}))],
 closing:()=>HAPPINESS_TEAM,teamFollowUp:is("customerStatus","Existing Customer"),groomingOffer:true};

/** Boarding and Pet Sitting share one WATI flow shape; only the service name differs. */
function stayFlow(code:string,service:string,serviceName:string):Flow{
 const firstTime=(answers:Answers)=>answers.customerStatus!=="Existing Customer";
 const newBooking=(answers:Answers)=>firstTime(answers)||answers.bookingStatus==="New Booking";
 const only=(when:(answers:Answers)=>boolean,step:Step):Step=>({...step,when});
 return{code,service,label:service,steps:[NAME,CUSTOMER_STATUS(serviceName),
  {key:"bookingStatus",label:"Booking",prompt:"Would you like to make a new booking or check an existing one?",kind:"choice",choices:choices("New Booking","Existing Booking"),when:is("customerStatus","Existing Customer")},
  REQUIREMENT(is("bookingStatus","Existing Booking")),
  only(firstTime,CITY),only(answers=>firstTime(answers)&&answers.city==="Others",OUT_OF_AREA),
  {key:"petType",label:"Type of pet",prompt:"Please select the pet type for which you are looking for the service.",kind:"choice",choices:choices("Dog","Cat","Both Cat and Dog"),when:firstTime},
  {key:"petCount",label:"Number of pets",prompt:"Please state the number of pets",kind:"choice",choices:choices("1","2","3 or more"),when:firstTime},
  only(firstTime,ELDEST_AGE),
  {key:"package",label:"Package",prompt:"Please select the Package Type",kind:"choice",choices:choices("Up to 4 hr","Up to 10 hr","Overnight - 24 hrs"),when:newBooking},
  {key:"days",label:"No. of days",prompt:`Select the number of days for which you are looking for ${serviceName.toLowerCase()} for your pet(s).`,kind:"choice",choices:choices("0-2 days","2-5 days","More than 5 days"),when:newBooking},
  {key:"checkIn",label:"Check in",prompt:"📌 Check-in Date & Time",kind:"text",hint:"For example 28/09 10am",when:newBooking},
  {key:"checkOut",label:"Check out",prompt:"📌 Check-out Date & Time",kind:"text",hint:"For example 30/09 6pm",when:newBooking}],
  closing:()=>HAPPINESS_TEAM,teamFollowUp:is("bookingStatus","Existing Booking"),groomingOffer:true};
}

const PET_TAXI:Flow={code:"pet_taxi",service:"Pet Taxi",label:"Pet Taxi",steps:[{...NAME,prompt:"Please mention your Name"},
 {key:"travelType",label:"Travel type",prompt:"Hello,\nPlease select the travel type",kind:"choice",choices:choices("Incity","Outstation from BLR"),invoke:{"Outstation from BLR":"relocation"}},
 {key:"petType",label:"Pet type",prompt:"Please select the pet type for which you are looking for taxi service.",kind:"choice",choices:choices("Dog","Cat","Others")},
 {key:"petCount",label:"No. of pets",prompt:"Please select the number of pets travelling.",kind:"choice",choices:choices("1","2","3 and more")},
 ELDEST_AGE,
 {key:"passengers",label:"No. of passengers",prompt:"State the number of passengers travelling along with the pet",kind:"choice",choices:choices("0","1-2","3 and more")},
 {key:"handler",label:"Handler",prompt:"Do you require a handler for taking care of pet?\nHandler: trained caretaker to handle your pet",kind:"choice",choices:choices("Yes","No","Not sure")},
 {key:"purpose",label:"Travel purpose",prompt:"Select the purpose of your travel with pet",kind:"choice",choices:choices("Vet Visits","Airport/station","Leisure (incity)trip")},
 {key:"luggage",label:"Luggage",prompt:"Please select the number of luggage",kind:"choice",choices:choices("1-2","2-4","4 +"),when:is("purpose","Airport/station")},
 {key:"date",label:"Date",prompt:"Travel date\nPlease type travel date in DD/MM format",kind:"date",hint:"DD/MM"},
 {key:"time",label:"Time",prompt:"Travel time\nPlease type travel start time in AM/PM format.",kind:"text",hint:"For example 10:30 AM"},
 {key:"tripType",label:"Trip engagement",prompt:"Please select trip type",kind:"choice",choices:choices("One way trip","Round Trip")},
 {key:"waiting",label:"Waiting period",prompt:"Please select waiting period",kind:"choice",choices:choices("Less than 30 min","60 mins","More than 60mins"),when:is("tripType","Round Trip")},
 {key:"pickup",label:"Pick up address",prompt:"Please type the complete Pick up Address",kind:"text",hint:"Pick up address",max:600},
 {key:"drop",label:"Drop location address",prompt:"Please type the complete Drop location address",kind:"text",hint:"Drop address",max:600},
 {key:"confirm",label:"Confirmed",prompt:"Do you confirm the above details?",kind:"choice",choices:choices("Yes","No"),showSummary:true,last:is("confirm","Yes")},
 {key:"change",label:"Required change",prompt:"Please type the required change",kind:"text",hint:"What should we change?",when:is("confirm","No"),max:600}],
 closing:()=>"Thank you for providing your pet taxi booking details.\nWe're now processing your request and will send your personalised quote shortly.\nWe appreciate you choosing PawSpace Pet Taxi!",
 groomingOffer:true};

/* WATI "Pet relocation short flow"; Pet Taxi's "Outstation from BLR" continues here, as WATI invokes it. */
const RELOCATION:Flow={code:"relocation",service:"Pet Relocation",label:"Pet Relocation",steps:[NAME,
 {key:"travelType",label:"Travel type",prompt:"Please select the travel type",kind:"choice",choices:choices("Domestic","International")},
 {key:"email",label:"Email ID",prompt:"Please type your Email ID",kind:"email",hint:"name@example.com"},
 {key:"petType",label:"Pet type",prompt:"Please select the pet type",kind:"choice",choices:choices("Dog","Cat","Other")},
 {key:"petTypeTyped",label:"Pet type",prompt:"Please type the pet type",kind:"text",hint:"For example Rabbit",when:is("petType","Other")},
 {key:"from",label:"From location",prompt:"Please type your start city\nFrom Location",kind:"text",hint:"Start city"},
 {key:"to",label:"To location",prompt:"Please type your destination city\nTo Location",kind:"text",hint:"Destination city"},
 {key:"date",label:"Date of travel",prompt:"Please type the travel start date (tentative) in DD/MM/YY format",kind:"date",hint:"DD/MM/YY"},
 {key:"confirm",label:"Confirmed",prompt:"Are these details correct?",kind:"choice",choices:choices("Yes","No"),showSummary:true,last:is("confirm","Yes")},
 {key:"change",label:"Required changes",prompt:"Please type the required changes",kind:"text",hint:"What should we change?",when:is("confirm","No"),max:600}],
 closing:()=>"Our relocation partner team will contact you on phone within 24 hours.\nThank you.\n\nPlease explore additional services we offer.",
 teamFollowUp:()=>true,followUpReason:"sensitive_relocation"};

export const WEB_CHAT_FLOWS:Flow[]=[GROOMING,TRAINING,stayFlow("boarding","Boarding","Pet Boarding"),stayFlow("pet_sitting","Pet Sitting","Pet Sitting"),
 {code:"dog_walking",service:"Dog Walking",label:"Dog Walking",steps:[NAME,
  {key:"walks",label:"Walks per day",prompt:"How many walks a day?",kind:"choice",choices:[choice("Once a day"),choice("Twice a day")]},
  {key:"duration",label:"Walk length",prompt:"How long should each walk be?",kind:"choice",choices:[choice("30 minutes"),choice("60 minutes")]},
  AREA]},
 PET_TAXI,
 {code:"fresh_food",service:"Fresh Food",label:"Fresh Food",steps:[NAME,
  {key:"petType",label:"Pet",prompt:"Is the food for a dog or a cat?",kind:"choice",choices:PET},
  {key:"plan",label:"Plan",prompt:"What would you like to try?",kind:"choice",choices:[choice("Trial pack"),choice("Monthly subscription"),choice("Not sure yet")]},
  AREA]},
 RELOCATION,
];

/** A visitor who is not signed in and asks for a person: the team needs a name and number to reach them. */
const TEAM_FLOW:Flow={code:"team",service:"Talk to our team",label:"Talk to our team",steps:[
 {key:"topic",label:"Needs help with",prompt:"What would you like our team to help you with?",kind:"text",hint:"Your question"},NAME]};

/** Contact details and WhatsApp consent, asked last and only of a visitor who is not signed in. */
const PHONE:Step={key:"phone",label:"Phone",prompt:"Please type your 10-digit mobile number so our team can reach you",kind:"phone",hint:"Mobile number",anonymousOnly:true};
const CONSENT:Step={key:"whatsapp",label:"WhatsApp updates",prompt:"Can we continue this on WhatsApp?",kind:"choice",choices:[choice("Yes, WhatsApp me"),choice("No, call me instead")],anonymousOnly:true};

export const ASK_AI:BotChoice={id:"ask_ai",label:"Ask a question"};
export const TALK_TO_TEAM:BotChoice={id:"talk_to_team",label:"Talk to our team"};
export const REQUEST_CALL:BotChoice={id:"request_call",label:"Request a call"};
const START_OVER:BotChoice={id:"start_over",label:"Start over"};
/** WATI's closing cross-sell after Training, Boarding, Sitting and Pet Taxi. */
export const GROOMING_OFFER:BotChoice={id:"grooming_offer",label:"Get ₹400 off"};
const PAY_LATER:BotChoice={id:"pay_full_price_later",label:"Pay full price later"};
const groomingOfferText=(code:string)=>`Enjoy ₹400 off Pet Grooming, Exclusively ONLY for You 🐶🛁\nUse code ${code} when you book.`;
/** The cross-sell coupon as the caller found it live for this customer, or null while it cannot be redeemed. */
export type BotCrossSell={code:string;cityIds:string[]}|null;
const DEFAULT_CROSS_SELL:BotCrossSell={code:GROOMING_CROSS_SELL_COUPON,cityIds:["blr"]};
const CITY_IDS:Record<string,string>={Bangalore:"blr",Hyderabad:"hyd"};
/* WATI's offer is only shown while its coupon can be used: the campaign is live, and the customer is in
 * one of its cities (a Hyderabad enquiry is not promised a Bangalore-only code). */
const crossSellFor=(crossSell:BotCrossSell,answers:Answers)=>crossSell&&(!answers.city||!CITY_IDS[answers.city]||crossSell.cityIds.includes(CITY_IDS[answers.city]))?crossSell:null;
/** What the answers record for the cross-sell, so the team, the AI and the app all see the same code. */
export const GROOMING_OFFER_NOTE="₹400 off Pet Grooming";
export{GROOMING_CLOSING_COUPON,GROOMING_CROSS_SELL_COUPON};
export const WEB_CHAT_MENU:BotChoice[]=[...WEB_CHAT_FLOWS.map(flow=>({id:flow.code,label:flow.label})),ASK_AI,REQUEST_CALL,TALK_TO_TEAM];
const GREETING="Hi! I'm PawSpace AI. What can I help you with today? Pick a service to get started, or just type your question.";

const HUMAN_PATTERNS:Array<[RegExp,Extract<BotEvent,{type:"human"}>["reason"]]>=[
 [/\b(human|agent|real person|representative|talk to (someone|a person)|speak to (someone|a person))\b/i,"customer_requested_human"],
 [/\b(refund|money back|payment dispute|charged twice|wrong charge)\b/i,"refund_payment_dispute"],
 [/\b(complaint|bad service|poor service|not happy|unhappy)\b/i,"complaint"],
 [/\b(emergency|injured|injury|bleeding|poison(ed)?|not breathing|seizure|collapsed)\b/i,"safety"],
 [/\b(funeral|memorial|cremation|passed away)\b/i,"urgent_funeral_memorial"],
];
const RESTART=/^(menu|main menu|restart|start over|start again|hi|hello|hey)$/i;

const FLOW_KEYWORDS:Record<string,RegExp>={grooming:/\bgroom/,training:/\btrain/,boarding:/\bboard/,pet_sitting:/\bsitt(ing|er)\b/,dog_walking:/\bwalk/,pet_taxi:/\b(taxi|cab)\b/,fresh_food:/\bfood\b/,relocation:/\brelocat/};
/**
 * "Book grooming", "need a dog walker": a short request that names a service starts its flow, as the
 * reply button of a WATI service template does. Questions and negations are left for PawSpace AI.
 */
export function flowFromText(value:string){
 const text=value.trim().toLowerCase();if(!text||text.length>40||text.includes("?")||/\b(not|no|don'?t|never)\b/.test(text))return null;
 const matches=Object.entries(FLOW_KEYWORDS).filter(([,pattern])=>pattern.test(text)).map(([code])=>code);
 return matches.length===1?flowByCode(matches[0]):null;
}
const SHORT_YES=/^(yes|yeah|yep|ok|okay|sure|book|book now|start|continue|interested|get started|let'?s go|go ahead)[.! ]*$/i;

export function initialBotState():BotState{return{version:BOT_STATE_VERSION,status:"menu",flow:null,step:0,answers:{}};}
export function parseBotState(value:unknown):BotState{
 try{const parsed=typeof value==="string"?JSON.parse(value):value;if(parsed&&typeof parsed==="object"&&(parsed as BotState).version===BOT_STATE_VERSION&&["menu","collecting","done"].includes((parsed as BotState).status))return parsed as BotState;}catch{}
 return initialBotState();
}
export function menuReply(text=GREETING):BotReply{return{text,choices:WEB_CHAT_MENU,inputHint:"Type a question or pick a service"};}
export function flowByCode(code:string|null){return code===TEAM_FLOW.code?TEAM_FLOW:WEB_CHAT_FLOWS.find(flow=>flow.code===code)||null;}

/* The phone number comes straight after the name: a visitor who stops half way still leaves a lead the
 * team can call, which is how a WATI flow works (WhatsApp already knows the number). */
function stepsFor(flow:Flow,signedIn:boolean){const named=flow.steps.findIndex(step=>step.key==="name"),steps=[...flow.steps];steps.splice(named+1,0,PHONE);return[...steps,CONSENT].filter(step=>!(signedIn&&step.anonymousOnly));}
/** The next step to ask from `from` on, skipping the WATI branches that do not apply. */
function nextStep(steps:Step[],from:number,answers:Answers){
 const skip=(step:Step)=>(step.when&&!step.when(answers))||(CONTACT_KEYS.has(step.key)&&Boolean(answers[step.key]));
 let index=from;while(index<steps.length&&skip(steps[index]))index++;return index;
}
/** A visitor's name, number and consent, carried into the next flow so they are not asked twice. */
const CONTACT_KEYS=new Set(["name","phone","whatsapp"]);
const contactOf=(answers:Answers)=>Object.fromEntries(Object.entries(answers).filter(([key])=>CONTACT_KEYS.has(key)));
const offerOf=(answers:Answers)=>Object.fromEntries(Object.entries(answers).filter(([key])=>key==="offer"||key==="coupon"));
function isLast(step:Step,answers:Answers){return typeof step.last==="function"?step.last(answers):Boolean(step.last);}
function askReply(step:Step,prefix="",context?:{flow:Flow;answers:Answers;signedIn:boolean}):BotReply{
 const prompt=typeof step.prompt==="function"?step.prompt(context?.answers||{}):step.prompt;
 const summary=step.showSummary&&context?`Please confirm the following details\n${summaryLines(context.flow,context.answers,context.signedIn).join("\n")}\n\n`:"";
 return{text:`${prefix}${summary}${prompt}`,choices:[...(step.choices||[]),START_OVER],inputHint:step.kind==="choice"?"Pick an option above":step.hint||null};
}

function matchChoice(choices:BotChoice[],input:{text:string;choiceId?:string|null},numbered=true){
 const id=String(input.choiceId||"").trim();if(id){const byId=choices.find(item=>item.id===id);if(byId)return byId;}
 // Trailing "." and "!" are dropped with a loop, not /[.!]+$/, which backtracks quadratically on "....x".
 let typed=input.text.trim().toLowerCase(),end=typed.length;while(end>0&&(typed[end-1]==="."||typed[end-1]==="!"))end--;typed=typed.slice(0,end);if(!typed)return null;
 const index=Number(typed);if(numbered&&Number.isInteger(index)&&index>=1&&index<=choices.length)return choices[index-1];
 // WhatsApp cuts button titles at 20 characters and list titles at 24, and sends the title back.
 return choices.find(item=>item.label.toLowerCase()===typed||item.value?.toLowerCase()===typed||item.id===typed.replace(/[^a-z0-9]+/g,"_"))
  ||(typed.length>=18?choices.find(item=>item.label.toLowerCase().startsWith(typed)):undefined)||null;
}

/**
 * DD/MM or DD/MM/YYYY, a real calendar date. Without a year it means the next time that date comes round
 * (today counts), so 29/02 is valid only when a leap year is next, and the stored answer carries the year.
 */
export function parseDayMonth(value:string,now=Date.now()){
 const match=value.trim().match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);if(!match)return null;
 const day=Number(match[1]),month=Number(match[2]);
 const real=(year:number)=>{const date=new Date(Date.UTC(year,month-1,day));return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date:null;};
 let year:number;
 if(match[3])year=Number(match[3].length===2?`20${match[3]}`:match[3]);
 else{const today=new Date(now),start=Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate());year=today.getUTCFullYear();const thisYear=real(year);if(!thisYear||thisYear.getTime()<start)year+=1;}
 return real(year)?`${String(day).padStart(2,"0")}/${String(month).padStart(2,"0")}/${year}`:null;
}

function validate(step:Step,raw:string):{value:string}|{error:string}{
 const max=step.max??160;
 const value=raw.trim().replace(/\s+/g," ");
 if(step.kind==="name")return/^[\p{L}][\p{L} .'-]{1,79}$/u.test(value)?{value}:{error:"Please type your name using letters only."};
 if(step.kind==="phone"){const digits=value.replace(/\D/g,"").replace(/^91(?=\d{10}$)/,"").replace(/^0(?=\d{10}$)/,"");return/^[6-9]\d{9}$/.test(digits)?{value:`+91${digits}`}:{error:"Please type a valid 10-digit Indian mobile number."};}
 // Domain labels are split on the dot so the pattern has one way to match (no polynomial backtracking).
 if(step.kind==="email")return value.length<=160&&/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)&&(value.split(".").at(-1)?.length??0)>=2?{value:value.toLowerCase()}:{error:"That doesn't look like an email address. Please type it like name@example.com."};
 if(step.kind==="date"){const date=parseDayMonth(value);return date?{value:date}:{error:"Please type the date in DD/MM format, for example 28/09."};}
 if(value.length>max)return{error:`Please keep it under ${max} characters.`};
 return value.length>=2?{value}:{error:"Please type a little more detail."};
}

function summaryLines(flow:Flow,answers:Answers,signedIn:boolean){
 const seen=new Set<string>(),lines:string[]=[];
 // The offer leads, so no length limit downstream (CRM summary, handoff snapshot) can cut the code off.
 if(answers.offer)lines.push(`Offer: ${answers.offer}${answers.coupon?` (use code ${answers.coupon})`:""}`);
 if(answers.via)lines.push(`Enquiry from: ${answers.via}`);
 for(const step of stepsFor(flow,signedIn)){if(seen.has(step.key)||step.kind==="end"||step.showSummary||!answers[step.key]||answers[step.key]===SHOW_MORE||answers[step.key]==="Show more")continue;seen.add(step.key);lines.push(`${step.label}: ${answers[step.key]}`);}
 return lines;
}
export function botSummary(flow:Flow,answers:Record<string,string>,signedIn:boolean){
 return`${flow.service} enquiry\n${summaryLines(flow,answers,signedIn).join("\n")}`;
}

/**
 * One visitor input, one bot reply.
 * `choiceId` comes from a tapped button; typed text is matched against the same buttons (by label or
 * number, the way WATI accepts "1"), so a visitor who types instead of tapping is not stuck.
 */
export function runBotTurn(previous:BotState,input:{text?:string|null;choiceId?:string|null;signedIn:boolean;
 /** The live cross-sell coupon (lib/ai-sales-offers.ts activeCrossSell); null hides the offer. */
 crossSell?:BotCrossSell}):BotTurnResult{
 const crossSell=input.crossSell===undefined?DEFAULT_CROSS_SELL:input.crossSell;
 const text=String(input.text||"").trim().slice(0,800),state:BotState={...previous,answers:{...previous.answers}};
 const options=state.status==="collecting"?(stepsFor(flowByCode(state.flow)!,input.signedIn)[state.step]?.choices||[]):WEB_CHAT_MENU;
 // Numbers select only the current step's own buttons; "2" typed as an answer must not mean "Start over".
 const picked=matchChoice(options,{text,choiceId:input.choiceId})||matchChoice([START_OVER,ASK_AI,REQUEST_CALL,TALK_TO_TEAM,...(state.status==="done"&&crossSellFor(crossSell,previous.answers)?[GROOMING_OFFER,PAY_LATER]:[])],{text,choiceId:input.choiceId},false);
 const display=picked?.label||text;

 // A greeting in reply to a service template starts that service; otherwise it (re)opens the menu.
 const greetsPreferred=!picked&&Boolean(state.preferredFlow)&&state.status==="menu"&&/^(hi|hello|hey)[.! ]*$/i.test(text);
 if(picked?.id===START_OVER.id||(!picked&&RESTART.test(text)&&!greetsPreferred))return{state:initialBotState(),reply:menuReply(),event:{type:"none"},display};
 /* "Request a call": a signed-in customer gets PawSpace's governed callback (the AI calls them); a visitor
  * leaves a name and number first, as a lead the team calls back. */
 if(picked?.id===REQUEST_CALL.id){
  if(input.signedIn)return{state:{...state,status:"done"},reply:{text:"I'm arranging a call from PawSpace to your registered number now.",choices:[START_OVER],inputHint:"Type a message"},event:{type:"call"},display};
  const steps=stepsFor(TEAM_FLOW,false);
  return{state:{version:BOT_STATE_VERSION,status:"collecting",flow:TEAM_FLOW.code,step:1,answers:{topic:"Requested a call back"}},reply:askReply(steps[1],"Happy to call you. "),event:{type:"none"},display};
 }
 const escalation=picked?.id===TALK_TO_TEAM.id?"customer_requested_human" as const:!picked&&text?HUMAN_PATTERNS.find(([pattern])=>pattern.test(text))?.[1]:undefined;
 if(escalation&&state.flow!==TEAM_FLOW.code){
  // A signed-in customer is handed over at once: the team already knows who they are and replies here.
  if(input.signedIn)return{state:{...state,status:"done"},reply:{text:"I'm bringing in a PawSpace team member. They will reply to you here.",choices:[],inputHint:"Message the PawSpace team"},event:{type:"human",reason:escalation},display};
  const steps=stepsFor(TEAM_FLOW,false),answers:Record<string,string>=!picked&&text?{topic:text}:{};
  const step=answers.topic?1:0;
  return{state:{version:BOT_STATE_VERSION,status:"collecting",flow:TEAM_FLOW.code,step,answers},reply:askReply(steps[step],"I'll connect you with our team. "),event:{type:"none"},display};
 }

 if(state.status!=="collecting"){
  // A question does not forget the service a lead came in for: "Yes" afterwards still starts it.
  const keep:BotState={...initialBotState(),...(state.preferredFlow?{preferredFlow:state.preferredFlow}:{})};
  if(picked?.id===ASK_AI.id)return{state:keep,reply:{text:"Sure - type your question and I'll answer it.",choices:[],inputHint:"Type your question"},event:{type:"none"},display};
  // WATI's cross-sell: "Get Rs 400 off" goes straight into the grooming questions with the offer noted.
  if(picked?.id===GROOMING_OFFER.id){const code=crossSellFor(crossSell,previous.answers)!.code;return startFlow(GROOMING,input.signedIn,{...contactOf(previous.answers),offer:GROOMING_OFFER_NOTE,coupon:code},`Great choice! Your code ${code} is noted. `,display);}
  if(picked?.id===PAY_LATER.id)return{state:keep,reply:menuReply("Explore our other services to find the perfect care for your furry friend! 🐾✨"),event:{type:"none"},display};
  /* A lead who came in for a service: their first short reply ("Yes", "Book now", the template's
   * button) starts that service's questions straight away, as the WATI template flow does. */
  const preferred=!picked&&state.preferredFlow&&(SHORT_YES.test(text)||greetsPreferred||flowFromText(text)?.code===state.preferredFlow)?flowByCode(state.preferredFlow):null;
  const flow=picked?flowByCode(picked.id):preferred||(!picked?flowFromText(text):null);
  if(flow)return startFlow(flow,input.signedIn,{},`Great, let's get your ${flow.service} details. `,display);
  if(!text)return{state:initialBotState(),reply:menuReply(),event:{type:"none"},display};
  // A free question at the menu goes to PawSpace AI; the route answers it and offers the menu again.
  return{state:keep,reply:menuReply("Anything else? Pick a service or ask another question."),event:{type:"ai",question:text},display};
 }

 const flow=flowByCode(state.flow)!,steps=stepsFor(flow,input.signedIn),step=steps[state.step];
 if(!step)return{state:initialBotState(),reply:menuReply(),event:{type:"none"},display};
 const context={flow,answers:state.answers,signedIn:input.signedIn};
 let value:string;
 if(step.kind==="choice"){if(!picked||!step.choices?.some(item=>item.id===picked.id))return{state,reply:askReply(step,"Please pick one of the options. ",context),event:{type:"none"},display};value=picked.value??picked.label;}
 else{const checked=validate(step,text);if("error"in checked)return{state,reply:askReply(step,`${checked.error} `,context),event:{type:"none"},display};value=checked.value;}
 // "No" to "confirm the booking?": the questions start again, as the WATI flow loops back.
 if(step.restartOn&&value===step.restartOn)return startFlow(flow,input.signedIn,{...contactOf(state.answers),...offerOf(state.answers)},"No problem, let's go through the details again. ",display);
 // WATI's "invoke flow": this answer carries on in another flow, with the contact details and the route.
 const invoked=step.invoke?.[value]&&flowByCode(step.invoke[value]);
 if(invoked)return startFlow(invoked,input.signedIn,{...contactOf(state.answers),...offerOf(state.answers),via:`${flow.service} - ${value}`},`${value} trips are arranged by our ${invoked.service.toLowerCase()} team. `,display);
 state.answers[step.key]=value;
 // A step that ends its branch jumps to the visitor's WhatsApp consent (if still to ask), else finishes.
 const consentAt=steps.findIndex(item=>item.key===CONSENT.key);
 state.step=isLast(step,state.answers)?(consentAt>state.step&&!state.answers[CONSENT.key]?consentAt:steps.length):nextStep(steps,state.step+1,state.answers);
 const next=steps[state.step];
 // WATI's "Others" city: an apology, and the flow stops there.
 if(next?.kind==="end")return{state:{...state,status:"done"},reply:{text:typeof next.prompt==="function"?next.prompt(state.answers):next.prompt,choices:[START_OVER],inputHint:"Type a message"},event:{type:"none"},display};
 if(next)return{state,reply:askReply(next,step.key==="name"?`Thanks ${value.split(" ")[0]}! `:"",{...context,answers:state.answers}),event:{type:"none"},display};
 const summary=botSummary(flow,state.answers,input.signedIn),team=flow.code===TEAM_FLOW.code||Boolean(flow.teamFollowUp?.(state.answers));
 /* A signed-in customer's new enquiry goes straight to PawSpace AI to recommend, price and book; a
  * visitor's becomes a lead, and an existing booking or subscription goes to a person - with the WATI
  * flow's own closing message. */
 const closing=input.signedIn&&!team?"Let me check the best option and price for you now.":flow.closing?.(state.answers)||"A PawSpace team member will get in touch with you shortly.";
 const offer=flow.groomingOffer&&!state.answers.offer?crossSellFor(crossSell,state.answers):null;
 return{state:{...state,status:"done"},reply:{text:`Thank you! Here is what I've noted:\n${summary}\n\n${closing}${offer?`\n\n${groomingOfferText(offer.code)}`:""}`,choices:offer?[GROOMING_OFFER,PAY_LATER]:[START_OVER],inputHint:"Type a message"},event:{type:"completed",flow:flow.code,service:flow.service,answers:state.answers,summary,...(team&&flow.code!==TEAM_FLOW.code?{followUp:"team" as const,...(flow.followUpReason?{followUpReason:flow.followUpReason}:{})}:{})},display};
}

function startFlow(flow:Flow,signedIn:boolean,answers:Answers,prefix:string,display:string):BotTurnResult{
 const steps=stepsFor(flow,signedIn),step=nextStep(steps,0,answers);
 return{state:{version:BOT_STATE_VERSION,status:"collecting",flow:flow.code,step,answers:{...answers}},reply:askReply(steps[step],prefix,{flow,answers,signedIn}),event:{type:"none"},display};
}

/** The question the customer is currently on, re-asked (the stalled-chat nudge uses it). */
export function currentStepReply(state:BotState,signedIn:boolean,prefix=""):BotReply|null{
 if(state.status!=="collecting")return null;const flow=flowByCode(state.flow);if(!flow)return null;
 const step=stepsFor(flow,signedIn)[state.step];return step?askReply(step,prefix,{flow,answers:state.answers,signedIn}):null;
}
/** The enquiry so far, for a lead created before the flow is finished. */
export function partialSummary(state:BotState,signedIn:boolean){const flow=flowByCode(state.flow);return flow?botSummary(flow,state.answers,signedIn):"";}
