export type PincodeValidationResult=
  |{ok:true;pincode:string}
  |{ok:false;reason:"missing"|"malformed"};

/**
 * Validate a customer-supplied Indian PIN code at the API boundary.
 *
 * Keep this strict: do not strip letters/punctuation or truncate longer input,
 * because doing so can silently turn garbage into a different, serviceable PIN.
 */
export function validateIndianPincode(value:string|null|undefined):PincodeValidationResult{
  if(value==null||value.trim()==="")return{ok:false,reason:"missing"};
  const pincode=value.trim();
  if(!/^[1-9][0-9]{5}$/.test(pincode))return{ok:false,reason:"malformed"};
  return{ok:true,pincode};
}
