// Temporary human-UAT scope agreed with the product owner. This changes UI
// availability only: server proof/approval/completion rules remain untouched.
export const PHOTO_UPLOADS_DEFERRED = true;
export const PHOTO_UAT_NOTICE = "Photo uploads are scheduled for the final test round. You can test booking, assignment, arrival and starting service now. Photo proof and any completion that requires it remain pending; nothing is marked complete automatically.";
export function isDeferredPhotoAction(action: string | null, proof?: { beforePhotoRef?: string | null; afterPhotoRef?: string | null } | null) {
  return PHOTO_UPLOADS_DEFERRED && (action === "add_proof" || (action === "complete" && !(proof?.beforePhotoRef && proof?.afterPhotoRef)));
}
