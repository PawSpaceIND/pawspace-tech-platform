import{flowByCode,initialBotState,type BotState}from"./web-chat-bot";

/**
 * One approved WhatsApp template per service, as in WATI: a lead who came in for grooming gets the
 * grooming template, and its reply button ("Book grooming") starts the grooming questions in the bot.
 *
 * The wording here is what PawSpace submits for approval. A service template is used only once it is
 * approved in the connected WhatsApp Business Account; until then the generic first-response template
 * goes out, so a lead is never left without a first message.
 */
type Row=Record<string,unknown>;
export type ServiceLeadTemplate={flow:string;templateKey:string;text:string;button:string};
export const WHATSAPP_SERVICE_LEAD_TEMPLATES:ServiceLeadTemplate[]=[
 {flow:"grooming",templateKey:"pawspace_lead_grooming_v1",text:"Hi! Thanks for your interest in PawSpace Grooming. Tap Book grooming and I'll take your pet's details in under a minute.",button:"Book grooming"},
 {flow:"training",templateKey:"pawspace_lead_training_v1",text:"Hi! Thanks for your interest in PawSpace Dog Training. Tap Book training and I'll take your dog's details in under a minute.",button:"Book training"},
 {flow:"boarding",templateKey:"pawspace_lead_boarding_v1",text:"Hi! Thanks for your interest in PawSpace Boarding. Tap Book boarding and I'll take your pet's details in under a minute.",button:"Book boarding"},
 {flow:"pet_sitting",templateKey:"pawspace_lead_pet_sitting_v1",text:"Hi! Thanks for your interest in PawSpace Pet Sitting. Tap Book pet sitting and I'll take your pet's details in under a minute.",button:"Book pet sitting"},
 {flow:"dog_walking",templateKey:"pawspace_lead_dog_walking_v1",text:"Hi! Thanks for your interest in PawSpace Dog Walking. Tap Book dog walking and I'll take your dog's details in under a minute.",button:"Book dog walking"},
 {flow:"pet_taxi",templateKey:"pawspace_lead_pet_taxi_v1",text:"Hi! Thanks for your interest in PawSpace Pet Taxi. Tap Book pet taxi and I'll take your trip details in under a minute.",button:"Book pet taxi"},
 {flow:"fresh_food",templateKey:"pawspace_lead_fresh_food_v1",text:"Hi! Thanks for your interest in PawSpace Fresh Food. Tap Order fresh food and I'll take your pet's details in under a minute.",button:"Order fresh food"},
 {flow:"relocation",templateKey:"pawspace_lead_relocation_v1",text:"Hi! Thanks for your interest in PawSpace Pet Relocation. Tap Plan relocation and I'll take your travel details in under a minute.",button:"Plan relocation"},
];

const SERVICE_WORDS:Array<[string,RegExp]>=[["grooming",/groom/i],["training",/train/i],["boarding",/board/i],["pet_sitting",/sitt/i],["dog_walking",/walk/i],["pet_taxi",/taxi|cab/i],["fresh_food",/food|meal/i],["relocation",/relocat|pet transport|travel/i]];
/** The bot flow for a lead's service ("Dog Grooming", "grooming - Meta ad", "Pet Relocation"), or null. */
export function flowForLeadService(service:unknown){const value=String(service??"");const found=SERVICE_WORDS.filter(([,pattern])=>pattern.test(value));return found.length===1?found[0][0]:null;}

export async function registerServiceLeadTemplates(db:D1Database){
 const now=Date.now();
 await db.batch(WHATSAPP_SERVICE_LEAD_TEMPLATES.map(template=>db.prepare("INSERT OR IGNORE INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?,'pending_approval','utility','en','system',?)").bind(template.templateKey,now)));
}

/** The service template to send for this lead, when it is approved; null means use the generic template. */
export async function approvedServiceLeadTemplate(db:D1Database,service:unknown){
 const flow=flowForLeadService(service);if(!flow)return null;
 const template=WHATSAPP_SERVICE_LEAD_TEMPLATES.find(item=>item.flow===flow)!;
 const row=await db.prepare("SELECT status FROM whatsapp_uat_templates WHERE template_key=?").bind(template.templateKey).first<Row>().catch(()=>null);
 return String(row?.status||"")==="approved"?template:null;
}

/** The bot's starting point for a lead: the menu, with the lead's service ready to start on their reply. */
export function leadBotState(service:unknown):BotState{const flow=flowForLeadService(service);return flow&&flowByCode(flow)?{...initialBotState(),preferredFlow:flow}:initialBotState();}
