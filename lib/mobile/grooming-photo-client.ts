export async function prepareGroomingPhoto(input: {
  bookingId: string; purpose: "before_service" | "after_service"; dataUrl: string; uploadToInternalStorage?: boolean;
}) {
  if (!input.bookingId.trim()) throw new Error("Select your assigned grooming booking first.");
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(input.dataUrl);
  if (!match) throw new Error("Choose a JPEG, PNG or WebP photo.");
  const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error("Choose a photo smaller than 10 MB.");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  const response = await fetch("/api/service-media", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: input.bookingId, purpose: input.purpose, mimeType: match[1], sizeBytes: bytes.length, sha256 }),
  });
  const body = await response.json().catch(() => null) as { data?: { id?: string; ref?: string; bookingId?: string; proofReady?: boolean; upload?: { adapterConnected?: boolean; token?: string } } } | null;
  if (!response.ok || !body?.data?.id || !body.data.ref || body.data.bookingId !== input.bookingId) {
    throw new Error("We couldn't register this photo. Check your assigned booking and connection, then try again.");
  }
  // Registration is not upload completion or scan approval. No token is exposed to UI.
  if (input.uploadToInternalStorage) {
    if (!body.data.upload?.token) throw new Error("The photo was registered but no private upload grant was returned.");
    const uploaded = await fetch("/api/internal-service-media", { method: "PUT", headers: { "content-type": match[1], "x-media-upload-token": body.data.upload.token }, body: bytes });
    const result = await uploaded.json().catch(() => null) as { data?: { id?: string; stage?: string } } | null;
    if (!uploaded.ok || result?.data?.id !== body.data.id || result.data.stage !== "pending_review") throw new Error("The photo was registered but could not be stored. Check the internal-test storage connection and try again.");
    return { mediaId: body.data.id, mediaRef: body.data.ref, stage: "pending_review" as const, proofReady: false as const };
  }
  return { mediaId: body.data.id, mediaRef: body.data.ref, stage: "registered" as const, proofReady: false as const };
}
