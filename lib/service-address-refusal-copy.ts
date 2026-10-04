/**
 * Customer copy for a governed service-address refusal, shared by the scheduling route (which chooses the
 * code and reason) and the browser scheduling client (which shows the sentence). Pure data: no runtime
 * imports, so the browser bundle and the Worker read the same words.
 *
 * Two kinds of refusal are kept apart on purpose. A customer-correctable one (code SERVICE_ADDRESS_UNVERIFIED
 * or SERVICE_ADDRESS_NOT_COVERED) asks the customer to correct or select an address. A verification failure
 * (SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE: geocoder, configuration, provider, or map data that does not agree)
 * is neutral: it neither asserts that the PIN or address is wrong nor assures that it is right, because a
 * ZERO_RESULTS or mismatching geocoder answer cannot prove either. None of the sentences carries a provider message, a Maps URL,
 * a credential, a saved address or another customer's identity.
 */
export type ServiceAddressRefusalCode="SERVICE_ADDRESS_REQUIRED"|"SERVICE_ADDRESS_UNVERIFIED"|"SERVICE_ADDRESS_NOT_COVERED"|"SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE";
export type ServiceAddressRefusalReason="address_missing"|"pin_invalid"|"address_incomplete"|"saved_pin_invalid"|"address_pin_mismatch"|"identity_conflict"|"not_covered"|"verification_unavailable"|"verification_retry"|"address_changed"|"unknown";
const FIX=" Check the address and PIN, then try again.";
export const SERVICE_ADDRESS_REASON_COPY:Record<ServiceAddressRefusalReason,string>={
  address_missing:"Save and verify your complete service address before booking.",
  pin_invalid:"Enter a valid 6-digit PIN code for your service address."+FIX,
  address_incomplete:"Enter your complete service address (house or flat, street and area)."+FIX,
  saved_pin_invalid:"Your saved address has an invalid PIN code. Correct it in My PawSpace or choose another saved address."+FIX,
  address_pin_mismatch:"The address and PIN code do not belong together."+FIX,
  identity_conflict:"This address does not match one of your saved addresses. Select a saved address and try again.",
  not_covered:"PawSpace does not serve this address yet. Choose an address in a serviced area or contact PawSpace support.",
  verification_unavailable:"We could not verify this address right now. Try again in a moment, choose another saved address, or contact PawSpace support; nothing has been booked.",
  address_changed:"Your saved address changed while we were verifying it. Check the address shown and try again; nothing has been booked.",
  verification_retry:"Your address verification was refreshed while you were booking. Try again; nothing has been booked.",
  unknown:"Your service address could not be verified."+FIX,
};
/** The sentence for a code alone, when a response carries no recognised reason. */
export const SERVICE_ADDRESS_CODE_COPY:Record<ServiceAddressRefusalCode,string>={
  SERVICE_ADDRESS_REQUIRED:SERVICE_ADDRESS_REASON_COPY.address_missing,
  SERVICE_ADDRESS_UNVERIFIED:SERVICE_ADDRESS_REASON_COPY.unknown,
  SERVICE_ADDRESS_NOT_COVERED:SERVICE_ADDRESS_REASON_COPY.not_covered,
  SERVICE_ADDRESS_VERIFICATION_UNAVAILABLE:SERVICE_ADDRESS_REASON_COPY.verification_unavailable,
};
export function isServiceAddressRefusalCode(code:unknown):code is ServiceAddressRefusalCode{return typeof code==="string"&&Object.prototype.hasOwnProperty.call(SERVICE_ADDRESS_CODE_COPY,code);}
/** Reason copy when the reason is one we know; otherwise the code's own sentence; otherwise null. */
export function serviceAddressRefusalCopy(code:unknown,reason?:unknown):string|null{
  if(!isServiceAddressRefusalCode(code))return null;
  if(typeof reason==="string"&&Object.prototype.hasOwnProperty.call(SERVICE_ADDRESS_REASON_COPY,reason))return SERVICE_ADDRESS_REASON_COPY[reason as ServiceAddressRefusalReason];
  return SERVICE_ADDRESS_CODE_COPY[code];
}
