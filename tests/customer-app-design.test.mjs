import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Customer app design: splash + two review-able home screens + one service-page
// anatomy across all eight flows. These are structural guarantees a screenshot
// review cannot give you: that the designs share real data, that the location
// shown is never invented, and that every service page gets the same hero.
// ---------------------------------------------------------------------------
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("app/mobile-app/page.tsx");
const splash = read("app/mobile-app/splash.tsx");
const designs = read("app/mobile-app/home-designs.tsx");
const hero = read("app/mobile-app/service-hero.tsx");
const heroCss = read("app/mobile-app/service-hero.module.css");
const designCss = read("app/mobile-app/home-designs.module.css");
const splashCss = read("app/mobile-app/splash.module.css");

const SERVICES = ["Grooming", "Training", "Boarding", "Pet Sitting", "Dog Walking", "Pet Taxi", "Fresh Food", "Relocation"];

test("the splash shows the brand, a dog and a cat, then hands over to the app", () => {
  assert.match(splash, /assets\/pawspace-logo\.jpeg/, "the real PawSpace mark, not a re-drawn one");
  // Dog AND cat, as asked - two real photographs rather than one faked composite.
  assert.match(splash, /sitter-hug-golden\.jpg/);
  assert.match(splash, /sitting-woman-cat\.jpg/);
  for (const asset of ["public/assets/pawspace-logo.jpeg", "public/assets/banners/sitter-hug-golden.jpg", "public/assets/banners/sitting-woman-cat.jpg"]) {
    assert.ok(fs.existsSync(new URL(`../${asset}`, import.meta.url)), `${asset} must exist or the splash renders a broken image`);
  }
  // It must never trap the customer: an explicit continue/skip and a bounded geolocation timeout.
  assert.match(splash, /GEO_TIMEOUT_MS\s*=\s*12_000/);
  assert.match(splash, /className=\{styles\.skip\}/);
  assert.match(page, /if\(!splashDone\)return/, "the splash gates the app shell on launch");
  assert.match(page, /onDone=\{captured=>/, "and hands the captured location back to the shell");
});

test("the splash never invents a location it did not get", () => {
  // Reverse geocoding is provider-gated. When it is not configured the screen shows the real
  // coordinates and asks for the address at booking - it must not print a plausible street.
  assert.match(splash, /source: "geocoded"/);
  assert.match(splash, /source: "coordinates_only"/);
  assert.match(splash, /resolved\.status === "configured"/, "an address is only shown when the geocoder really returned one");
  assert.match(splash, /latitude\.toFixed\(4\)/, "otherwise the honest reading is the coordinates");
  // A refusal is a normal path, not an error the customer has to clear.
  assert.match(splash, /source: "declined"/);
  assert.match(splash, /PERMISSION_DENIED/);
  assert.match(splash, /No problem/);
  assert.doesNotMatch(splash, /Koramangala|Indiranagar|HSR|1st Main/, "no hard-coded fake address anywhere in the splash");
});

test("both home designs exist, are selectable, and are remembered per device", () => {
  assert.match(designs, /export type HomeDesignId = "premium" \| "calm"/);
  assert.match(designs, /Option 5 · Premium &amp; Visual/);
  assert.match(designs, /Option 1 · Clean &amp; Calm/);
  // Selectable three ways: a deep link for review, a stored choice, and a control in the app.
  assert.match(page, /params\.get\("home"\)/, "?home=premium|calm opens a design directly for review");
  assert.match(page, /HOME_DESIGN_STORAGE_KEY/);
  assert.match(page, /<HomeDesignSwitcher/, "the founder can flip designs inside the app");
  // Each skin defines its own full palette rather than inheriting half of the other's.
  for (const skin of [".premium", ".calm"]) {
    const block = designCss.slice(designCss.indexOf(skin), designCss.indexOf(skin) + 460);
    for (const token of ["--ground", "--panel", "--ink", "--ink-soft", "--line", "--cta-bg", "--cta-ink"]) {
      assert.ok(block.includes(token), `${skin} must define ${token}`);
    }
  }
});

test("the two designs differ only in presentation - same data, same flows", () => {
  // One component renders both, so neither can drift into showing different business facts.
  assert.equal((designs.match(/export default function HomeDesign/g) || []).length, 1);
  for (const shared of ["offers", "nextBooking", "disabledServices", "campaigns"]) {
    assert.ok(designs.includes(shared), `both designs must render real ${shared}`);
  }
  // Availability is honoured identically: a paused service cannot be booked from either design.
  assert.match(designs, /disabled=\{off\}/);
  assert.match(designs, /Currently paused/);
  assert.match(designs, /Paused/);
  // The design layer hands a service back and the shell resolves it - no duplicated routing table.
  assert.match(page, /services\.find\(item=>item\.serviceCode===picked\.serviceCode\)/);
});

test("promoted content stays labelled in both designs", () => {
  assert.match(designs, /PawSpace Media slot/);
  assert.match(designs, /clearly labelled approved campaigns/);
  assert.match(designs, /aria-label="Featured promotion"/);
  assert.match(designCss, /\.mediaDisclosure/);
});

test("every one of the eight service pages gets the same premium hero", () => {
  for (const service of SERVICES) {
    assert.ok(hero.includes(`"${service}"`) || hero.includes(`  ${service}: {`), `${service} needs a hero spec`);
  }
  // One wrapper gives all eight flows the same anatomy, so no service page can be left behind.
  assert.match(page, /const flow=\(inner:React\.ReactNode\)=><><ServiceHero service=\{service\.name\}\/>\{inner\}<\/>/);
  for (const flow of ["GroomingFlow", "TrainingFlow", "StayFlow", "WalkingFlow", "TaxiFlow", "RelocationFlow", "FoodFlow"]) {
    assert.ok(new RegExp(`flow\\(<${flow}`).test(page), `${flow} must render inside the hero wrapper`);
  }
  // Anatomy from the reference: photo, then a card lifting over it with badge, name, promise, proofs.
  assert.match(hero, /className=\{styles\.photo\}/);
  assert.match(hero, /className=\{styles\.badge\}/);
  assert.match(hero, /spec\.promise/);
  assert.match(hero, /spec\.proofs\.map/);
  assert.match(heroCss, /\.card\s*\{[^}]*margin: -26px/, "the card overlaps the photograph");
});

test("service hero photos and proof claims are real and specific per service", () => {
  const photos = [...hero.matchAll(/photo: "(\/assets\/banners\/[^"]+)"/g)].map(match => match[1]);
  assert.equal(photos.length, SERVICES.length, "one photograph per service");
  for (const photo of photos) {
    assert.ok(fs.existsSync(new URL(`../public${photo}`, import.meta.url)), `${photo} must exist on disk`);
  }
  assert.equal(new Set(photos).size, photos.length, "each service gets its own photograph, not one reused everywhere");
  // Proofs must be service-specific, not the same three words copy-pasted.
  const proofSets = [...hero.matchAll(/proofs: \[("[^\]]+)\]/g)].map(match => match[1]);
  assert.equal(proofSets.length, SERVICES.length);
  assert.ok(new Set(proofSets).size >= 7, "trust proofs must be written per service");
});

test("the design fits a real phone: no zoom traps, reachable targets, safe areas", () => {
  // 16px inputs stop iOS zooming the page when a field is focused.
  assert.match(designCss, /font-size: 16px; \/\* keeps iOS from zooming/);
  // Every interactive control clears a 40px+ touch target.
  const heights = [...designCss.matchAll(/min-height: (\d+)px/g)].map(match => Number(match[1]));
  assert.ok(heights.length >= 6, "tap targets are sized explicitly");
  assert.ok(Math.min(...heights) >= 40, `smallest declared tap target is ${Math.min(...heights)}px`);
  // The splash covers the notch and the home indicator.
  assert.match(splashCss, /env\(safe-area-inset-top/);
  assert.match(splashCss, /env\(safe-area-inset-bottom/);
  // Small screens are handled rather than left to overflow.
  assert.match(designCss, /@media \(max-width: 340px\)/);
  assert.match(splashCss, /@media \(max-height: 700px\)/);
  assert.match(heroCss, /@media \(max-height: 720px\)/);
  // Motion is optional.
  assert.match(splashCss, /@media \(prefers-reduced-motion: reduce\)/);
});
