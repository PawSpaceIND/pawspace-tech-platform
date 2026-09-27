/**
 * THE default SAC per service (owner decision F, 27 Sept 2026): codes and official descriptions from CBIC's Scheme of
 * Classification of Services (Annexure to Notification 11/2017-Central Tax (Rate)) and the GST Council's Explanatory Notes, as
 * summarised in the round-3 GST research. One editable default per service, kept only here:
 *   - the customer tax invoice (lib/booking-tax-invoice.ts) seeds a missing tax_classifications row of the active tax policy
 *     from this table, and never overwrites a row Finance set;
 *   - the returns' HSN/SAC summary (lib/service-output-tax.ts supplySac) falls back to it for a supply with no invoice.
 * Finance changes a service's SAC on the GST screen (finance.manage, audited). The 6-digit code is printed on the invoice with
 * the description below; never a 99972 beauty code.
 *
 * placeOfSupplyRule is the existing lib/tax-pos-resolver.ts rule seeded with the row (IGST Act s.12): where performed for pet
 * grooming and vet visits (s.12(4)) and events (s.12(7)); training (s.12(5)); transport of goods, where the pet is handed over
 * (s.12(8)); the general rule (s.12(2)) otherwise. Whether funeral / memorial is taxed is not a SAC question: it follows the
 * Finance setting in lib/funeral-gst-treatment.ts (Schedule III by default). `note` carries the open question for the CA.
 * Pure: no database and no runtime imports, so the register, the invoice and the screens share it.
 */
export type ServiceSacDefault={readonly sac:string;readonly description:string;readonly placeOfSupplyRule:string;readonly note:string};
/** The service code PawSpace's own fee is classified under on a commission booking. */
export const PLATFORM_COMMISSION_SERVICE_CODE="platform_commission";
const ANIMAL_HUSBANDRY="Animal husbandry services";
export const SERVICE_SAC_DEFAULTS:Readonly<Record<string,ServiceSacDefault>>=Object.freeze({
 grooming:{sac:"998612",description:ANIMAL_HUSBANDRY,placeOfSupplyRule:"service_location",note:"Explanatory Notes: grooming services for pets. 18% by the owner; whether a nil entry applies is a CA question."},
 boarding:{sac:"998612",description:ANIMAL_HUSBANDRY,placeOfSupplyRule:"default_recipient_or_service",note:"Explanatory Notes: accommodation services for pets (kennels); not hotel accommodation."},
 day_care:{sac:"998612",description:ANIMAL_HUSBANDRY,placeOfSupplyRule:"default_recipient_or_service",note:"Explanatory Notes: accommodation services for pets (kennels)."},
 dog_training:{sac:"998612",description:ANIMAL_HUSBANDRY,placeOfSupplyRule:"training_performance",note:"Explanatory Notes: training of pet animals."},
 pet_sitting:{sac:"998612",description:ANIMAL_HUSBANDRY,placeOfSupplyRule:"default_recipient_or_service",note:"Nearest official grouping (alternative 999799); CA to confirm."},
 dog_walking:{sac:"998612",description:ANIMAL_HUSBANDRY,placeOfSupplyRule:"default_recipient_or_service",note:"Nearest official grouping (alternative 999799); CA to confirm."},
 pet_taxi:{sac:"996511",description:"Road transport services of goods including live animals",placeOfSupplyRule:"transport",note:"18% by the owner; possible exemption as non-GTA road transport of goods is a CA question."},
 funeral_memorial:{sac:"999731",description:"Cemeteries and cremation services",placeOfSupplyRule:"default_recipient_or_service",note:"Taxed or not by the funeral GST treatment setting (Schedule III by default)."},
 funeral:{sac:"999731",description:"Cemeteries and cremation services",placeOfSupplyRule:"default_recipient_or_service",note:"Taxed or not by the funeral GST treatment setting (Schedule III by default)."},
 cremation:{sac:"999731",description:"Cemeteries and cremation services",placeOfSupplyRule:"default_recipient_or_service",note:"Taxed or not by the funeral GST treatment setting (Schedule III by default)."},
 vet_consult:{sac:"998351",description:"Veterinary services for pet animals",placeOfSupplyRule:"service_location",note:"Nil only when supplied by a veterinary clinic; otherwise 18%."},
 events:{sac:"998596",description:"Events, exhibitions, conventions and trade shows organisation and assistance services",placeOfSupplyRule:"service_location",note:"Place of supply where the event is held."},
 [PLATFORM_COMMISSION_SERVICE_CODE]:{sac:"998599",description:"Other support services n.e.c.",placeOfSupplyRule:"default_recipient_or_service",note:"PawSpace's platform and service fee (operator commission, 18%)."},
});
export function serviceSacDefault(serviceCode:string):ServiceSacDefault|null{return Object.prototype.hasOwnProperty.call(SERVICE_SAC_DEFAULTS,serviceCode)?SERVICE_SAC_DEFAULTS[serviceCode]:null;}
/** A stored classification code as digits: "SAC998612", "9986 12" and "998612" are the same code. */
export function normaliseSac(value:unknown){return String(value??"").trim().replace(/^sac/i,"").replace(/[\s./-]/g,"");}
/** A SAC is chapter 99: a 4-digit heading or a 6-digit service code. Anything else cannot be printed on a tax invoice. */
export function isValidSac(value:unknown){return/^99\d{2}(\d{2})?$/.test(normaliseSac(value));}
/** The official description of a SAC the table knows, for the invoice and the HSN/SAC summary ("" when it is not in the table). */
export function sacDescription(value:unknown){const sac=normaliseSac(value);return Object.values(SERVICE_SAC_DEFAULTS).find(entry=>entry.sac===sac)?.description??"";}

/** GST state codes (the first two characters of a GSTIN) and their names, for place of supply and customer state. */
export const GST_STATE_NAMES:Readonly<Record<string,string>>=Object.freeze({
 "01":"Jammu and Kashmir","02":"Himachal Pradesh","03":"Punjab","04":"Chandigarh","05":"Uttarakhand","06":"Haryana","07":"Delhi","08":"Rajasthan","09":"Uttar Pradesh","10":"Bihar",
 "11":"Sikkim","12":"Arunachal Pradesh","13":"Nagaland","14":"Manipur","15":"Mizoram","16":"Tripura","17":"Meghalaya","18":"Assam","19":"West Bengal","20":"Jharkhand",
 "21":"Odisha","22":"Chhattisgarh","23":"Madhya Pradesh","24":"Gujarat","26":"Dadra and Nagar Haveli and Daman and Diu","27":"Maharashtra","29":"Karnataka","30":"Goa",
 "31":"Lakshadweep","32":"Kerala","33":"Tamil Nadu","34":"Puducherry","35":"Andaman and Nicobar Islands","36":"Telangana","37":"Andhra Pradesh","38":"Ladakh","97":"Other Territory",
});
export function gstStateName(code:unknown){const key=String(code??"").trim().slice(0,2);return GST_STATE_NAMES[key]??"";}
