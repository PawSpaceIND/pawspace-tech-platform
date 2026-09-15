"use client";

import { useEffect, useState, type ReactElement } from "react";
import styles from "./pet-manager.module.css";
import type { LoggedInCustomer } from "./customer-login";
import { petProfileIssues } from "../../lib/customer-account";
import { loadCustomerPets, upsertCustomerPet, type CustomerPet } from "../../lib/customer-account-client";
import { AGE_BANDS, AGGRESSION_LEVELS, PET_GENDERS, WEIGHT_BANDS, ageBandFromDateOfBirth, ageBandFromYears, breedsFor, validatePetProfile, weightBandFromKg, type PetProfile, type PetSpecies } from "../../lib/pet-profile-options";

type PetForm = {
  id?: string;
  name: string;
  species: string; // "dog" | "cat" for the rich form; a legacy value (e.g. "other") is preserved, not coerced
  gender: string;
  breed: string;
  ageBand: string;
  dateOfBirth: string;
  vaccinated: "" | "yes" | "no";
  vaccinationDose: string;
  aggression: string;
  weightBand: string;
  photo: string; // compact JPEG data-URL, or ""
};

const emptyForm: PetForm = { name: "", species: "dog", gender: "", breed: "", ageBand: "", dateOfBirth: "", vaccinated: "", vaccinationDose: "", aggression: "", weightBand: "", photo: "" };
const speciesIcon = (species: string) => (species === "cat" ? "🐈" : species === "dog" ? "🐕" : "🐾");

/* The STORED vaccination vocabulary is wider than lib/customer-account.ts declares.
 *
 * That module declares ["not_provided","verified","pending"], but the platform's own writer -
 * lib/pet-vaccination-governance.ts, recordVaccination() - stamps canonical_pets.vaccination_status
 * with 'recorded' when a customer records a real vaccination, and imported/seeded rows carry
 * 'vaccinated'. Reading anything outside verified/pending as "not provided" therefore told the owner
 * of a genuinely vaccinated pet that their pet had no vaccination on file, and the same two-value
 * test in the edit pre-fill left the Vaccinated? field blank, so a customer could not change a pet's
 * NAME without re-asserting its vaccination. Vaccination is a booking gate for boarding and sitting,
 * so this read blocked real bookings.
 *
 * Reading is widened here; WRITING is untouched. A save still sends only "verified"/"not_provided"
 * (see `candidate` in save() below), so lib/customer-account.ts's PET_VACCINATION_STATUSES allow-list
 * and the shared petProfileIssues validator reject exactly what they rejected before. */
const VACCINATED_STATUSES = new Set(["verified", "recorded", "vaccinated"]);
const vaccinationStatusCode = (status: string | null | undefined) => String(status ?? "").trim().toLowerCase();
const isVaccinatedStatus = (status: string | null | undefined) => VACCINATED_STATUSES.has(vaccinationStatusCode(status));

/* Map a STORED breed onto the catalogue entry the shared validator accepts.
 *
 * The stored value and the catalogue disagree in two ways that are not the customer's fault: case
 * (a row holds 'indie'), and the catalogue's parenthetical qualifier ("Indie (Indian Pariah)"). An
 * exact, case-SENSITIVE includes() matched neither, so editing a pet with a perfectly good breed
 * opened an EMPTY breed field and Save refused with "Select the pet's breed".
 *
 * This only ever resolves to a value that is already IN the catalogue, so the validator
 * (lib/pet-profile-options.ts validatePetProfile, itself case-insensitive) is not weakened: a breed
 * that matches nothing still pre-fills empty and still has to be picked. */
const canonicalBreed = (species: string, stored: string | null | undefined) => {
  const wanted = String(stored ?? "").trim().toLowerCase();
  if (!wanted || (species !== "dog" && species !== "cat")) return "";
  const catalogue = breedsFor(species as PetSpecies) as readonly string[];
  const bare = (breed: string) => breed.replace(/\s*\([^)]*\)/g, "").trim().toLowerCase();
  return catalogue.find((breed) => breed.toLowerCase() === wanted) ?? catalogue.find((breed) => bare(breed) === wanted) ?? "";
};

/** Resize any picked image down to a small square-ish JPEG data-URL so we can persist it inline in D1
 *  for UAT (no object storage yet). Keeps profiles light — ~220px, quality 0.6. */
async function compressImage(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image failed"));
    image.src = dataUrl;
  });
  const max = 220;
  const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
  const w = Math.max(1, Math.round((img.width || max) * scale));
  const h = Math.max(1, Math.round((img.height || max) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.6);
}

