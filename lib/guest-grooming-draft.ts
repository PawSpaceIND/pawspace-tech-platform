import type { CustomerPet } from './customer-account-client';
import { validatePetProfile } from './pet-profile-options';

export const GUEST_GROOMING_DRAFT_KEY = 'pawspace.grooming.draft.v1';
export type GuestGroomingDraft = {
  version: 1; savedAt: number; type: 'dog'|'cat'|'puppy'|'kitten';
  packId: string; plan: string; date: string; slot: string;
  pets: CustomerPet[]; selectedPetIds: string[];
};
/** Temporary browser draft only. Never persist identity, verified location, quote or payment state. */
export function parseGuestGroomingDraft(raw: string | null, now = Date.now()): GuestGroomingDraft | null {
  try {
    if (!raw || raw.length > 50000) return null;
    const d = JSON.parse(raw);
    if (d.version!==1 || !Number.isFinite(d.savedAt) || d.savedAt>now || now-d.savedAt>86400000) return null;
    if (!['dog','cat','puppy','kitten'].includes(d.type) || typeof d.packId!=='string' || typeof d.plan!=='string' || typeof d.date!=='string' || typeof d.slot!=='string') return null;
    if (!Array.isArray(d.pets) || d.pets.length>4 || !Array.isArray(d.selectedPetIds)) return null;
    const pets: CustomerPet[]=[];
    for (const p of d.pets) {
      if (typeof p.id!=='string' || !/^draft:[0-9a-f-]{36}$/.test(p.id) || typeof p.name!=='string' || !p.name.trim() || p.name.length>100 || !['dog','cat'].includes(p.species) || !p.profile || validatePetProfile(p.species,p.profile)) return null;
      const {photo: _photo, ...profile} = p.profile;
      pets.push({id:p.id,sourceId:null,name:p.name,species:p.species,breed:profile.breed,vaccinationStatus:profile.vaccinated?'verified':'not_provided',ageYears:null,weightKg:null,profile});
    }
    if(new Set(pets.map(p=>p.id)).size!==pets.length)return null;
    return {version:1,savedAt:d.savedAt,type:d.type,packId:d.packId.slice(0,40),plan:d.plan.slice(0,40),date:d.date.slice(0,10),slot:d.slot.slice(0,40),pets,selectedPetIds: [...new Set<string>(d.selectedPetIds.filter((id:unknown)=>typeof id==='string'&&pets.some(p=>p.id===id)))]};
  } catch { return null; }
}

/** Collision-resistant deterministic identity for retries, scoped to the verified owner. */
export async function guestPetIdentity(customerId:string,draftId:string) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([customerId,draftId])));
  return `guest-${Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')}`;
}
