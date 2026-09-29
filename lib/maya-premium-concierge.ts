export type MayaConciergeService =
 | "grooming" | "dog_training" | "boarding" | "pet_sitting"
 | "dog_walking" | "pet_taxi" | "food" | "funeral_memorial" | "relocation";

export type MayaServiceMode = "bookable" | "specialist" | "enquiry";

export const MAYA_CONCIERGE_SERVICES: Readonly<Record<MayaConciergeService,{
 label:string; mode:MayaServiceMode; aliases:readonly string[]; crossSell:readonly MayaConciergeService[];
}>> = Object.freeze({
 grooming:{label:"Pet Grooming",mode:"bookable",aliases:["grooming","groom","bath","haircut","trim","deshedding","de-shedding","nail clipping"],crossSell:["dog_training","boarding","pet_sitting"]},
 dog_training:{label:"Dog Training",mode:"bookable",aliases:["training","trainer","puppy training","obedience","toilet training","leash training","behaviour training","behavior training"],crossSell:["grooming","dog_walking","boarding"]},
 boarding:{label:"Boarding & Daycare",mode:"bookable",aliases:["boarding","home boarding","daycare","day care","stay","overnight stay"],crossSell:["grooming","pet_taxi"]},
 pet_sitting:{label:"Pet Sitting",mode:"bookable",aliases:["pet sitting","sitting","sitter","home sitting","overnight sitting"],crossSell:["grooming","pet_taxi"]},
 dog_walking:{label:"Dog Walking",mode:"specialist",aliases:["walking","dog walking","walker","walk"],crossSell:["dog_training","grooming"]},
 pet_taxi:{label:"Pet Taxi",mode:"specialist",aliases:["pet taxi","taxi","pickup","pick up","drop","transport"],crossSell:["boarding","grooming"]},
 food:{label:"Fresh Food",mode:"specialist",aliases:["food","fresh food","pet food","dog food","cat food","meals"],crossSell:[]},
 funeral_memorial:{label:"Funeral & Memorial",mode:"specialist",aliases:["funeral","memorial","cremation","cremate","ashes","burial","pet passed","passed away","died","death"],crossSell:[]},
 relocation:{label:"Pet Relocation",mode:"enquiry",aliases:["relocation","relocate","move my pet","international travel","domestic relocation","pet relocation","travel documents"],crossSell:[]},
});

const serviceEntries=Object.entries(MAYA_CONCIERGE_SERVICES) as Array<[MayaConciergeService,(typeof MAYA_CONCIERGE_SERVICES)[MayaConciergeService]]>;

export function detectMayaConciergeService(message:string,history:string[]=[]):MayaConciergeService|null{
 const haystack=[...history.slice(-6),String(message||"")].join(" ").toLowerCase();
 let best:{service:MayaConciergeService;score:number}|null=null;
 for(const [service,definition] of serviceEntries){
  let score=0;
  for(const alias of definition.aliases){
   const needle=alias.toLowerCase();
   if(haystack.includes(needle))score+=Math.max(1,needle.split(/\s+/).length);
   if(String(message||"").toLowerCase().includes(needle))score+=3;
  }
  if(score>0&&(!best||score>best.score))best={service,score};
 }
 return best?.service??null;
}

export function mayaServiceMode(service:MayaConciergeService|null):MayaServiceMode|"unknown"{
 return service?MAYA_CONCIERGE_SERVICES[service].mode:"unknown";
}

export function mayaCrossSellCandidates(service:MayaConciergeService|null){
 if(!service||service==="funeral_memorial"||service==="relocation")return[] as MayaConciergeService[];
 return [...MAYA_CONCIERGE_SERVICES[service].crossSell];
}

export function premiumConciergePrompt(){
 return `You are Maya, PawSpace's premium voice concierge for pet parents in India.

Conversation style:
- Sound warm, natural and continuous. Never dump a catalogue or read every package unless the caller explicitly asks for all options.
- Start by understanding the customer's goal, then recommend the smallest number of relevant options.
- Address the customer by their known first name when available and address pets by their saved names. Say "pet" unless species matters. Never call every pet a dog; PawSpace supports cats too.
- If several saved pets share a name, distinguish them with species, breed, age or another real saved field. Never say a confusing phrase like "Which Maya?".
- Do not repeat fixed fillers such as "Sure, give me a second" on every turn. If a real lookup takes time, one brief acknowledgement is enough, then continue with the result.
- Ask one useful question at a time. Do not ask again for a detail already confirmed in this call.
- For Grooming, first ask what the pet parent wants solved (bath/hygiene, shedding, trimming/styling, matting, skin sensitivity, etc.), then recommend a suitable package from the server-owned catalogue.
- If a pet has a rash, injury, illness, severe skin issue or another safety concern, do not recommend treatment as grooming. Explain the safety limitation and offer a human/vet handoff as appropriate.
- For Training, ask about goals and current behaviour before recommending a programme. Never promise an outcome.
- Funeral/Memorial conversations are empathy-first: no sales language, subscriptions, cross-sell or promotional follow-up. Collect only the minimum details and offer a person promptly.
- Relocation is enquiry-only. Collect requirements and route to the specialist team; never pretend it is an instant booking.
- Walking, Taxi and Food must follow their current governed commercial capability; never override the platform's payment/booking rules.
- After the primary need is successfully resolved, you may mention one genuinely relevant PawSpace service or subscription. Ask permission before explaining more. Never cross-sell during grief, safety, complaint, refund or payment-dispute situations.
- If the customer asks for a callback, confirm the exact requested date/time once and schedule it through the governed callback path. Do not merely promise a callback.
- Before ending a normal successful call, summarize the agreed next step in one short sentence, then ask if the caller needs anything else.
`;
}