/** Compact embeddable pet manager: booking flows render it inline so customers add or edit pets without
 *  leaving the flow. Captures the full pet profile — species, breed (from a curated popular-first list),
 *  gender, age band + optional DOB, vaccination, temperament, weight band and a photo — validated by the
 *  same pure functions the server runs. All reads/writes go through the customer-account client lib;
 *  ownership stays server-side via the platform session.
 *
 *  The signed-in overload preserves the long-standing embeddable contract. The second overload extends
 *  the same editor for the guest grooming draft without weakening signed-in ownership rules. */
export default function PetManager({ customer, onPetsChanged }: { customer: LoggedInCustomer; onPetsChanged?: (pets: CustomerPet[]) => void }): ReactElement;
export default function PetManager({ customer, onPetsChanged, draftPets }: { customer: LoggedInCustomer | null; onPetsChanged?: (pets: CustomerPet[]) => void; draftPets?: CustomerPet[] }): ReactElement;
export default function PetManager({ customer, onPetsChanged, draftPets = [] }: { customer: LoggedInCustomer | null; onPetsChanged?: (pets: CustomerPet[]) => void; draftPets?: CustomerPet[] }) {
  const [pets, setPets] = useState<CustomerPet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<PetForm | null>(null); // null = closed; id set = edit-in-place
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const now = new Date();
  const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; // local calendar date, not UTC

  useEffect(() => {
    let active = true;
    if (!customer) { setPets(draftPets); setLoading(false); return; }
    loadCustomerPets(customer.customerId)
      .then((loaded) => {
        if (!active) return;
        setPets(loaded);
        setLoadError("");
      })
      .catch((error) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Unable to load your pets");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [customer?.customerId]);

  const openAdd = () => {
    setIssues([]);
    setForm({ ...emptyForm });
  };
  const openEdit = (pet: CustomerPet) => {
    setIssues([]);
    const profile = pet.profile;
    // Preserve the real species — never coerce a legacy "other" pet to dog (that would rewrite it on save).
    const species = pet.species || "dog";
    // Pre-fill everything we can derive from a legacy pet (captured before this profile existed) so editing
    // it doesn't force re-entering data we already have — only genuinely-new fields (temperament) need a pick.
    // The stored breed is matched case-insensitively and through the catalogue's parenthetical qualifier,
    // so a row holding 'indie' pre-fills as "Indie (Indian Pariah)" instead of as an empty, blocking field.
    const storedBreed = profile?.breed ?? pet.breed;
    const knownBreed = canonicalBreed(species, storedBreed);
    setForm({
      id: pet.id,
      name: pet.name,
      species,
      gender: profile?.gender ?? "",
      // A rich profile's own off-catalogue breed is still shown verbatim (the customer can see and
      // correct what is stored); a legacy row that matches nothing still pre-fills empty, exactly as before.
      breed: knownBreed || profile?.breed || "",
      ageBand: profile?.ageBand ?? ageBandFromYears(pet.ageYears),
      dateOfBirth: profile?.dateOfBirth ?? "",
      // 'pending' stays unanswered on purpose: it means a claim is awaiting verification, and
      // pre-filling "yes" would silently promote it to verified on the next save.
      vaccinated: profile ? (profile.vaccinated ? "yes" : "no") : isVaccinatedStatus(pet.vaccinationStatus) ? "yes" : vaccinationStatusCode(pet.vaccinationStatus) === "not_provided" ? "no" : "",
      vaccinationDose: profile?.vaccinationDose ?? "",
      aggression: profile?.aggression ?? "",
      weightBand: profile?.weightBand ?? weightBandFromKg(pet.weightKg),
      photo: profile?.photo ?? "",
    });
  };

  const setField = (patch: Partial<PetForm>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const onPhoto = async (file?: File | null) => {
    if (!file) return;
    try {
      const photo = await compressImage(file);
      setForm((current) => (current ? { ...current, photo } : current));
    } catch {
      setIssues(["Could not read that image — try another photo"]);
    }
  };

  const save = async () => {
    if (!form || saving) return;
    if (form.species !== "dog" && form.species !== "cat") {
      // Only reachable when editing a legacy pet recorded as another species — don't rewrite it to a dog.
      setIssues(["Rich profiles are available for dogs and cats. Switch this pet's species to Dog or Cat to edit its full profile."]);
      return;
    }
    const profile: PetProfile = {
      gender: form.gender || undefined,
      breed: form.breed,
      ageBand: form.ageBand,
      dateOfBirth: form.dateOfBirth || undefined,
      vaccinated: form.vaccinated === "yes",
      vaccinationDose: form.vaccinated === "yes" ? form.vaccinationDose.trim() || undefined : undefined,
      aggression: form.aggression,
      weightBand: form.weightBand,
      photo: form.photo || undefined,
    };
    const candidate = {
      name: form.name.trim(),
      species: form.species,
      vaccinationStatus: profile.vaccinated ? "verified" : "not_provided",
      ageYears: null,
      weightKg: null,
    };
    // Shared pure validators — the form flags exactly what the API would reject.
    const found = [...petProfileIssues(candidate)];
    if (form.vaccinated === "") found.push("Tell us whether the pet is vaccinated");
    const profileIssue = validatePetProfile(form.species as PetSpecies, profile);
    if (profileIssue) found.push(profileIssue);
    if (found.length) {
      setIssues(found);
      return;
    }
    setSaving(true);
    setIssues([]);
    if (!customer) {
      const draft: CustomerPet = { ...candidate, id: form.id || `draft:${crypto.randomUUID()}`, sourceId: null, breed: profile.breed || null, profile };
      const updated = [...pets.filter(pet => pet.id !== draft.id), draft];
      setPets(updated); onPetsChanged?.(updated); setForm(null); setSaving(false);
      return;
    }
    try {
      await upsertCustomerPet({
        customerId: customer.customerId,
        pet: { id: form.id, name: candidate.name, species: form.species, breed: profile.breed || null, vaccinationStatus: candidate.vaccinationStatus, profile },
      });
    } catch (error) {
      // The save itself failed — nothing committed, so keep the form open for a safe retry.
      setIssues([error instanceof Error ? error.message : "Unable to save the pet"]);
      setSaving(false);
      return;
    }
    // The pet is committed. A failure refreshing the list must NOT reopen the resubmit path: a retry
    // mints a fresh idempotency key and would create a duplicate pet. Close the form, refresh best-effort.
    setForm(null);
    try {
      const refreshed = await loadCustomerPets(customer.customerId);
      setPets(refreshed);
      setLoadError("");
      onPetsChanged?.(refreshed);
    } catch {
      setLoadError("Pet saved — reload to see the updated list.");
    } finally {
      setSaving(false);
    }
  };

  const renderForm = (heading: string) =>
    form && (
      <div className={styles.form}>
        <b>{heading}</b>
        {form.species !== "dog" && form.species !== "cat" && (
          <p className={styles.hint}>This pet is recorded as “{form.species}”. Rich profiles are available for dogs and cats — switch species above to edit the full profile.</p>
        )}

        <div className={styles.photoRow}>
          <div className={styles.photoPreview} aria-hidden>{form.photo ? <img src={form.photo} alt="" /> : <span>{speciesIcon(form.species)}</span>}</div>
          <label className={styles.photoPick}>
            Photo (optional)
            <input type="file" accept="image/*" onChange={(event) => void onPhoto(event.target.files?.[0])} />
            {form.photo && (
              <button type="button" className={styles.linkBtn} onClick={() => setField({ photo: "" })}>
                Remove photo
              </button>
            )}
          </label>
        </div>

        <div className={styles.fields}>
          <label className={styles.full}>
            Name
            <input value={form.name} maxLength={60} placeholder="Pet name" onChange={(event) => setField({ name: event.target.value })} />
          </label>
          {!form.id && form.name.trim() && <div className={styles.full} aria-label="Matching saved pets">{pets.filter(pet => pet.name.toLocaleLowerCase().includes(form.name.trim().toLocaleLowerCase())).map(pet => <button key={pet.id} type="button" className={styles.secondary} onClick={() => openEdit(pet)}>Use {pet.name} · {pet.breed || pet.species}</button>)}</div>}
          <label>
            Species
            <select value={form.species} onChange={(event) => setField({ species: event.target.value, breed: "" })}>
              <option value="dog">Dog</option>
              <option value="cat">Cat</option>
              {form.species !== "dog" && form.species !== "cat" && <option value={form.species}>{form.species}</option>}
            </select>
          </label>
          <label>
            Gender (optional)
            <select value={form.gender} onChange={(event) => setField({ gender: event.target.value })}>
              <option value="">Select…</option>
              {PET_GENDERS.map((gender) => (
                <option key={gender} value={gender}>{gender}</option>
              ))}
            </select>
          </label>
          <label className={styles.full}>
            Breed
            <input list="pet-breed-options" value={form.breed} placeholder="Start typing a breed" autoComplete="off" onChange={(event) => setField({ breed: event.target.value })} />
            <datalist id="pet-breed-options">
              {breedsFor(form.species === "cat" ? "cat" : "dog").map((breed) => (
                <option key={breed} value={breed}>{breed}</option>
              ))}
            </datalist>
          </label>
          <label>
            Age
            <select value={form.ageBand} disabled={Boolean(form.dateOfBirth)} aria-describedby="pet-age-help" onChange={(event) => setField({ ageBand: event.target.value })}>
              <option value="">Select…</option>
              {AGE_BANDS.map((band) => (
                <option key={band} value={band}>{band}</option>
              ))}
            </select>
            <small id="pet-age-help">{form.dateOfBirth ? "Age is calculated from date of birth." : "Select age, or enter date of birth to calculate it."}</small>
          </label>
          <label>
            Date of birth (optional)
            <input type="date" value={form.dateOfBirth} max={todayISO} onChange={(event) => { const dateOfBirth = event.target.value; setField({ dateOfBirth, ageBand: dateOfBirth ? ageBandFromDateOfBirth(dateOfBirth) : form.ageBand }); }} />
          </label>
          <label>
            Weight
            <select value={form.weightBand} onChange={(event) => setField({ weightBand: event.target.value })}>
              <option value="">Select…</option>
              {WEIGHT_BANDS.map((band) => (
                <option key={band} value={band}>{band}</option>
              ))}
            </select>
          </label>
          <label>
            Temperament
            <select value={form.aggression} onChange={(event) => setField({ aggression: event.target.value })}>
              <option value="">Select…</option>
              {AGGRESSION_LEVELS.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>
          <label>
            Vaccinated?
            <select value={form.vaccinated} onChange={(event) => setField({ vaccinated: event.target.value as PetForm["vaccinated"] })}>
              <option value="">Select…</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          {form.vaccinated === "yes" && (
            <label>
              Latest vaccine (optional)
              <input value={form.vaccinationDose} maxLength={60} placeholder="e.g. Rabies / DHPPi" onChange={(event) => setField({ vaccinationDose: event.target.value })} />
            </label>
          )}
        </div>

        {issues.length > 0 && (
          <ul role="alert" className={styles.issues}>
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        <div className={styles.formActions}>
          <button type="button" className={styles.secondary} disabled={saving} onClick={() => setForm(null)}>
            Cancel
          </button>
          <button type="button" className={styles.primary} disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : form.id ? "Save changes" : "Add pet"}
          </button>
        </div>
      </div>
    );

  const petSummary = (pet: CustomerPet) => {
    const profile = pet.profile;
    const parts = profile
      ? [profile.breed, profile.gender, profile.ageBand, profile.weightBand, profile.aggression]
      : [pet.breed, pet.species, pet.ageYears !== null ? `${pet.ageYears} yr` : null, pet.weightKg !== null ? `${pet.weightKg} kg` : null];
    return parts.filter(Boolean).join(" · ");
  };
  const vaccinationTag = (pet: CustomerPet) => {
    if (pet.profile) return pet.profile.vaccinated ? `Vaccinated${pet.profile.vaccinationDose ? ` · ${pet.profile.vaccinationDose}` : ""}` : "Not vaccinated";
    const status = vaccinationStatusCode(pet.vaccinationStatus);
    if (status === "verified") return "Vaccination verified";
    if (isVaccinatedStatus(status)) return "Vaccinated"; // recorded by the customer, not staff-verified — say so, don't overclaim
    if (status === "pending") return "Vaccination pending";
    return "Vaccination not provided";
  };

  return (
    <section className={styles.manager}>
      <header className={styles.header}>
        <div>
          <b>Your pets</b>
          <span>Add or edit details right here — your booking continues below</span>
        </div>
        {!form && (
          <button type="button" className={styles.add} onClick={openAdd}>
            ＋ Add pet
          </button>
        )}
      </header>

      {loading && <p className={styles.hint}>Loading your pets…</p>}
      {loadError && (
        <p role="alert" className={styles.error}>
          {loadError}
        </p>
      )}
      {!loading && !loadError && pets.length === 0 && !form && <p className={styles.hint}>No pets on your profile yet — add the first one to speed up every booking.</p>}

      {pets.map((pet) =>
        form?.id === pet.id ? (
          <div key={pet.id}>{renderForm(`Edit ${pet.name}`)}</div>
        ) : (
          <article key={pet.id} className={styles.pet}>
            {pet.profile?.photo ? <img className={styles.avatar} src={pet.profile.photo} alt="" /> : <i>{speciesIcon(pet.species)}</i>}
            <div>
              <b>{pet.name}</b>
              <small>{petSummary(pet)}</small>
              <em>{vaccinationTag(pet)}</em>
            </div>
            <button type="button" className={styles.edit} disabled={Boolean(form)} onClick={() => openEdit(pet)}>
              Edit
            </button>
          </article>
        )
      )}

      {form && !form.id && renderForm("Add a pet")}
    </section>
  );
}
