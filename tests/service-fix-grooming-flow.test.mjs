import {preservedServiceLintBytes} from './helpers/combined-local-reviewed-delta.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {reverseServiceFixDelta,serviceFixReviewedFiles} from "./helpers/service-fix-reviewed-delta.mjs";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__SERVICE_FIX_GROOMING_DB__");

// Workbook "Final testing 27th Sep", Grooming rows 1, 3, 4, 5, 6 and the reference flow (package → inclusions and
// exclusions → add-ons → sticky truthful total). Source contracts on the four owned grooming files; the rendered
// behaviour is exercised by tests/service-fix-ui.browser.cjs against a mocked API. No shared file is touched.
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const page=read("app/v2/grooming/page.tsx"),coupon=read("app/v2/grooming/coupon-box.tsx"),css=read("app/v2/grooming/grooming.module.css");
const hash=value=>createHash("sha256").update(value).digest("hex");

test("row 1: serviceability resolves itself from the saved/default address; the manual test widget is gone; identity and PIN validation stay",()=>{
 assert.doesNotMatch(page,/"Check service area"/,"the live service-area test button is removed");
 assert.match(page,/const autoCoverageKey = useRef\(""\)/);
 assert.match(page,/if \(pincode\.length !== 6 \|\| address\.trim\(\)\.length < 8 \|\| coverage \|\| coverageBusy \|\| locationPending \|\| checkoutBusy \|\| autoCoverageKey\.current === key\) return;/,"auto-check needs a house line and a six-digit PIN and runs once per pair");
 assert.match(page,/setTimeout\(\(\) => \{ void verifyCoverage\(\); \}, 350\)/);
 // The identity and validation path is untouched: the same verifier, the same consistency rule, the same server verification at booking.
 assert.match(page,/const result = await resolveV2GroomingCoverage\(pincode\);\n\s+const conflict = serviceAddressConflict\(address, result\.city, result\.pincode\);/);
 assert.match(page,/if \(address\.trim\(\)\.length < 8\) throw new Error\("Add your house, street and area before verifying serviceability\."\);/);
 assert.match(page,/<GroomingVerifiedAddressPicker /);assert.match(page,/<GroomingLocationAssist /);
 assert.match(page,/Check this address again/,"a failed check is retried by the customer, never looped");
 assert.match(page,/address, pincode: coverage\.pincode, cityName: coverage\.city, cityId: coverage\.cityId, zoneId: coverage\.zoneId,/,"checkout still sends the verified coverage");
});

