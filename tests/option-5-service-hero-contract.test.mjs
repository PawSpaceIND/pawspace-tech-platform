import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const page = fs.readFileSync("app/mobile-app/page.tsx", "utf8");
const banner = fs.readFileSync("app/mobile-app/service-banner.tsx", "utf8");
const hero = fs.readFileSync("app/mobile-app/service-hero.tsx", "utf8");
const heroCss = fs.readFileSync("app/mobile-app/service-hero.module.css", "utf8");

test("Option 5 shared service anatomy wraps all eight current booking flows", () => {
  assert.match(page, /const flow=\(inner:React\.ReactNode\)=><><ServiceBanner service=\{service\.name\} compact\/>\{inner\}<\/>/);
  for (const service of ["Grooming", "Training", "Boarding", "Pet Sitting", "Dog Walking", "Pet Taxi", "Relocation", "Fresh Food"]) {
    assert.ok(page.includes(`service.name===\"${service}\"`), `${service} should remain routed through the shared flow wrapper`);
    assert.ok(hero.includes(service), `${service} should have an Option 5 hero specification`);
  }
});

test("compact service banner delegates presentation only to recovered Option 5 hero", () => {
  assert.match(banner, /import ServiceHero from "\.\/service-hero"/);
  assert.match(banner, /if \(compact && service\) return <ServiceHero service=\{service\} \/>/);
  assert.match(hero, /data-service-design="option-5-premium-visual"/);
  assert.match(hero, /spec\.proofs\.map/);
  assert.match(heroCss, /margin: -26px 14px 0/);
  assert.match(heroCss, /\.photo \{[^}]*height: 186px/s);
});
