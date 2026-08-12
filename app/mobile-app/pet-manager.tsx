"use client";

import { useEffect, useState } from "react";
import styles from "./pet-manager.module.css";
import type { LoggedInCustomer } from "./customer-login";
import { petProfileIssues } from "../../lib/customer-account";
import { loadCustomerPets, upsertCustomerPet, type CustomerPet } from "../../lib/customer-account-client";

type PetForm = { id?: string; name: string; species: string; breed: string; ageYears: string; weightKg: string; vaccinationStatus: string };

const emptyForm: PetForm = { name: "", species: "dog", breed: "", ageYears: "", weightKg: "", vaccinationStatus: "not_provided" };
const speciesIcon = (species: string) => (species === "cat" ? "🐈" : species === "dog" ? "🐕" : "🐾");
const vaccinationLabel: Record<string, string> = { not_provided: "Vaccination not provided", verified: "Vaccination verified", pending: "Vaccination pending" };
const optional = (value: string) => (value.trim() === "" ? null : Number(value));

/** Compact embeddable pet manager: booking flows render it inline so customers add or edit
 *  pets without leaving the flow. All reads/writes go through the customer-account client lib;
 *  ownership stays server-side via the platform session. */
export default function PetManager({ customer, onPetsChanged }: { customer: LoggedInCustomer; onPetsChanged?: (pets: CustomerPet[]) => void }) {
  const [pets, setPets] = useState<CustomerPet[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<PetForm | null>(null); // null = closed; id set = edit-in-place
  const [issues, setIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

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
    setForm({
      id: pet.id,
      name: pet.name,
      species: pet.species,
      breed: pet.breed ?? "",
      ageYears: pet.ageYears === null ? "" : String(pet.ageYears),
      weightKg: pet.weightKg === null ? "" : String(pet.weightKg),
      vaccinationStatus: pet.vaccinationStatus,
    });
  };

  const save = async () => {
    if (!form || saving) return;
    const candidate = {
      name: form.name.trim(),
      species: form.species,
      vaccinationStatus: form.vaccinationStatus,
      ageYears: optional(form.ageYears),
      weightKg: optional(form.weightKg),
    };
    // Same pure validator the server runs — the form flags exactly what the API would reject.
    const found = petProfileIssues(candidate);
    if (found.length) {
      setIssues(found);
      return;
    }
    setSaving(true);
    setIssues([]);
    try {
      await upsertCustomerPet({
        customerId: customer.customerId,
        pet: { id: form.id, name: candidate.name, species: candidate.species, breed: form.breed.trim() || null, vaccinationStatus: candidate.vaccinationStatus, ageYears: candidate.ageYears, weightKg: candidate.weightKg },
      });
      const refreshed = await loadCustomerPets(customer.customerId);
      setPets(refreshed);
      setForm(null);
      onPetsChanged?.(refreshed);
    } catch (error) {
      setIssues([error instanceof Error ? error.message : "Unable to save the pet"]);
    } finally {
      setSaving(false);
    }
  };

  const renderForm = (heading: string) =>
    form && (
      <div className={styles.form}>
        <b>{heading}</b>
        <div className={styles.fields}>
          <label>
            Name
            <input value={form.name} maxLength={60} placeholder="Pet name" onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label>
            Species
            <select value={form.species} onChange={(event) => setForm({ ...form, species: event.target.value })}>
              <option value="dog">Dog</option>
              <option value="cat">Cat</option>
            </select>
          </label>
          <label>
            Breed (optional)
            <input value={form.breed} maxLength={60} placeholder="e.g. Labrador" onChange={(event) => setForm({ ...form, breed: event.target.value })} />
          </label>
          <label>
            Age (years)
            <input value={form.ageYears} inputMode="decimal" placeholder="e.g. 3" onChange={(event) => setForm({ ...form, ageYears: event.target.value })} />
          </label>
          <label>
            Weight (kg)
            <input value={form.weightKg} inputMode="decimal" placeholder="e.g. 22" onChange={(event) => setForm({ ...form, weightKg: event.target.value })} />
          </label>
          <label>
            Vaccination
            <select value={form.vaccinationStatus} onChange={(event) => setForm({ ...form, vaccinationStatus: event.target.value })}>
              <option value="not_provided">Not provided</option>
              <option value="verified">Verified</option>
              <option value="pending">Pending</option>
            </select>
          </label>
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
            <i>{speciesIcon(pet.species)}</i>
            <div>
              <b>{pet.name}</b>
              <small>
                {[pet.breed, pet.species, pet.ageYears !== null ? `${pet.ageYears} yr` : null, pet.weightKg !== null ? `${pet.weightKg} kg` : null].filter(Boolean).join(" · ")}
              </small>
              <em>{vaccinationLabel[pet.vaccinationStatus] ?? pet.vaccinationStatus}</em>
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
