import { DraftError, type DraftDatabase } from './store';
export type EntityRole = 'viewer' | 'maker' | 'checker';
/** Provisioning is deliberately absent from the public API. Grants must come from a
 * separately authorized access owner; no wildcard/entity/global-admin bypass exists. */
export async function entityRole(db: DraftDatabase, entityId: string, principal: string): Promise<EntityRole> {
  const table = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='company_compliance_entity_grants'").first();
  if (!table) throw new DraftError('entity_access_denied', 403);
  const key = principal.trim().toLowerCase();
  const grant = await db.prepare("SELECT role,expires_at,approved_by,approval_reference FROM company_compliance_entity_grants WHERE entity_id=? AND principal_key=? AND status='active'").bind(entityId, key).first();
  if (!grant || !['viewer', 'maker', 'checker'].includes(String(grant.role)) || !String(grant.approval_reference || '').trim() || !String(grant.approved_by || '').trim() || String(grant.approved_by).trim().toLowerCase() === key || !Number.isFinite(Date.parse(String(grant.expires_at))) || Date.parse(String(grant.expires_at)) <= Date.now()) throw new DraftError('entity_access_denied', 403);
  return grant.role as EntityRole;
}
export function requireEntityRole(role: EntityRole, action: 'make' | 'check' | 'read') {
  if (action !== 'read' && role !== (action === 'make' ? 'maker' : 'checker')) throw new DraftError('entity_role_denied', 403);
}
