import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {serviceAddressPincodes} from "../lib/service-address-pincode.ts";
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const shell=read("app/mobile-app/page.tsx"),gate=read("app/mobile-app/booking-entry-gate.tsx"),address=read("app/mobile-app/address-picker.tsx");

test("all customer services use one guest-first booking entry instead of early per-service OTP gates",()=>{
 assert.match(shell,/!customer\?<GuestBookingPreview service=\{service\}/);
 assert.match(shell,/bookingDetailsRequired\?<BookingEntryDetails/);
 assert.match(shell,/onLoggedIn=\{logged=>\{onLoggedIn\(logged\);setBookingDetailsRequired\(true\);\}\}/);
 assert.match(shell,/const open=.*setBookingDetailsRequired\(false\)/);
 assert.doesNotMatch(shell,/customer\|\|service\.name==="Grooming"/);
 for(const code of ["grooming","dog_training","boarding","pet_sitting","pet_taxi","dog_walking","food","relocation"]) assert.match(shell,new RegExp(`serviceCode:\"${code}\"`));
});

test("guest discovery defers OTP until the customer chooses to continue booking",()=>{
 assert.match(gate,/Browse the service before signing in/);
 assert.match(gate,/No OTP is required to browse/);
 assert.match(gate,/Continue to booking/);
 assert.match(gate,/\{ready&&[\s\S]*<CustomerLogin embedded onLoggedIn=\{onLoggedIn\}/);
});

test("post-OTP details keep primary phone verified and make name alternate phone and address reviewable",()=>{
 assert.match(gate,/Name \*/);
 assert.match(gate,/Verified mobile/);
 assert.match(gate,/value=\{customer\.phone\} disabled/);
 assert.match(gate,/different primary number, verify that number with OTP first/);
 assert.match(gate,/Alternate mobile/);
 assert.match(gate,/updateV2CustomerProfile/);
 assert.match(gate,/upsertV2CustomerAddress/);
 assert.match(gate,/AddressPicker initialAddress=\{initialAddress\} autoLocate/);
});

test("shared address picker supports automatic current-location reverse geocoding and editable fallback",()=>{
 assert.match(address,/autoLocate=false/);
 assert.match(address,/navigator\.geolocation\.getCurrentPosition/);
 assert.match(address,/mode:"reverse"/);
 assert.match(address,/Use current location/);
 assert.match(address,/Enter the street and area/);
 assert.match(address,/onChange=\{e=>invalidate\(e\.target\.value\)\}/);
});


test("executed address helper backs the booking-entry contract",()=>{assert.deepEqual(serviceAddressPincodes("18th Main, Bengaluru 560068"),["560068"]);});
