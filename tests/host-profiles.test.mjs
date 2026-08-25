import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const libSource = fs.readFileSync("lib/host-profiles.ts", "utf8");
const routeSource = fs.readFileSync("app/api/host-profile/route.ts", "utf8");
const gatewaySource = fs.readFileSync("lib/api-gateway.ts", "utf8");
const cardSource = fs.readFileSync("app/mobile-app/host-profile-card.tsx", "utf8");

test("host-profiles module exports the required contract functions", () => {
  assert.match(libSource, /export async function ensureHostProfileTables\(/);
  assert.match(libSource, /export async function upsertHostProfile\(/);
  assert.match(libSource, /export async function getHostProfile\(/);
  assert.match(libSource, /export async function seedDemoHostProfiles\(/);
});

test("ensureHostProfileTables is WeakSet-memoized, same pattern as ensureSecurityTables", () => {
  assert.match(libSource, /const hostProfileTablesEnsured\s*=\s*new WeakSet<Db>\(\)/);
  assert.match(libSource, /if\s*\(\s*hostProfileTablesEnsured\.has\(db\)\s*\)\s*return;/);
  assert.match(libSource, /hostProfileTablesEnsured\.add\(db\)/);
});

test("seedDemoHostProfiles seeds all six seeded host/sitter provider ids", () => {
  for (const providerId of ["host_sana", "host_maya_rohan", "host_arjun_tara", "sit_sana", "sit_neha", "sit_asha"]) {
    assert.match(libSource, new RegExp(`providerId:\\s*"${providerId}"`));
  }
});

test("the profile field contract matches the spec (verified badges, stats, reviews)", () => {
  assert.match(libSource, /kyc:\s*boolean/);
  assert.match(libSource, /backgroundCheck:\s*boolean/);
  assert.match(libSource, /homeVerified:\s*boolean/);
  assert.match(libSource, /happyPets:\s*number/);
  assert.match(libSource, /onTimePct:\s*number/);
  assert.match(libSource, /happyParents:\s*number/);
  assert.match(libSource, /yearsExp:\s*number/);
});

test("the public Host Profile API is observational and reads by providerId without staff auth", () => {
  assert.doesNotMatch(routeSource, /seedDemoHostProfiles\(/, "public GET must not seed synthetic profiles");
  assert.match(routeSource, /getHostProfile\(/);
  assert.match(routeSource, /searchParams\.get\("providerId"\)/);
  assert.doesNotMatch(routeSource, /authorize\(/);
  assert.doesNotMatch(routeSource, /resolveActor\(/);
});

test("/api/host-profile is allowlisted as public in the API gateway, alongside /api/customer-otp", () => {
  assert.match(gatewaySource, /url\.pathname==="\/api\/host-profile"\|\|url\.pathname==="\/api\/customer-otp"/);
});

test("the profile card is a standalone client component that never touches stay-flow.tsx", () => {
  assert.match(cardSource, /^"use client";/m);
  assert.match(cardSource, /export default function HostProfileCard\(/);
  assert.doesNotMatch(cardSource, /stay-flow/);
  assert.doesNotMatch(cardSource, /from ["']\.\.\/\.\.\/lib\/host-profiles["']/);
});

test("the card fetches the public route and renders photo/badges/rating/reviews/stats, using placeholders not real images", () => {
  assert.match(cardSource, /fetch\(`\/api\/host-profile/);
  assert.doesNotMatch(cardSource, /<img/);
  assert.match(cardSource, /verified/i);
  assert.match(cardSource, /stats\.happyPets/);
  assert.match(cardSource, /reviews\.map/);
});

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        sqlite.prepare(sql).run(...args);
        return { success: true };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

test("real execution: seedDemoHostProfiles + getHostProfile returns a full profile with reviews, badges and stats", async () => {
  const { ensureHostProfileTables, seedDemoHostProfiles, getHostProfile, upsertHostProfile } = await import("../lib/host-profiles.ts");
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);

  await ensureHostProfileTables(db);
  const tableExists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='host_profiles'").get();
  assert.ok(tableExists, "host_profiles table must genuinely be created");

  await seedDemoHostProfiles(db);
  await seedDemoHostProfiles(db);
  const count = sqlite.prepare("SELECT COUNT(*) c FROM host_profiles").get();
  assert.equal(count.c, 6, "exactly the 6 seeded host/sitter profiles must exist after seeding twice");

  const profile = await getHostProfile(db, "host_sana");
  assert.ok(profile, "getHostProfile must return a profile for a seeded provider id");
  assert.equal(profile.providerId, "host_sana");
  assert.equal(profile.role, "Host");
  assert.ok(profile.rating > 0, "rating must be a real positive demo value");
  assert.ok(Array.isArray(profile.reviews) && profile.reviews.length >= 2, "profile must include at least 2 reviews");
  for (const review of profile.reviews) {
    assert.equal(typeof review.author, "string");
    assert.equal(typeof review.city, "string");
    assert.equal(typeof review.stars, "number");
    assert.equal(typeof review.text, "string");
  }
  assert.equal(typeof profile.verified.kyc, "boolean");
  assert.equal(typeof profile.verified.backgroundCheck, "boolean");
  assert.equal(typeof profile.verified.homeVerified, "boolean");
  assert.ok(profile.verified.kyc === true, "the seeded host_sana demo profile must be KYC verified");
  assert.equal(typeof profile.stats.happyPets, "number");
  assert.equal(typeof profile.stats.onTimePct, "number");
  assert.equal(typeof profile.stats.happyParents, "number");
  assert.equal(typeof profile.stats.yearsExp, "number");
  assert.ok(Array.isArray(profile.specializations) && profile.specializations.length > 0);
  assert.ok(Array.isArray(profile.servicesOffered) && profile.servicesOffered.length > 0);
  assert.ok(Array.isArray(profile.housePhotoRefs));
  assert.equal(typeof profile.photoRef, "string");

  const sitter = await getHostProfile(db, "sit_neha");
  assert.ok(sitter && sitter.role === "Sitter", "sit_neha must be seeded with role Sitter");

  assert.equal(await getHostProfile(db, "no_such_provider"), null, "an unseeded provider id must return null, not fabricate a profile");

  const written = await upsertHostProfile(db, {
    providerId: "host_test_roundtrip",
    displayName: "Test Roundtrip",
    role: "Host",
    photoRef: "avatar:test",
    housePhotoRefs: ["house:test:1"],
    verified: { kyc: true, backgroundCheck: false, homeVerified: true },
    rating: 4.5,
    locationLabel: "Test City",
    yearsExperience: 1,
    about: "Test about text.",
    specializations: ["Test specialization"],
    servicesOffered: ["Boarding"],
    reviews: [{ author: "Test Author", city: "Test City", stars: 5, text: "Great." }],
    stats: { happyPets: 1, onTimePct: 100, happyParents: 1, yearsExp: 1 },
  });
  assert.equal(written.providerId, "host_test_roundtrip");
  const reread = await getHostProfile(db, "host_test_roundtrip");
  assert.deepEqual(reread, written, "a freshly written profile must read back byte-for-byte identical");
});
