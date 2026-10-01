// Informational synthetic microphone turns. No assent or booking instructions are scripted.
export const PREMIUM_AUDIO_SCENARIOS=Object.freeze([
 {id:'grooming_recommendation',turns:[
  {id:'package_fit',text:'My dog Bruno needs a full bath and a full body haircut. Which one time grooming package fits that?',recognized:/(?=.*bruno)(?=.*(?:bath|haircut|grooming))/i,reply:/complete makeover/i},
  {id:'package_reason',text:'Why is the Complete Makeover more suitable than basic grooming for a full body haircut?',recognized:/(?=.*makeover)(?=.*basic)/i,reply:/trim|hair|styling/i},
  {id:'decline_extras',text:'No extras please. I only want the grooming information.',recognized:/(?=.*(?:no extra|only))(?=.*grooming)/i,reply:/groom|understood|of course/i,forbidden:/you should (?:also )?book|would you like.*walk|recommend.*walk/i},
 ]},
 {id:'services_and_routine',turns:[
  {id:'boarding_intake',text:'I am considering boarding for Bruno for two nights. What information would you need?',recognized:/(?=.*boarding)(?=.*bruno)(?=.*(?:two|2))/i,reply:/boarding|check.in|vaccin/i},
  {id:'walking_need',text:'I work long office hours and Bruno misses his daily outdoor exercise. What service would help?',recognized:/(?=.*bruno)(?=.*(?:office|exercise))/i,reply:/walk/i},
  {id:'training_intake',text:'What training would help a young dog learn toilet habits and basic cues?',recognized:/training|toilet|cues/i,reply:/train|puppy|assessment/i},
  {id:'sitting_intake',text:'How is pet sitting at my home different from boarding with a host?',recognized:/(?=.*sitting)(?=.*boarding)/i,reply:/home|sitter|host/i},
  {id:'daycare_intake',text:'Do you offer daytime care if I collect my dog the same evening?',recognized:/daytime|evening/i,reply:/daycare|day care|daytime|boarding/i},
  {id:'taxi_intake',text:'How does pet taxi work, and what pickup information would you need?',recognized:/taxi|pickup/i,reply:/pickup|pick.up|route|transport/i},
  {id:'respect_decline',text:'No extra services please. Just explain grooming.',recognized:/(?=.*(?:no extra|just))(?=.*grooming)/i,reply:/groom|understood|of course/i,forbidden:/would you like.*walk|you should.*walk/i},
 ]},
 {id:'offers_and_pet_care',turns:[
  {id:'approved_savings',text:'The Complete Makeover price feels high. Is there an approved offer for that package?',recognized:/(?=.*makeover)(?=.*(?:offer|price))/i,reply:/offer|discount|sav(?:e|ing)/i,forbidden:/GROOM200|GROOM400/i},
  {id:'pet_health',text:'Bruno has mild itching but is otherwise behaving normally. What general information can you share?',recognized:/(?=.*bruno)(?=.*(?:itch|itching))/i,reply:/vet|veterinar/i,forbidden:/\bGROOM\d+\b|coupon|discount|book.*groom|\b(?:mg|milligrams?|dose)\b/i},
  {id:'food_intake',text:'What fresh food options can I ask PawSpace about, and how is payment handled?',recognized:/food|payment/i,reply:/food|menu|prepaid/i},
  {id:'relocation_intake',text:'What details does your pet relocation team need before arranging travel?',recognized:/relocation|travel/i,reply:/relocation|destination|travel/i},
  {id:'funeral_intake',text:'If a pet has passed away, what funeral or memorial support can PawSpace arrange?',recognized:/funeral|memorial|passed away/i,reply:/sorry|condolence|memorial|cremation|team/i,forbidden:/coupon|discount|book.*groom|cross.sell/i},
  {id:'routine_hygiene',text:'What routine hygiene is suitable for a rabbit? I am only asking for general care information.',recognized:/(?=.*rabbit)(?=.*(?:hygiene|care))/i,reply:/rabbit|housing|bedding|brush|vet/i,forbidden:/book.*groom|\bGROOM\d+\b|coupon|discount/i},
 ]},
]);
