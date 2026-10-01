import { chunkedIn } from "./d1-chunked-in";

/** Generated from the candidate SQL archive. Read-only readiness; never runs lazy DDL.
 * Verify definitions as well as names, so stale/no-op triggers cannot masquerade as an install. */
export const expectedGroomingTriggers = [
  {
    "name": "conversation_revision_insert",
    "sql": "CREATE TRIGGER conversation_revision_insert AFTER INSERT ON communication_threads BEGIN\n  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(NEW.id,1)\n    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;\nEND"
  },
  {
    "name": "conversation_revision_update",
    "sql": "CREATE TRIGGER conversation_revision_update AFTER UPDATE OF id,customer_id,lead_id,booking_id,ticket_id,assigned_to,status ON communication_threads\nWHEN NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.lead_id IS NOT OLD.lead_id\n  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.ticket_id IS NOT OLD.ticket_id\n  OR NEW.assigned_to IS NOT OLD.assigned_to OR NEW.status IS NOT OLD.status\nBEGIN\n  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.id,1)\n    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;\n  INSERT INTO conversation_ownership_revisions(thread_id,revision) SELECT NEW.id,1 WHERE NEW.id IS NOT OLD.id\n    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;\nEND"
  },
  {
    "name": "conversation_revision_delete",
    "sql": "CREATE TRIGGER conversation_revision_delete AFTER DELETE ON communication_threads BEGIN\n  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.id,1)\n    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;\nEND"
  },
  {
    "name": "conversation_handoff_revision_insert",
    "sql": "CREATE TRIGGER conversation_handoff_revision_insert AFTER INSERT ON ai_handoffs BEGIN\n  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(NEW.thread_id,1)\n    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;\nEND"
  },
  {
    "name": "conversation_handoff_revision_update",
    "sql": "CREATE TRIGGER conversation_handoff_revision_update AFTER UPDATE OF thread_id,status,taken_over_by ON ai_handoffs\nWHEN NEW.thread_id IS NOT OLD.thread_id OR NEW.status IS NOT OLD.status OR NEW.taken_over_by IS NOT OLD.taken_over_by\nBEGIN\n  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.thread_id,1)\n    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;\n  INSERT INTO conversation_ownership_revisions(thread_id,revision) SELECT NEW.thread_id,1 WHERE NEW.thread_id IS NOT OLD.thread_id\n    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;\nEND"
  },
  {
    "name": "conversation_handoff_revision_delete",
    "sql": "CREATE TRIGGER conversation_handoff_revision_delete AFTER DELETE ON ai_handoffs BEGIN\n  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.thread_id,1)\n    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;\nEND"
  },
  {
    "name": "conversation_revision_no_reset",
    "sql": "CREATE TRIGGER conversation_revision_no_reset BEFORE UPDATE ON conversation_ownership_revisions\nWHEN NEW.thread_id IS NOT OLD.thread_id OR NEW.revision<=OLD.revision BEGIN\n SELECT RAISE(ABORT,'ownership_revision_must_increase');\nEND"
  },
  {
    "name": "conversation_revision_no_delete",
    "sql": "CREATE TRIGGER conversation_revision_no_delete BEFORE DELETE ON conversation_ownership_revisions BEGIN\n SELECT RAISE(ABORT,'ownership_revision_tombstone_required');\nEND"
  },
  {
    "name": "grooming_control_revision_no_reset",
    "sql": "CREATE TRIGGER grooming_control_revision_no_reset BEFORE UPDATE ON grooming_effective_control_revision\nWHEN NEW.id IS NOT OLD.id OR NEW.revision<=OLD.revision OR NEW.database_incarnation IS NOT OLD.database_incarnation BEGIN\n SELECT RAISE(ABORT,'control_revision_must_increase');\nEND"
  },
  {
    "name": "grooming_control_revision_no_delete",
    "sql": "CREATE TRIGGER grooming_control_revision_no_delete BEFORE DELETE ON grooming_effective_control_revision BEGIN\n SELECT RAISE(ABORT,'control_revision_tombstone_required');\nEND"
  },
  {
    "name": "grooming_control_gce_goals_insert",
    "sql": "CREATE TRIGGER grooming_control_gce_goals_insert AFTER INSERT ON gce_goals BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_gce_goals_update",
    "sql": "CREATE TRIGGER grooming_control_gce_goals_update AFTER UPDATE ON gce_goals BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_gce_goals_delete",
    "sql": "CREATE TRIGGER grooming_control_gce_goals_delete AFTER DELETE ON gce_goals BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_gce_budget_envelopes_insert",
    "sql": "CREATE TRIGGER grooming_control_gce_budget_envelopes_insert AFTER INSERT ON gce_budget_envelopes BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_gce_budget_envelopes_update",
    "sql": "CREATE TRIGGER grooming_control_gce_budget_envelopes_update AFTER UPDATE ON gce_budget_envelopes BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_gce_budget_envelopes_delete",
    "sql": "CREATE TRIGGER grooming_control_gce_budget_envelopes_delete AFTER DELETE ON gce_budget_envelopes BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_gce_constraints_insert",
    "sql": "CREATE TRIGGER grooming_control_gce_constraints_insert AFTER INSERT ON gce_constraints BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_gce_constraints_update",
    "sql": "CREATE TRIGGER grooming_control_gce_constraints_update AFTER UPDATE ON gce_constraints BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_gce_constraints_delete",
    "sql": "CREATE TRIGGER grooming_control_gce_constraints_delete AFTER DELETE ON gce_constraints BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_audience_rollout_insert",
    "sql": "CREATE TRIGGER grooming_control_ai_audience_rollout_insert AFTER INSERT ON ai_audience_rollout BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_audience_rollout_update",
    "sql": "CREATE TRIGGER grooming_control_ai_audience_rollout_update AFTER UPDATE ON ai_audience_rollout BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_audience_rollout_delete",
    "sql": "CREATE TRIGGER grooming_control_ai_audience_rollout_delete AFTER DELETE ON ai_audience_rollout BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_executive_runtime_config_insert",
    "sql": "CREATE TRIGGER grooming_control_executive_runtime_config_insert AFTER INSERT ON executive_runtime_config BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_executive_runtime_config_update",
    "sql": "CREATE TRIGGER grooming_control_executive_runtime_config_update AFTER UPDATE ON executive_runtime_config BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_executive_runtime_config_delete",
    "sql": "CREATE TRIGGER grooming_control_executive_runtime_config_delete AFTER DELETE ON executive_runtime_config BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_kill_switches_insert",
    "sql": "CREATE TRIGGER grooming_control_ai_kill_switches_insert AFTER INSERT ON ai_kill_switches BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_kill_switches_update",
    "sql": "CREATE TRIGGER grooming_control_ai_kill_switches_update AFTER UPDATE ON ai_kill_switches BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_kill_switches_delete",
    "sql": "CREATE TRIGGER grooming_control_ai_kill_switches_delete AFTER DELETE ON ai_kill_switches BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_assistant_profile_versions_insert",
    "sql": "CREATE TRIGGER grooming_control_ai_assistant_profile_versions_insert AFTER INSERT ON ai_assistant_profile_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_assistant_profile_versions_update",
    "sql": "CREATE TRIGGER grooming_control_ai_assistant_profile_versions_update AFTER UPDATE ON ai_assistant_profile_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_assistant_profile_versions_delete",
    "sql": "CREATE TRIGGER grooming_control_ai_assistant_profile_versions_delete AFTER DELETE ON ai_assistant_profile_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_intent_versions_insert",
    "sql": "CREATE TRIGGER grooming_control_ai_intent_versions_insert AFTER INSERT ON ai_intent_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_intent_versions_update",
    "sql": "CREATE TRIGGER grooming_control_ai_intent_versions_update AFTER UPDATE ON ai_intent_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_intent_versions_delete",
    "sql": "CREATE TRIGGER grooming_control_ai_intent_versions_delete AFTER DELETE ON ai_intent_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_prompt_policy_versions_insert",
    "sql": "CREATE TRIGGER grooming_control_ai_prompt_policy_versions_insert AFTER INSERT ON ai_prompt_policy_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_prompt_policy_versions_update",
    "sql": "CREATE TRIGGER grooming_control_ai_prompt_policy_versions_update AFTER UPDATE ON ai_prompt_policy_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_prompt_policy_versions_delete",
    "sql": "CREATE TRIGGER grooming_control_ai_prompt_policy_versions_delete AFTER DELETE ON ai_prompt_policy_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_knowledge_source_versions_insert",
    "sql": "CREATE TRIGGER grooming_control_ai_knowledge_source_versions_insert AFTER INSERT ON ai_knowledge_source_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_knowledge_source_versions_update",
    "sql": "CREATE TRIGGER grooming_control_ai_knowledge_source_versions_update AFTER UPDATE ON ai_knowledge_source_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_knowledge_source_versions_delete",
    "sql": "CREATE TRIGGER grooming_control_ai_knowledge_source_versions_delete AFTER DELETE ON ai_knowledge_source_versions BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_whatsapp_conversation_routing_modes_insert",
    "sql": "CREATE TRIGGER grooming_control_whatsapp_conversation_routing_modes_insert AFTER INSERT ON whatsapp_conversation_routing_modes BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_whatsapp_conversation_routing_modes_update",
    "sql": "CREATE TRIGGER grooming_control_whatsapp_conversation_routing_modes_update AFTER UPDATE ON whatsapp_conversation_routing_modes BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_whatsapp_conversation_routing_modes_delete",
    "sql": "CREATE TRIGGER grooming_control_whatsapp_conversation_routing_modes_delete AFTER DELETE ON whatsapp_conversation_routing_modes BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_voice_sales_offers_insert",
    "sql": "CREATE TRIGGER grooming_control_voice_sales_offers_insert AFTER INSERT ON voice_sales_offers BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_voice_sales_offers_update",
    "sql": "CREATE TRIGGER grooming_control_voice_sales_offers_update AFTER UPDATE ON voice_sales_offers BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_voice_sales_offers_delete",
    "sql": "CREATE TRIGGER grooming_control_voice_sales_offers_delete AFTER DELETE ON voice_sales_offers BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_lead_work_items_insert",
    "sql": "CREATE TRIGGER grooming_control_lead_work_items_insert AFTER INSERT ON lead_work_items BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_lead_work_items_update",
    "sql": "CREATE TRIGGER grooming_control_lead_work_items_update AFTER UPDATE ON lead_work_items BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_lead_work_items_delete",
    "sql": "CREATE TRIGGER grooming_control_lead_work_items_delete AFTER DELETE ON lead_work_items BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_canonical_bookings_insert",
    "sql": "CREATE TRIGGER grooming_control_canonical_bookings_insert AFTER INSERT ON canonical_bookings BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_canonical_bookings_update",
    "sql": "CREATE TRIGGER grooming_control_canonical_bookings_update AFTER UPDATE OF id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,channel,total_amount,currency,pricing_json,created_by,created_at ON canonical_bookings BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_canonical_bookings_delete",
    "sql": "CREATE TRIGGER grooming_control_canonical_bookings_delete AFTER DELETE ON canonical_bookings BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_lead_ownership_insert",
    "sql": "CREATE TRIGGER grooming_control_ai_lead_ownership_insert AFTER INSERT ON ai_lead_ownership BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_lead_ownership_update",
    "sql": "CREATE TRIGGER grooming_control_ai_lead_ownership_update AFTER UPDATE ON ai_lead_ownership BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_control_ai_lead_ownership_delete",
    "sql": "CREATE TRIGGER grooming_control_ai_lead_ownership_delete AFTER DELETE ON ai_lead_ownership BEGIN\n UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;\n SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;\nEND"
  },
  {
    "name": "grooming_installation_epoch_no_reset",
    "sql": "CREATE TRIGGER grooming_installation_epoch_no_reset BEFORE UPDATE ON grooming_revision_installation_epoch\nWHEN NEW.id IS NOT OLD.id OR NEW.epoch<=OLD.epoch OR NEW.incarnation IS NOT OLD.incarnation BEGIN\n SELECT RAISE(ABORT,'installation_epoch_must_increase');\nEND"
  },
  {
    "name": "grooming_installation_epoch_no_delete",
    "sql": "CREATE TRIGGER grooming_installation_epoch_no_delete BEFORE DELETE ON grooming_revision_installation_epoch BEGIN\n SELECT RAISE(ABORT,'installation_epoch_tombstone_required');\nEND"
  }
] as const;
export const groomingRevisionTriggers = expectedGroomingTriggers.map(trigger=>trigger.name);
const normalize=(sql:string)=>sql.replace(/\s+/g," ").replace(/;\s*$/,"").trim();
export async function assertGroomingRevisionInstallation(db:D1Database) {
 const installed=await chunkedIn(groomingRevisionTriggers,async(names,placeholders)=>
   (await db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${placeholders})`)
     .bind(...names).all<{name:string;sql:string}>()).results);
 const definitions=new Map(installed.map(trigger=>[trigger.name,normalize(trigger.sql)]));
 const marker=await db.prepare("SELECT schema_version FROM grooming_revision_installation WHERE id=1").first<{schema_version:number}>();
 if (marker?.schema_version!==2 || expectedGroomingTriggers.some(trigger=>definitions.get(trigger.name)!==normalize(trigger.sql))) {
   throw new Response("Grooming revision installation incomplete",{status:409});
 }
}
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
/** sqlite_master retains DDL formatting: archive install/replay preserves these exact stored strings.
 * Different formatting is conservatively unavailable until installed via reviewed replay.
 * A VALUES relation keeps expression depth bounded as the manifest grows (D1 limit: 100). */
export const groomingInstallationPredicate = `
 (WITH expected_grooming_triggers(name,sql) AS (
  VALUES ${expectedGroomingTriggers.map(trigger=>"("+literal(trigger.name)+","+literal(trigger.sql)+")").join(",\n  ")}
 ) SELECT COUNT(*) FROM expected_grooming_triggers expected
  JOIN sqlite_master installed ON installed.type='trigger'
   AND installed.name=expected.name AND installed.sql=expected.sql)=${groomingRevisionTriggers.length}
 AND EXISTS(SELECT 1 FROM grooming_revision_installation WHERE id=1 AND schema_version=2)
 AND EXISTS(SELECT 1 FROM grooming_revision_installation_epoch WHERE id=1 AND epoch BETWEEN 1 AND 9007199254740991 AND length(incarnation)>=32)
 AND EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1 AND revision BETWEEN 1 AND 9007199254740991 AND length(database_incarnation)>=32)`;
