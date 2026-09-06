import assert from"node:assert/strict";
import test from"node:test";

import{validateIndianPincode}from"../lib/pincode-validation.ts";

test("service-zone pincode validation rejects missing and malformed input",()=>{
  assert.deepEqual(validateIndianPincode(null),{ok:false,reason:"missing"});
  assert.deepEqual(validateIndianPincode(""),{ok:false,reason:"missing"});
  assert.deepEqual(validateIndianPincode("abc"),{ok:false,reason:"malformed"});
  assert.deepEqual(validateIndianPincode("5600"),{ok:false,reason:"malformed"});
  assert.deepEqual(validateIndianPincode("560102abc"),{ok:false,reason:"malformed"});
  assert.deepEqual(validateIndianPincode("056010"),{ok:false,reason:"malformed"});
});

test("service-zone pincode validation preserves a valid six-digit PIN",()=>{
  assert.deepEqual(validateIndianPincode("560102"),{ok:true,pincode:"560102"});
  assert.deepEqual(validateIndianPincode(" 560102 "),{ok:true,pincode:"560102"});
});
