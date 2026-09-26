import type{AddressSuggestion,ResolvedAddress}from"./address-autocomplete";
import{serviceAddressPincodes}from"./service-address-pincode";
import{validateIndianPincode}from"./pincode-validation";

/** What a Google result may fill on the account address form. Every field stays editable afterwards. */
export type AccountAddressFill={line1:string;postalCode:string};

const withoutCountry=(value:string)=>value.trim().replace(/,\s*India$/i,"").trim();
// Keep a PIN only when it passes the same rule the server applies; otherwise the customer types it.
const checkedPin=(candidate:string|undefined)=>{const result=validateIndianPincode(candidate);return result.ok?result.pincode:"";};

/** Fill from a resolved Google place. The PIN is Google's structured postal code, else the last PIN in the
 *  formatted address (the sandbox fixture's resolve carries it only in the text). It is never inferred from
 *  an area name: a place without a PIN leaves the field empty for the customer to fill. */
export function addressFromResolvedPlace(place:ResolvedAddress,suggestion:AddressSuggestion):AccountAddressFill|null{
 if(place.status!=="configured")return null;
 const line1=withoutCountry(place.address||suggestion.fullText);
 return{line1,postalCode:checkedPin(place.pincode||serviceAddressPincodes(line1).at(-1))};
}

/** Fallback when resolving the chosen suggestion times out or is unavailable: keep the customer's choice,
 *  with a PIN only when the suggestion text itself carries one. */
export function addressFromSuggestionText(suggestion:AddressSuggestion):AccountAddressFill{
 const line1=withoutCountry(suggestion.fullText);
 return{line1,postalCode:checkedPin(serviceAddressPincodes(line1).at(-1))};
}
