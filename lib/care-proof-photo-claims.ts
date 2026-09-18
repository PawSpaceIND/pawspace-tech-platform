/*
 * Which proofs CLAIM a photo, and the media purpose each claim must be backed by.
 *
 * submitJobProof mirrors every proof into customer_job_updates, so a proof is a message to the
 * customer: "A new daily photo of your pet is available." Only grooming's two photos were ever
 * checked against stored media. Boarding's daily_photo and Sitting's visit_photo were not, so a
 * provider could post either with any objectId, or none at all, and the customer was told a photo of
 * their pet existed when nothing had been stored. Object storage is not even provisioned yet
 * (lib/media-storage-adapter.ts reports connected:false until a bucket binding exists), so on this
 * deployment no such photo could exist by any route.
 *
 * The other proof types make no photo claim - "reached", "completed", "medication ... logged",
 * "fed and it's logged", and walk_route, which is GPS rather than media - so they stay note-based.
 * A claim is gated here by what it tells the customer, not by which vertical it belongs to.
 *
 * This lives in its own module because BOTH sides need it: lib/provider-workspace enforces the gate
 * on the server, and the partner workspace page - a client component - reads it to label a missing
 * photo proof as un-postable rather than offering a button that cannot work. provider-workspace
 * reaches D1, server auth and `cloudflare:workers` through its governance imports, so a client
 * component importing the gate FROM there drags all of that into the browser bundle and the build
 * fails to resolve `cloudflare:workers`. Keep this module free of imports and both sides can read it.
 */
export const PHOTO_PROOF_PURPOSE:Record<string,Record<string,string>>={
 grooming:{before_photo:"before_service",after_photo:"after_service"},
 boarding:{daily_photo:"stay_update"},
 pet_sitting:{visit_photo:"sitting_update"},
};

/** Prefix marking a proof's objectId as a reference to stored media rather than a free-text note. */
export const MEDIA_REF_PREFIX="media://asset/";

/** True for a proof type that promises the customer a photo, and so must be backed by stored media. */
export function isPhotoProof(serviceCode:string,proofType:string){
 return Boolean(PHOTO_PROOF_PURPOSE[serviceCode]?.[proofType]);
}