test("row 3: the live check is the truthful Next step; payment review follows only after price and groomers resolve",()=>{
 assert.doesNotMatch(page,/Check live price & groomers/);
 assert.match(page,/"Next · confirm price & groomers"/);
 assert.match(page,/Next confirms the exact live price and an available groomer for this slot, then takes you to payment review\. Nothing is reserved yet\./);
 assert.match(page,/paymentMode === "prepaid" \? "Next · review payment" : "Next · reserve, pay after service"/);
 // The payment step stays gated on a verified quote, coverage, an eligible groomer and the exact window.
 assert.match(page,/disabled=\{!quote \|\| basketTotal === null \|\| !coverage \|\| !\(providerSelection === "auto" \? providers\?\.providers\.length : providers\?\.providers\.some\(item => item\.id === selectedProviderId\)\) \|\| !scheduledStart \|\| !scheduledEnd/);
 assert.match(page,/if \(!quote \|\| !providers\?\.providers\.length\) return;\n\s+document\.getElementById\("v2-grooming-summary"\)\?\.scrollIntoView/);
});

test("row 4: a prominent back control precedes every step and uses the existing step navigation guards",()=>{
 assert.match(page,/<div className=\{styles\.backBar\} aria-label="Previous step">/);
 assert.match(page,/previousStep \? <button type="button" onClick=\{\(\) => navigateToStep\(previousStep\)\}>← Back to \{previousStep\.label\}<\/button> : <Link href="\/v2">← Back to PawSpace<\/Link>/);
 assert.match(page,/const previousStep = GROOMING_STEPS\.find\(step => step\.number === activeStep - 1\)/);
 assert.match(css,/\.page \.backBar button,\.page \.backBar a \{ min-height:44px;/);
});

test("row 5: the special-code box is never pre-filled by the automatically applied offer",()=>{
 assert.match(coupon,/if\(mode==="manual"\)setCode\(normalized\);/);
 assert.doesNotMatch(coupon,/\n\s*setCode\(normalized\);setBusy\(true\)/,"the old unconditional prefill is gone");
 assert.match(coupon,/\{applied&&!code&&<p className=\{offersStyle\.appliedChip\} role="status"><b>\{applied\}<\/b> applied to this booking<\/p>\}/);
 assert.match(coupon,/placeholder="Enter your privately shared code"/);
 // The server still decides every discount; nothing in the box changes the quote path.
 assert.match(coupon,/const result=await quoteGovernedCoupon\(\{ code: normalized, customerId, serviceCode: "grooming"/);
 assert.doesNotMatch(coupon,/GROOM200/);
 // Failure and changed-context paths keep an automatic offer out of the field too, while the reapply block is still reported.
 assert.match(coupon,/if\(intent\.mode==="automatic"\)setStale\(intent\.code\);else setCode\(intent\.code\);setMessage\(`Your previous coupon/);
 assert.match(coupon,/if\(intent\.mode==="automatic"\)setStale\(intent\.code\);else setCode\(intent\.code\);onChange\(0,intent\.code\);\}/);
 assert.match(coupon,/\{\(applied\|\|code\|\|stale\)&&<button type="button" onClick=\{remove\}>Remove coupon<\/button>\}/);
});

test("row 6: a failed zone reload no longer wipes the published subscription plans from the grid",()=>{
 assert.doesNotMatch(page,/subscriptions:\[\]/);
 assert.match(page,/\.catch\(\(\)=>\{\/\* Workbook row 6: a failed zone reload used to wipe the published subscription plans/);
 assert.match(page,/\[\.\.\.\(catalogue\?\.packages \|\| \[\]\),\.\.\.subscriptionPackages\]\.filter\(pkg => pkg\.audience === audience/,"subscriptions share the one package grid on every viewport");
});

test("reference flow: package selection reveals published inclusions and exclusions, selectable add-ons and a sticky truthful total",()=>{
 assert.match(page,/import \{ groomingCommercialPackages \} from "\.\.\/\.\.\/\.\.\/lib\/grooming-commercial-catalogue";/);
 assert.match(page,/groomingCommercialPackages\.find\(item => item\.code === \(selectedPackage\.subscription\?\.servicePackageCode \|\| selectedPackage\.code\)\) \|\| null/);
 assert.match(page,/\{packageTruth\.included\.map\(item => <li key=\{item\}>✓ \{item\}<\/li>\)\}/);assert.match(page,/\{packageTruth\.excluded\.map\(item => <li key=\{item\}>— \{item\}<\/li>\)\}/);
 assert.match(page,/not published in the commercial catalogue; the description above is what PawSpace has confirmed/,"no inclusion list is invented");
 assert.match(page,/<details className=\{styles\.addOnPicker\} open=\{chosenAddOns\.length > 0\}>/);
 assert.match(page,/availableAddOns\.map\(item => <label key=\{item\.label\}><input type="checkbox" checked=\{chosenAddOns\.includes\(item\.label\)\}/);
 assert.match(page,/const addOnTotal = chosenAddOns\.reduce\(\(sum, label\) => sum \+ \(availableAddOns\.find\(item => item\.label === label\)\?\.price \?\? 0\), 0\);/,"add-on prices come from the catalogue helper, unchanged");
 assert.match(page,/<div className=\{styles\.stickyTotal\} role="status" aria-label="Running total">/);
 assert.match(page,/const couponApplied = Boolean\(quote && coupon\.quoteId && !couponChecking && !couponNeedsReapply\(coupon\.code, coupon\.quoteId\)\);/,"net total only for a server-checked coupon on this basket");
 assert.match(page,/money\(couponApplied \? Math\.max\(0, quote\.price \+ addOnTotal - coupon\.discount\) : quote\.price \+ addOnTotal\)/);
 assert.match(page,/\{quote && !couponChecking && couponNeedsReapply\(coupon\.code, coupon\.quoteId\) && <small>Coupon \{coupon\.code\} needs re-applying<\/small>\}/);
 assert.doesNotMatch(page,/1,?349|1,?899|2,?399|1,?599|1,?647/,"no spreadsheet example price is written into the page");
 assert.match(css,/@media\(max-width:1100px\) \{\n\s+\.page \.stickyTotal \{ display:flex; position:sticky; bottom:0;/);
});

test("the pinned handler region of the page is byte-identical to the historical page",()=>{
 const reviewed=preservedServiceLintBytes("app/v2/grooming/page.tsx",page);
 const historical=reverseServiceFixDelta(reviewed,"app/v2/grooming/page.tsx");
 const region=s=>s.slice(s.indexOf("  const invalidateCare ="),s.indexOf("  if (booking || recoveryBookingId)"));
 assert.equal(hash(region(reviewed)),hash(region(historical)));
 assert.ok(serviceFixReviewedFiles.includes("app/v2/grooming/page.tsx"));
});

test("executes the catalogue code the page now reads: every published package has an itemised list, add-on prices are catalogue prices, subscriptions map to a care package",async()=>{
 const {groomingCommercialPackages}=await import("../lib/grooming-commercial-catalogue.ts");
 const {groomingAddOnsForSpecies}=await import("../lib/grooming-add-ons.ts");
 const {subscriptionPackage}=await import("../lib/v2/grooming-subscription-projection.ts");
 const dogBath=groomingCommercialPackages.find(item=>item.code==="dog-bath");
 assert.ok(dogBath&&dogBath.included.length>0&&dogBath.excluded.length>0,"the reference package carries both lists");
 for(const item of groomingCommercialPackages){assert.ok(Array.isArray(item.included)&&Array.isArray(item.excluded),item.code);assert.ok(new Set([...item.included,...item.excluded]).size===item.included.length+item.excluded.length,"no item is both included and excluded: "+item.code);}
 const dogAddOns=groomingAddOnsForSpecies("dog"),catAddOns=groomingAddOnsForSpecies("cat");
 assert.deepEqual(dogAddOns.map(a=>a.label),["Tick & flea treatment","Full-body oil massage"]);assert.deepEqual(catAddOns.map(a=>a.label),["Full-body oil massage"]);
 for(const addOn of [...dogAddOns,...catAddOns])assert.ok(Number.isFinite(addOn.price)&&addOn.price>0&&Number.isInteger(addOn.price*100),"catalogue add-on price: "+addOn.label);
 // A fictional plan projected over the dog-bath care package resolves to that package's code for the inclusion lookup the page performs.
 const care={code:"dog-bath",name:"Essential Bath",description:"",audience:"dog",bundles:[{petCount:1,packageCode:"dog-bath-1",price:1234,currency:"INR",slotMinutes:60,blockingMinutes:90,effectiveFrom:"2026-01-01",effectiveTo:null}]};
 const plan={code:"plan-fixture",name:"Fixture plan",price:4321,currency:"INR",sessions:4,validityValue:3,validityUnit:"months",eligiblePetTypes:["dog"],servicePackageCode:"dog-bath",maxPetsPerBooking:1,creditsPerPet:1,familyWallet:false,effectiveFrom:"2026-01-01",effectiveTo:null,version:1};
 const projected=subscriptionPackage(plan,care,"dog");
 assert.ok(projected&&projected.subscription?.servicePackageCode==="dog-bath");
 assert.equal(groomingCommercialPackages.find(item=>item.code===(projected.subscription?.servicePackageCode||projected.code))?.code,"dog-bath");
});
