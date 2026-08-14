"use client";

import { useEffect, useState } from "react";
import styles from "./pet-manager.module.css";
import type { LoggedInCustomer } from "./customer-login";
import { petProfileIssues } from "../../lib/customer-account";
import { loadCustomerPets, upsertCustomerPet, type CustomerPet } from "../../lib/customer-account-client";
import { AGE_BANDS, AGGRESSION_LEVELS, PET_GENDERS, WEIGHT_BANDS, ageBandFromYears, breedsFor, validatePetProfile, weightBandFromKg, type PetProfile, type PetSpecies } from "../../lib/pet-profile-options";

type PetForm = {
  id?: string;
  name: string;
  species: PetSpecies;
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
 *  ownership stays server-side via the platform session. */
export default function PetManager({ customer, onPetsChanged }: { customer: LoggedInCustomer; onPetsChanged?: (pets: CustomerPet[]) => void }) {
  const [pets, setPets] = useState<CustomerPet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<PetForm | null>(null); // null = closed; id set = edit-in-place
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const todayISO = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    let active = true;
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
  }, [customer.customerId]);

  const openAdd = () => {
    setIssues([]);
    setForm({ ...emptyForm });
  };
  const openEdit = (pet: CustomerPet) => {
    setIssues([]);
    const profile = pet.profile;
    const species: PetSpecies = pet.species === "cat" ? "cat" : "dog";
    // Pre-fill everything we can derive from a legacy pet (captured before this profile existed) so editing
    // it doesn't force re-entering data we already have — only genuinely-new fields (temperament) need a pick.
    const legacyBreed = pet.breed && (breedsFor(species) as readonly string[]).includes(pet.breed) ? pet.breed : "";
    setForm({
      id: pet.id,
      name: pet.name,
      species,
      gender: profile?.gender ?? "",
      breed: profile?.breed ?? legacyBreed,
      ageBand: profile?.ageBand ?? ageBandFromYears(pet.ageYears),
      dateOfBirth: profile?.dateOfBirth ?? "",
      vaccinated: profile ? (profile.vaccinated ? "yes" : "no") : pet.vaccinationStatus === "verified" ? "yes" : pet.vaccinationStatus === "not_provided" ? "no" : "",
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
    const profileIssue = validatePetProfile(form.species, profile);
    if (profileIssue) found.push(profileIssue);
    if (found.length) {
      setIssues(found);
      return;
    }
    setSaving(true);
    setIssues([]);
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
          <label>
            Species
            <select value={form.species} onChange={(event) => setField({ species: event.target.value as PetSpecies, breed: "" })}>
              <option value="dog">Dog</option>
              <option value="cat">Cat</option>
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
            <select value={form.breed} onChange={(event) => setField({ breed: event.target.value })}>
              <option value="">Select a breed…</option>
              {breedsFor(form.species).map((breed) => (
                <option key={breed} value={breed}>{breed}</option>
              ))}
            </select>
          </label>
          <label>
            Age
            <select value={form.ageBand} onChange={(event) => setField({ ageBand: event.target.value })}>
              <option value="">Select…</option>
              {AGE_BANDS.map((band) => (
                <option key={band} value={band}>{band}</option>
              ))}
            </select>
          </label>
          <label>
            Date of birth (optional)
            <input type="date" value={form.dateOfBirth} max={todayISO} onChange={(event) => setField({ dateOfBirth: event.target.value })} />
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
    return pet.vaccinationStatus === "verified" ? "Vaccination verified" : pet.vaccinationStatus === "pending" ? "Vaccination pending" : "Vaccination not provided";
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
