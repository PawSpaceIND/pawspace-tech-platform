type Row=Record<string,unknown>;
export type ConsultationMessage={role:string;content:string};
type Service='grooming'|'dog_training'|'pet_taxi'|'boarding'|'pet_sitting'|'funeral'|'dog_walking';
const patterns:Record<Service,RegExp>={grooming:/\b(?:grooming|haircut|hygiene|trim)\b/i,dog_training:/\b(?:training|puppy skills)\b/i,pet_taxi:/\b(?:taxi|cab|pet transport)\b/i,boarding:/\b(?:boarding|daycare)\b/i,pet_sitting:/\b(?:sitting|sitter)\b/i,funeral:/\b(?:funeral|cremation|passed away|died)\b/i,dog_walking:/\b(?:walking|walker)\b/i};
const goals:Record<Service,RegExp>={grooming:/\b(?:hygiene|haircut|trim|bath|nails?|shedding|matting)\b/gi,dog_training:/\b(?:jumping|biting|pulling|recall|toilet|potty|barking|separation|obedience|socialisation|socialization)\b/gi,pet_taxi:/\b(?:airport|vet|relocation|regular|one way|round trip)\b/gi,boarding:/\b(?:medication|no resident pets|one family only)\b/gi,pet_sitting:/\b(?:medication|overnight|feeding|company)\b/gi,funeral:/\b(?:cremation|burial|ashes|memorial)\b/gi,dog_walking:/\b(?:exercise|toilet|regular|daily)\b/gi};
const groups:Record<Service,string>={grooming:'grooming',dog_training:'dogTraining',pet_taxi:'petTaxi',boarding:'boarding',pet_sitting:'petSitting',funeral:'funeral',dog_walking:'dogWalking'};
const row=(value:unknown):Row=>value&&typeof value==='object'?value as Row:{};
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
/** A read-only consultation plan. Facts are attributed dialogue, never executable identity/consent. */
export function buildCustomerConsultation(input:{history:ConsultationMessage[];currentText:string;context:Row;service?:string;channel:string}){
 const turns=[...input.history,{role:'user',content:input.currentText}];
 const pets=Array.isArray(input.context.pets)?input.context.pets.map(row):[];
 let pet:Row|null=pets.length===1?pets[0]:null;
 let service:Service|null=input.service&&input.service!=='all_services'&&Object.hasOwn(patterns,input.service)?input.service as Service:null;
 const needs:Partial<Record<Service,string[]>>={},constraints:Record<string,{text:string;turn:number}>={};
 for(let i=0;i<turns.length;i++){
  const message=turns[i];if(message.role!=='user')continue;
  const value=message.content;
  const named=pets.filter(item=>text(item.name)&&new RegExp(`\\b${text(item.name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'i').test(value));
  if(named.length){const next=named.length===1?named[0]:null;if(next?.id!==pet?.id)delete constraints.age;pet=next;}
  if(/\b(?:new pet|new puppy|another pet|different pet)\b/i.test(value)){pet=null;delete constraints.age;}
  const matches=(Object.keys(patterns) as Service[]).filter(key=>patterns[key].test(value));
  // A comparison cannot silently replace the active service. A clear single-service turn can.
  if(matches.length===1&&!/\b(?:no|not|don't want|don’t want)\s+(?:(?:any|a|an)\s+)?(?:training|grooming|taxi|cab|boarding|daycare|sitting|sitter|walking|walker|funeral|cremation)\b/i.test(value))service=matches[0];
  if(service){
   const mentioned=[...value.matchAll(goals[service])].map(match=>match[0].toLowerCase());
   const denied=mentioned.filter(goal=>new RegExp(`(?:no|not|don't want|don’t want)\\s+(?:a\\s+)?${goal}`,'i').test(value));
   const prior=(needs[service]??[]).filter(goal=>!denied.includes(goal));
   const found=mentioned.filter(goal=>!denied.includes(goal));
   needs[service]=/\b(?:instead|only|rather)\b/i.test(value)?[...new Set(found)]:[...new Set([...prior,...found])];
  }
  for(const [key,pattern] of Object.entries({budget:/\b(?:budget|afford|expensive|cheaper|costly)\b/i,time:/\b(?:busy|time|minutes|hours|weekends?|weekday|schedule)\b/i,trust:/\b(?:trust|reviews?|reliable|safe|safety|credentials?)\b/i,results:/\b(?:results?|guarantee|will it work|progress)\b/i,age:/\b\d{1,2}\s*(?:months?|years?)\s*old\b/i}))if(pattern.test(value))constraints[key]={text:value,turn:i};
 }
 const knownAge=Boolean(constraints.age||pet&&[pet.age_months,pet.age_years,pet.age].some(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0)||pet&&(pet.date_of_birth||pet.dob));
 const questionList:string[]=[];
 if(service==='dog_training'){
  if(!(needs[service]?.length))questionList.push('What would you most like to improve—such as jumping, toilet habits, or lead pulling?');
  if(!knownAge)questionList.push('How old is your pet?');
 }else if(service==='grooming'&&!(needs[service]?.length))questionList.push('What grooming result matters most: coat care, hygiene, or a haircut?');
 else if(service==='pet_taxi'){
  const taxiTurns=turns.filter(item=>item.role==='user').map(item=>item.content).join(' ');
  if(!/\b(?:pickup|pick up|origin)\b/i.test(taxiTurns)||!/\b(?:drop|destination)\b/i.test(taxiTurns))questionList.push('What are the pickup and drop-off addresses?');
  if(!/\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[:.]\d{2}|\d{1,2}\s*(?:am|pm))\b/i.test(taxiTurns))questionList.push('When do you need the ride?');
 }
 const current=input.currentText;
 const phase=/\b(?:human|speak to someone|complaint|manager)\b/i.test(current)?'handoff':/\b(?:cancel|refund|upgrade|discount|coupon)\b/i.test(current)?'policy':/\b(?:expensive|afford|costly|trust|reliable|guarantee|will it work)\b/i.test(current)?'objection':/\b(?:prices?|costs?|fees?|rates?|charges?|fare|how much|payment amount|total amount|total spend)\b|\bwhat\b.{0,35}\b(?:pay|spend)\b/i.test(current)?'price':/\b(?:compare|difference|better|best|recommend|suggest)\b/i.test(current)?questionList.length?'discover':'compare':'continue';
 const catalogue=row(input.context.catalogue),raw=service?catalogue[groups[service]]:[];
 // Stay catalogue prices are never caregiver rates; Taxi requires a live route quote.
 const options=Array.isArray(raw)&&service&&!['boarding','pet_sitting','pet_taxi'].includes(service)?raw.map(value=>{const item=row(value);const amount=typeof item.base_price==='number'&&Number.isFinite(item.base_price)?item.base_price:null;const sessions=Number.isInteger(item.sessions)&&Number(item.sessions)>0?Number(item.sessions):null;return{code:text(item.package_code),name:text(item.name),verifiedDescription:text(item.description),totalBasePrice:amount,currency:text(item.currency)||null,taxInclusive:typeof item.tax_inclusive==='boolean'?item.tax_inclusive:item.tax_inclusive===1?true:item.tax_inclusive===0?false:null,sessions,perSessionBasePrice:amount!==null&&sessions?amount/sessions:null,validityDays:item.validity_days??null};}):[];
 return{service,phase,needs:service?needs[service]??[]:[],constraints,knownAge,questions:questionList.slice(0,2),comparisonOptions:options,subscriptionComparison:service==='grooming'?{source:'existing_scoped_grooming_subscription_catalogue',requiresVerifiedLocationSpeciesCreditsValidityAndTerms:true}:null,maximumQuestions:2,bookingConsent:false,identityVerified:false,priceAuthority:'existing_server_catalogue_or_quote',nextStep:service==='boarding'||service==='pet_sitting'?'verified_caregiver_information_then_app':service==='funeral'?'bereavement_support_then_existing_specialist_path':'governed_unconfirmed_quote_then_separate_confirmation'};
}
export function consultationDiscoveryReply(plan:ReturnType<typeof buildCustomerConsultation>,currentText:string){
 // Only explicit recommendation requests receive deterministic discovery; price and policy answers stay first.
 if(plan.phase!=='discover'||!plan.questions.length||/[^\x00-\x7f]/.test(currentText))return null;
 if(plan.service!=='dog_training'&&plan.service!=='grooming')return null;
 return plan.questions.join(' ');
}
export const CUSTOMER_CONSULTATION_DIRECTIVE=`Use customerConsultation as a read-only plan, not booking or price authority. Reuse CRM and customer-stated needs, ask only the next one or two missing relevant questions, and explain why the chosen option fits. Compare good/better/best only where approved options support distinct benefits: state the baseline fit and exactly which verified extra inclusion makes a higher package useful for this customer's stated goal. A higher price is not evidence it is better for the pet. Do not force an upsell or choose Starter/cheapest by default. Compare one-time and subscription total cost, included sessions/credits, per-session value, validity, consumption and binding terms only when verified; arithmetic on a base price is not a tax-inclusive quote or guaranteed saving. Answer direct price questions first. Handle price objections with verified value and suitable alternatives; trust objections with approved process/credentials only; time objections with verified duration/availability; results objections with realistic approved expectations, never medical claims or guaranteed outcomes. Ask permission for one relevant cross-sell tied to a stated unmet need; a refusal ends it, and every additional service needs its own quote and consent. Do not cross-sell during a complaint, bereavement, dispute or quote confirmation. Acknowledge complaints calmly, identify the specific issue once and use the existing human-handoff path when requested or required. Describe a handoff as queued only after the actual handoff record exists; never claim a connected person or live transfer without receipt. For operational outcomes, speak only from confirmed execution receipts: CRM/profile or lead updates, quote and booking IDs, policy-selected assignment, ticket/refund-request status, and agreed follow-up records. A proposal is not an update; a refund request is not approval or money transfer; an outbox row is not notification delivery; an unavailable future callback is not scheduled. If only part of a tool chain completed, identify the confirmed partial state and say review is pending without replaying an unverified action or claiming rollback. Close with one clear permitted next step. No fabricated urgency, discount, refund, upgrade, slot or booking success. Voice stays warm and concise; required quote and safety terms take priority over brevity.`;
