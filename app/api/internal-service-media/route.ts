import { authError, database, requirePermission, requireProviderOwnership, resolveActor, securityAudit } from "../../../lib/server-auth";
import { ensureMediaBoundaryTables, redeemMediaUploadGrant, reviewMedia } from "../../../lib/media-upload-boundary";
import { assertInternalMediaEnvironment, readVerifiedPhoto } from "../../../lib/internal-media-upload";

type PrivateBucket = {
  put(key: string, bytes: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; httpMetadata: { contentType: string }; sha256: string }): Promise<unknown | null>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
  head(key: string): Promise<unknown>;
};
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new Response("Cross-site request refused", { status: 403 });
}

async function runtime() {
  const { env } = await import("cloudflare:workers");
  const values = env as unknown as Record<string, unknown>;
  assertInternalMediaEnvironment(values);
  const bucket = values.PAWSPACE_MEDIA_BUCKET as PrivateBucket | undefined;
  if (!bucket?.put || !bucket.get || !bucket.head) throw new Response("Private test storage is not configured", { status: 503 });
  return bucket;
}

export async function PUT(request: Request) {
  try {
    sameOrigin(request);
    const bucket = await runtime(), db = await database(), actor = await resolveActor(request);
    requirePermission(actor, "bookings.view");
    await ensureMediaBoundaryTables(db);
    const token = request.headers.get("x-media-upload-token") || "";
    const grant = await db.prepare("SELECT * FROM media_upload_grants WHERE id=?").bind(token.split(".")[0]).first<Record<string, unknown>>();
    if (!grant || !token) throw new Response("Upload grant not found", { status: 404 });
    await requireProviderOwnership(db, actor, String(grant.provider_id));
    if (grant.created_by !== actor.email) throw new Response("Use the identity that registered this photo", { status: 403 });
    const tokenHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, "0")).join("");
    if (grant.token_hash !== tokenHash) throw new Response("Upload token is invalid", { status: 403 });
    if (grant.status !== "issued" || Number(grant.expires_at) < Date.now()) throw new Response("Upload token is expired or already used", { status: 409 });
    const asset = await db.prepare("SELECT access_status,retention_status FROM service_media_assets WHERE id=?").bind(grant.media_id).first<Record<string, unknown>>();
    if (asset?.access_status !== "pending_upload" || asset.retention_status !== "active") throw new Response("This photo is no longer awaiting upload", { status: 409 });
    const bytes = await readVerifiedPhoto(request, { size: Number(grant.size_bytes), type: String(grant.mime_type), sha256: String(grant.sha256) });
    // Conditional write prevents a replay or concurrent request from replacing bytes.
    const stored = await bucket.put(String(grant.object_key), bytes, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: String(grant.mime_type) }, sha256: String(grant.sha256) });
    if (!stored) throw new Response("This photo already has a stored upload", { status: 409 });
    const result = await redeemMediaUploadGrant(db, { token, objectKey: String(grant.object_key), actorId: actor.email });
    await securityAudit(db, actor, "internal_media.upload", "booking", String(grant.booking_id), "completed", { mediaId: result.mediaId, internalTest: true });
    return Response.json({ data: { id: result.mediaId, ref: result.mediaRef, stage: "pending_review", proofReady: false, internalTest: true } }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return authError(error, "Unable to save the internal-test photo"); }
}

export async function GET(request: Request) {
  try {
    const bucket = await runtime(), db = await database(), actor = await resolveActor(request);
    requirePermission(actor, "bookings.manage");
    if (new URL(request.url).searchParams.get("capabilities") === "1") return Response.json({ internalTest: true, privateStorage: true }, { headers: { "cache-control": "no-store" } });
    const id = new URL(request.url).searchParams.get("mediaId") || "";
    const asset = await db.prepare("SELECT * FROM service_media_assets WHERE id=?").bind(id).first<Record<string, unknown>>();
    if (!asset || asset.retention_status !== "active" || !["quarantined", "ready"].includes(String(asset.access_status))) throw new Response("Photo is not available for review", { status: 404 });
    const object = await bucket.get(String(asset.storage_key));
    if (!object) throw new Response("Photo is not stored", { status: 404 });
    await securityAudit(db, actor, "internal_media.read", "media", id, "completed", { internalTest: true });
    return new Response(object.body, { headers: { "content-type": String(asset.mime_type), "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
  } catch (error) { return authError(error, "Unable to open the internal-test photo"); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Response("JSON review request required", { status: 415 });
    await runtime();
    const db = await database(), actor = await resolveActor(request);
    requirePermission(actor, "bookings.manage");
    const input = await request.json() as { mediaId?: string; decision?: "approved" | "rejected"; reason?: string };
    if (!input.reason || input.reason.trim().length < 5) throw new Response("Please give a review reason", { status: 400 });
    const result = await reviewMedia(db, { mediaId: String(input.mediaId || ""), decision: input.decision!, actorId: actor.email, reason: `Internal UAT manual review: ${input.reason.trim()}` });
    await securityAudit(db, actor, "internal_media.manual_review", "media", String(input.mediaId), "completed", { decision: input.decision, automatedScanPerformed: false, internalTest: true });
    return Response.json({ data: result, internalTest: true, automatedScanPerformed: false });
  } catch (error) { return authError(error, "Unable to review this internal-test photo"); }
}
