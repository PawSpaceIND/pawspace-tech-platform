import {readFileSync} from 'node:fs';
import {applyOwnedDdl} from './ai-harness.mjs';
import {applyIdempotentSqlMigration} from '../../scripts/schema/apply-idempotent-drizzle.mjs';
export const revisionMigration=readFileSync(new URL('../../drizzle/0045_grooming_dual_mode_revisions.sql',import.meta.url),'utf8');
export function installRevisionFixture(sqlite) {
 for(const path of ['lib/goal-context-engine.ts','lib/ai-audience-rollout.ts','lib/executive/ceo-orchestrator.ts',
  'lib/ai-business-configuration.ts','lib/whatsapp-conversation-control.ts','lib/voice-sales-specialists.ts',
  'lib/lead-owner-identity.ts','lib/walking-invoice.ts']) applyOwnedDdl(sqlite,path);
 applyIdempotentSqlMigration(sqlite,revisionMigration,'Task4 revision candidate');
}
