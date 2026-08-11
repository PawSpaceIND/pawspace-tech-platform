import test from"node:test";import assert from"node:assert/strict";import fs from"node:fs";
const catalogue=fs.readFileSync(new URL("../lib/marketing-landing-content.ts",import.meta.url),"utf8");
const route=fs.readFileSync(new URL("../app/landing-pages/[slug]/page.tsx",import.meta.url),"utf8");
const index=fs.readFileSync(new URL("../app/landing-pages/page.tsx",import.meta.url),"utf8");

test("paid marketing review catalogue covers supplied campaign families",()=>{
 for(const slug of["dog-grooming","cat-grooming","pet-grooming","dog-sitting","cat-sitting","pet-sitting","dog-training","fresh-dog-food","pet-taxi","domestic-pet-relocation","international-dog-relocation","international-cat-relocation","international-pet-relocation","dog-boarding","cat-boarding","pet-boarding","vet-dog","vet-cat","vet-pets"]){assert.match(catalogue,new RegExp(`slug:\\"${slug}\\"`))}
});

test("marketing review routes stay noindex and hand final truth to PawSpace",()=>{
 assert.match(route,/robots:\{index:false,follow:false\}/);
 assert.match(index,/robots:\{index:false,follow:false\}/);
 assert.match(route,/Final price, availability and eligibility are resolved in the governed product/);
 assert.match(route,/mockup statistics, ratings, provider counts, discounts, pricing, WhatsApp availability or medical outcomes/);
});

test("taxi and clinical campaigns preserve safety boundaries",()=>{
 assert.match(catalogue,/controlled-review rather than an unrestricted live promise/);
 assert.match(catalogue,/Diagnosis, prescriptions and treatment decisions remain with qualified veterinary professionals/);
 assert.match(catalogue,/AI or automation never becomes the final behavioural authority/);
});
