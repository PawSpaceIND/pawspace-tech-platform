import { DraftError, readWorkspace, saveMaster, saveDraft, getDraft, saveSignedCopy, reviewDraft, reviewSignedCopy, readPrivateCopy, recordDisposition, recordPortalOutcome, readSavedFinanceReturn, type DraftDatabase } from './store';
import { printableHtml, prepareReturn } from './workflow';
import { entityRole, requireEntityRole } from './access';
import { recordIntake } from './intake';
import { attachRequirementEvidence, proposeRequirement, readReadiness, reviewRequirement, supersedeRequirement } from './requirements';

type Actor = { email: string; developmentPreview: boolean };
export type DraftHttpDependencies = {
  authorize(request: Request, permission: 'finance.view' | 'finance.manage'): Promise<Actor>;
  context(): Promise<{ db: DraftDatabase; enabled: boolean }>;
  authError(error: unknown): Response;
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
function scope(request: Request) {
  const url = new URL(request.url), entityId = url.searchParams.get('entityId') || '';
  if (!/^[\w.-]{1,120}$/.test(entityId)) throw new DraftError('entity_id_required');
  return { url, entityId, draftId: url.searchParams.get('draftId') || '' };
}
function boundary(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new DraftError('same_origin_required', 403);
  if (Number(request.headers.get('content-length') || 0) > 600 * 1024) throw new DraftError('request_too_large', 413);
}
async function body(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new DraftError('json_required', 415);
  const raw = new TextDecoder().decode(await boundedBytes(request, 64 * 1024));
  try { return JSON.parse(raw); } catch { throw new DraftError('invalid_json'); }
}
async function boundedBytes(request: Request, limit: number) {
  const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
  if (!reader) throw new DraftError('request_body_required');
  let size = 0;
  for (;;) {
    const result = await reader.read(); if (result.done) break;
    size += result.value.length;
    if (size > limit) { await reader.cancel(); throw new DraftError('request_too_large', 413); }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Factory lets tests exercise actual handlers without bypassing auth or using preview superusers. */
export function draftHandlers(dependencies: DraftHttpDependencies) {
  async function run(request: Request, mutation: boolean) {
    let actor: Actor;
    try { actor = await dependencies.authorize(request, mutation ? 'finance.manage' : 'finance.view'); }
    catch (error) { return dependencies.authError(error); }
    try {
      const { db, enabled } = await dependencies.context();
      if (!enabled || actor.developmentPreview) return json({ error: 'company_compliance_drafts_disabled' }, 404);
      const { url, entityId, draftId } = scope(request);
      const role = await entityRole(db, entityId, actor.email);
      if (!mutation) {
        if (url.searchParams.get('view') === 'copy') {
          const file = await readPrivateCopy(db, entityId, draftId);
          return new Response(new Uint8Array(file.bytes), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="review-${draftId}.pdf"`, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff', 'x-document-sha256': file.copy.fileChecksum } });
        }
        if (url.searchParams.get('view') === 'print') {
          const draft = await getDraft(db, entityId, draftId);
          return new Response(printableHtml(draft), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'x-content-type-options': 'nosniff' } });
        }
        return json({ data: { ...await readWorkspace(db, entityId), readiness: await readReadiness(db, entityId), access: { role, principal: actor.email } } });
      }
      boundary(request);
      if (url.searchParams.get('action') === 'signed_copy') {
        requireEntityRole(role, 'make');
        if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) throw new DraftError('multipart_required', 415);
        // Read bounded bytes before form decoding, including chunked requests.
        const bytes = await boundedBytes(request, 600 * 1024);
        const form = await new Request(request.url, { method: 'POST', headers: request.headers, body: bytes }).formData();
        if (form.getAll('file').length !== 1 || form.getAll('metadata').length !== 1 || [...form.keys()].some(key => !['file', 'metadata'].includes(key))) throw new DraftError('single_private_pdf_required');
        const file = form.get('file'), metadata = form.get('metadata');
        if (!(file instanceof File) || file.type !== 'application/pdf' || typeof metadata !== 'string' || metadata.length > 16 * 1024) throw new DraftError('pdf_and_metadata_required');
        const input = JSON.parse(metadata);
        if (input.localDocumentReference !== `company-compliance:${entityId}:${draftId}`) throw new DraftError('private_document_reference_required');
        return json({ data: await saveSignedCopy(db, entityId, draftId, new Uint8Array(await file.arrayBuffer()), input, actor.email) }, 201);
      }
      const input = await body(request);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DraftError('object_required');
      if (['save_master', 'create_draft', 'record_intake', 'propose_requirement', 'attach_requirement_evidence', 'supersede_requirement'].includes(input.action)) requireEntityRole(role, 'make');
      else if (['review_draft', 'review_signed_copy', 'assess_filing', 'record_outcome', 'review_requirement'].includes(input.action)) requireEntityRole(role, 'check');
      else if (input.action === 'finance_snapshot') requireEntityRole(role, 'read');
      else throw new DraftError('unsupported_draft_action');
      if (input.action === 'save_master') {
        if (input.company?.entityId !== entityId) throw new DraftError('master_entity_mismatch');
        return json({ data: await saveMaster(db, input.company, input.expectedVersion, actor.email) }, 201);
      }
      if (input.action === 'create_draft') return json({ data: await saveDraft(db, entityId, input.meeting, input.draft, actor.email) }, 201);
      if (input.action === 'review_draft') return json({ data: await reviewDraft(db, entityId, draftId, input.expectedSequence, input.expectedChecksum, input.reference, actor.email) });
      if (input.action === 'review_signed_copy') return json({ data: await reviewSignedCopy(db, entityId, draftId, input.expectedSequence, input.expectedFileChecksum, input.reference, input.matchesOriginal, input.signers, actor.email) });
      if (input.action === 'assess_filing') {
        const assessment = { ...input.assessment, evidence: input.assessment?.evidence ? { ...input.assessment.evidence, reviewedBy: actor.email } : undefined };
        return json({ data: await recordDisposition(db, entityId, draftId, assessment, actor.email) });
      }
      if (input.action === 'record_outcome') {
        if (!['acknowledged', 'rejected'].includes(input.status)) throw new DraftError('invalid_outcome');
        return json({ data: await recordPortalOutcome(db, entityId, draftId, input.expectedSequence, input.status, input.reference, input.note, actor.email) });
      }
      if (input.action === 'finance_snapshot') {
        const scope = { entityId, registrationId: input.registrationId, artifactId: input.artifactId, period: input.period };
        return json({ data: await prepareReturn({ readSavedReturn: value => readSavedFinanceReturn(db, value) }, scope) });
      }
      // Readiness slice: incomplete intake and requirement verification. Separate owned tables; schema only on these mutations.
      if (input.action === 'record_intake') return json({ data: await recordIntake(db, entityId, input.intake, input.expectedVersion, actor.email) }, 201);
      if (input.action === 'propose_requirement') return json({ data: await proposeRequirement(db, entityId, input.requirement, actor.email) }, 201);
      if (input.action === 'attach_requirement_evidence') return json({ data: await attachRequirementEvidence(db, entityId, String(input.requirementId || ''), Number(input.version), input.evidence, actor.email) }, 201);
      if (input.action === 'review_requirement') return json({ data: await reviewRequirement(db, entityId, String(input.requirementId || ''), Number(input.version), Number(input.expectedSequence), input.review, actor.email) });
      if (input.action === 'supersede_requirement') return json({ data: await supersedeRequirement(db, entityId, String(input.requirementId || ''), input.replacement, actor.email) }, 201);
      throw new DraftError('unsupported_draft_action');
    } catch (error) {
      if (error instanceof DraftError) return json({ error: error.message }, error.status);
      if (error instanceof Error && /company_compliance_quota/.test(error.message)) return json({ error: 'private_storage_quota_exceeded' }, 413);
      if (error instanceof Error && /required|mismatch|invalid_|incomplete|duplicate_|conflict|lineage|not_clean|unsupported_/.test(error.message)) return json({ error: error.message }, 400);
      if (error instanceof Error && /UNIQUE constraint/.test(error.message)) return json({ error: 'version_or_audit_conflict' }, 409);
      // Never log company records, uploaded bytes, secret environment values or stack traces.
      return json({ error: 'company_compliance_draft_request_failed' }, 400);
    }
  }
  return { GET: (request: Request) => run(request, false), POST: (request: Request) => run(request, true) };
}
