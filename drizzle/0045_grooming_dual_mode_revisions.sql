-- Task4 schema-v2 review correction: installation fencing BEFORE repair.
-- Existing runtime-owned prerequisites required. Hosted install/repair requires worker drain.
-- The governed remote runner MUST skip intact paired DROP/CREATE definitions.
-- In-memory SQLite replay is synchronous; hosted D1 proof still required.
-- Split comparison literals keep the replay DDL normalizer from rewriting stored trigger SQL.
CREATE TABLE IF NOT EXISTS grooming_revision_installation (id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grooming_revision_installation_epoch (
 id INTEGER PRIMARY KEY CHECK(id=1),
 epoch INTEGER NOT NULL CHECK(typeof(epoch)='integer' AND epoch BETWEEN 1 AND 9007199254740991),
 incarnation TEXT NOT NULL CHECK(length(incarnation)>=32)
);
INSERT OR IGNORE INTO grooming_revision_installation_epoch VALUES(1,1,lower(hex(randomblob(32))));
UPDATE grooming_revision_installation_epoch SET epoch=epoch+1 WHERE id=1 AND NOT ((SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND ((name='conversation_revision_insert' AND sql='CREATE '||'TRIGGER conversation_revision_insert AFTER INSERT ON communication_threads BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(NEW.id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END') OR (name='conversation_revision_update' AND sql='CREATE '||'TRIGGER conversation_revision_update AFTER UPDATE OF id,customer_id,lead_id,booking_id,ticket_id,assigned_to,status ON communication_threads
WHEN NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.lead_id IS NOT OLD.lead_id
  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.ticket_id IS NOT OLD.ticket_id
  OR NEW.assigned_to IS NOT OLD.assigned_to OR NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
  INSERT INTO conversation_ownership_revisions(thread_id,revision) SELECT NEW.id,1 WHERE NEW.id IS NOT OLD.id
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END') OR (name='conversation_revision_delete' AND sql='CREATE '||'TRIGGER conversation_revision_delete AFTER DELETE ON communication_threads BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END') OR (name='conversation_handoff_revision_insert' AND sql='CREATE '||'TRIGGER conversation_handoff_revision_insert AFTER INSERT ON ai_handoffs BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(NEW.thread_id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END') OR (name='conversation_handoff_revision_update' AND sql='CREATE '||'TRIGGER conversation_handoff_revision_update AFTER UPDATE OF thread_id,status,taken_over_by ON ai_handoffs
WHEN NEW.thread_id IS NOT OLD.thread_id OR NEW.status IS NOT OLD.status OR NEW.taken_over_by IS NOT OLD.taken_over_by
BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.thread_id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
  INSERT INTO conversation_ownership_revisions(thread_id,revision) SELECT NEW.thread_id,1 WHERE NEW.thread_id IS NOT OLD.thread_id
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END') OR (name='conversation_handoff_revision_delete' AND sql='CREATE '||'TRIGGER conversation_handoff_revision_delete AFTER DELETE ON ai_handoffs BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.thread_id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END') OR (name='conversation_revision_no_reset' AND sql='CREATE '||'TRIGGER conversation_revision_no_reset BEFORE UPDATE ON conversation_ownership_revisions
WHEN NEW.thread_id IS NOT OLD.thread_id OR NEW.revision<=OLD.revision BEGIN
 SELECT RAISE(ABORT,''ownership_revision_must_increase'');
END') OR (name='conversation_revision_no_delete' AND sql='CREATE '||'TRIGGER conversation_revision_no_delete BEFORE DELETE ON conversation_ownership_revisions BEGIN
 SELECT RAISE(ABORT,''ownership_revision_tombstone_required'');
END') OR (name='grooming_control_revision_no_reset' AND sql='CREATE '||'TRIGGER grooming_control_revision_no_reset BEFORE UPDATE ON grooming_effective_control_revision
WHEN NEW.id IS NOT OLD.id OR NEW.revision<=OLD.revision OR NEW.database_incarnation IS NOT OLD.database_incarnation BEGIN
 SELECT RAISE(ABORT,''control_revision_must_increase'');
END') OR (name='grooming_control_revision_no_delete' AND sql='CREATE '||'TRIGGER grooming_control_revision_no_delete BEFORE DELETE ON grooming_effective_control_revision BEGIN
 SELECT RAISE(ABORT,''control_revision_tombstone_required'');
END') OR (name='grooming_control_gce_goals_insert' AND sql='CREATE '||'TRIGGER grooming_control_gce_goals_insert AFTER INSERT ON gce_goals BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_gce_goals_update' AND sql='CREATE '||'TRIGGER grooming_control_gce_goals_update AFTER UPDATE ON gce_goals BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_gce_goals_delete' AND sql='CREATE '||'TRIGGER grooming_control_gce_goals_delete AFTER DELETE ON gce_goals BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_gce_budget_envelopes_insert' AND sql='CREATE '||'TRIGGER grooming_control_gce_budget_envelopes_insert AFTER INSERT ON gce_budget_envelopes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_gce_budget_envelopes_update' AND sql='CREATE '||'TRIGGER grooming_control_gce_budget_envelopes_update AFTER UPDATE ON gce_budget_envelopes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_gce_budget_envelopes_delete' AND sql='CREATE '||'TRIGGER grooming_control_gce_budget_envelopes_delete AFTER DELETE ON gce_budget_envelopes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_gce_constraints_insert' AND sql='CREATE '||'TRIGGER grooming_control_gce_constraints_insert AFTER INSERT ON gce_constraints BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_gce_constraints_update' AND sql='CREATE '||'TRIGGER grooming_control_gce_constraints_update AFTER UPDATE ON gce_constraints BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_gce_constraints_delete' AND sql='CREATE '||'TRIGGER grooming_control_gce_constraints_delete AFTER DELETE ON gce_constraints BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_audience_rollout_insert' AND sql='CREATE '||'TRIGGER grooming_control_ai_audience_rollout_insert AFTER INSERT ON ai_audience_rollout BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_audience_rollout_update' AND sql='CREATE '||'TRIGGER grooming_control_ai_audience_rollout_update AFTER UPDATE ON ai_audience_rollout BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_audience_rollout_delete' AND sql='CREATE '||'TRIGGER grooming_control_ai_audience_rollout_delete AFTER DELETE ON ai_audience_rollout BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_executive_runtime_config_insert' AND sql='CREATE '||'TRIGGER grooming_control_executive_runtime_config_insert AFTER INSERT ON executive_runtime_config BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_executive_runtime_config_update' AND sql='CREATE '||'TRIGGER grooming_control_executive_runtime_config_update AFTER UPDATE ON executive_runtime_config BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_executive_runtime_config_delete' AND sql='CREATE '||'TRIGGER grooming_control_executive_runtime_config_delete AFTER DELETE ON executive_runtime_config BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_kill_switches_insert' AND sql='CREATE '||'TRIGGER grooming_control_ai_kill_switches_insert AFTER INSERT ON ai_kill_switches BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_kill_switches_update' AND sql='CREATE '||'TRIGGER grooming_control_ai_kill_switches_update AFTER UPDATE ON ai_kill_switches BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_kill_switches_delete' AND sql='CREATE '||'TRIGGER grooming_control_ai_kill_switches_delete AFTER DELETE ON ai_kill_switches BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_assistant_profile_versions_insert' AND sql='CREATE '||'TRIGGER grooming_control_ai_assistant_profile_versions_insert AFTER INSERT ON ai_assistant_profile_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_assistant_profile_versions_update' AND sql='CREATE '||'TRIGGER grooming_control_ai_assistant_profile_versions_update AFTER UPDATE ON ai_assistant_profile_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_assistant_profile_versions_delete' AND sql='CREATE '||'TRIGGER grooming_control_ai_assistant_profile_versions_delete AFTER DELETE ON ai_assistant_profile_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_intent_versions_insert' AND sql='CREATE '||'TRIGGER grooming_control_ai_intent_versions_insert AFTER INSERT ON ai_intent_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_intent_versions_update' AND sql='CREATE '||'TRIGGER grooming_control_ai_intent_versions_update AFTER UPDATE ON ai_intent_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_intent_versions_delete' AND sql='CREATE '||'TRIGGER grooming_control_ai_intent_versions_delete AFTER DELETE ON ai_intent_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_prompt_policy_versions_insert' AND sql='CREATE '||'TRIGGER grooming_control_ai_prompt_policy_versions_insert AFTER INSERT ON ai_prompt_policy_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_prompt_policy_versions_update' AND sql='CREATE '||'TRIGGER grooming_control_ai_prompt_policy_versions_update AFTER UPDATE ON ai_prompt_policy_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_prompt_policy_versions_delete' AND sql='CREATE '||'TRIGGER grooming_control_ai_prompt_policy_versions_delete AFTER DELETE ON ai_prompt_policy_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_knowledge_source_versions_insert' AND sql='CREATE '||'TRIGGER grooming_control_ai_knowledge_source_versions_insert AFTER INSERT ON ai_knowledge_source_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_knowledge_source_versions_update' AND sql='CREATE '||'TRIGGER grooming_control_ai_knowledge_source_versions_update AFTER UPDATE ON ai_knowledge_source_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_knowledge_source_versions_delete' AND sql='CREATE '||'TRIGGER grooming_control_ai_knowledge_source_versions_delete AFTER DELETE ON ai_knowledge_source_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_whatsapp_conversation_routing_modes_insert' AND sql='CREATE '||'TRIGGER grooming_control_whatsapp_conversation_routing_modes_insert AFTER INSERT ON whatsapp_conversation_routing_modes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_whatsapp_conversation_routing_modes_update' AND sql='CREATE '||'TRIGGER grooming_control_whatsapp_conversation_routing_modes_update AFTER UPDATE ON whatsapp_conversation_routing_modes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_whatsapp_conversation_routing_modes_delete' AND sql='CREATE '||'TRIGGER grooming_control_whatsapp_conversation_routing_modes_delete AFTER DELETE ON whatsapp_conversation_routing_modes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_voice_sales_offers_insert' AND sql='CREATE '||'TRIGGER grooming_control_voice_sales_offers_insert AFTER INSERT ON voice_sales_offers BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_voice_sales_offers_update' AND sql='CREATE '||'TRIGGER grooming_control_voice_sales_offers_update AFTER UPDATE ON voice_sales_offers BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_voice_sales_offers_delete' AND sql='CREATE '||'TRIGGER grooming_control_voice_sales_offers_delete AFTER DELETE ON voice_sales_offers BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_lead_work_items_insert' AND sql='CREATE '||'TRIGGER grooming_control_lead_work_items_insert AFTER INSERT ON lead_work_items BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_lead_work_items_update' AND sql='CREATE '||'TRIGGER grooming_control_lead_work_items_update AFTER UPDATE ON lead_work_items BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_lead_work_items_delete' AND sql='CREATE '||'TRIGGER grooming_control_lead_work_items_delete AFTER DELETE ON lead_work_items BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_canonical_bookings_insert' AND sql='CREATE '||'TRIGGER grooming_control_canonical_bookings_insert AFTER INSERT ON canonical_bookings BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_canonical_bookings_update' AND sql='CREATE '||'TRIGGER grooming_control_canonical_bookings_update AFTER UPDATE OF id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,channel,total_amount,currency,pricing_json,created_by,created_at ON canonical_bookings BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_canonical_bookings_delete' AND sql='CREATE '||'TRIGGER grooming_control_canonical_bookings_delete AFTER DELETE ON canonical_bookings BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_lead_ownership_insert' AND sql='CREATE '||'TRIGGER grooming_control_ai_lead_ownership_insert AFTER INSERT ON ai_lead_ownership BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_lead_ownership_update' AND sql='CREATE '||'TRIGGER grooming_control_ai_lead_ownership_update AFTER UPDATE ON ai_lead_ownership BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_control_ai_lead_ownership_delete' AND sql='CREATE '||'TRIGGER grooming_control_ai_lead_ownership_delete AFTER DELETE ON ai_lead_ownership BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END') OR (name='grooming_installation_epoch_no_reset' AND sql='CREATE '||'TRIGGER grooming_installation_epoch_no_reset BEFORE UPDATE ON grooming_revision_installation_epoch
WHEN NEW.id IS NOT OLD.id OR NEW.epoch<=OLD.epoch OR NEW.incarnation IS NOT OLD.incarnation BEGIN
 SELECT RAISE(ABORT,''installation_epoch_must_increase'');
END') OR (name='grooming_installation_epoch_no_delete' AND sql='CREATE '||'TRIGGER grooming_installation_epoch_no_delete BEFORE DELETE ON grooming_revision_installation_epoch BEGIN
 SELECT RAISE(ABORT,''installation_epoch_tombstone_required'');
END')))=57 AND EXISTS(SELECT 1 FROM grooming_revision_installation WHERE id=1 AND schema_version=2));
-- Task4 REVIEW CANDIDATE. No mode/settings/enrollment changes.
-- Existing runtime-owned source tables must exist before installation.
-- Apply under the governed replay runner; partial installations MUST NOT issue authority.
-- SQLite tests are emulation only. Real hosted D1 trigger/batch proof required before wiring.
CREATE TABLE IF NOT EXISTS conversation_ownership_revisions (
  thread_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)
);
INSERT OR IGNORE INTO conversation_ownership_revisions(thread_id,revision)
  SELECT id,1 FROM communication_threads;
DROP TRIGGER IF EXISTS conversation_revision_insert;
CREATE TRIGGER IF NOT EXISTS conversation_revision_insert AFTER INSERT ON communication_threads BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(NEW.id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER IF EXISTS conversation_revision_update;
CREATE TRIGGER IF NOT EXISTS conversation_revision_update AFTER UPDATE OF id,customer_id,lead_id,booking_id,ticket_id,assigned_to,status ON communication_threads
WHEN NEW.id IS NOT OLD.id OR NEW.customer_id IS NOT OLD.customer_id OR NEW.lead_id IS NOT OLD.lead_id
  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.ticket_id IS NOT OLD.ticket_id
  OR NEW.assigned_to IS NOT OLD.assigned_to OR NEW.status IS NOT OLD.status
BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
  INSERT INTO conversation_ownership_revisions(thread_id,revision) SELECT NEW.id,1 WHERE NEW.id IS NOT OLD.id
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER IF EXISTS conversation_revision_delete;
CREATE TRIGGER IF NOT EXISTS conversation_revision_delete AFTER DELETE ON communication_threads BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER IF EXISTS conversation_handoff_revision_insert;
CREATE TRIGGER IF NOT EXISTS conversation_handoff_revision_insert AFTER INSERT ON ai_handoffs BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(NEW.thread_id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER IF EXISTS conversation_handoff_revision_update;
CREATE TRIGGER IF NOT EXISTS conversation_handoff_revision_update AFTER UPDATE OF thread_id,status,taken_over_by ON ai_handoffs
WHEN NEW.thread_id IS NOT OLD.thread_id OR NEW.status IS NOT OLD.status OR NEW.taken_over_by IS NOT OLD.taken_over_by
BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.thread_id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
  INSERT INTO conversation_ownership_revisions(thread_id,revision) SELECT NEW.thread_id,1 WHERE NEW.thread_id IS NOT OLD.thread_id
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END;
DROP TRIGGER IF EXISTS conversation_handoff_revision_delete;
CREATE TRIGGER IF NOT EXISTS conversation_handoff_revision_delete AFTER DELETE ON ai_handoffs BEGIN
  INSERT INTO conversation_ownership_revisions(thread_id,revision) VALUES(OLD.thread_id,1)
    ON CONFLICT(thread_id) DO UPDATE SET revision=revision+1;
END;

CREATE TABLE IF NOT EXISTS grooming_effective_control_revision (
 id INTEGER PRIMARY KEY CHECK(id=1),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
 database_incarnation TEXT NOT NULL CHECK(length(database_incarnation)>=32)
);
INSERT OR IGNORE INTO grooming_effective_control_revision VALUES(1,1,lower(hex(randomblob(32))));

DROP TRIGGER IF EXISTS conversation_revision_no_reset;
CREATE TRIGGER IF NOT EXISTS conversation_revision_no_reset BEFORE UPDATE ON conversation_ownership_revisions
WHEN NEW.thread_id IS NOT OLD.thread_id OR NEW.revision<=OLD.revision BEGIN
 SELECT RAISE(ABORT,'ownership_revision_must_increase');
END;
DROP TRIGGER IF EXISTS conversation_revision_no_delete;
CREATE TRIGGER IF NOT EXISTS conversation_revision_no_delete BEFORE DELETE ON conversation_ownership_revisions BEGIN
 SELECT RAISE(ABORT,'ownership_revision_tombstone_required');
END;
DROP TRIGGER IF EXISTS grooming_control_revision_no_reset;
CREATE TRIGGER IF NOT EXISTS grooming_control_revision_no_reset BEFORE UPDATE ON grooming_effective_control_revision
WHEN NEW.id IS NOT OLD.id OR NEW.revision<=OLD.revision OR NEW.database_incarnation IS NOT OLD.database_incarnation BEGIN
 SELECT RAISE(ABORT,'control_revision_must_increase');
END;
DROP TRIGGER IF EXISTS grooming_control_revision_no_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_revision_no_delete BEFORE DELETE ON grooming_effective_control_revision BEGIN
 SELECT RAISE(ABORT,'control_revision_tombstone_required');
END;
DROP TRIGGER IF EXISTS grooming_control_gce_goals_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_goals_insert AFTER INSERT ON gce_goals BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_gce_goals_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_goals_update AFTER UPDATE ON gce_goals BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_gce_goals_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_goals_delete AFTER DELETE ON gce_goals BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_gce_budget_envelopes_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_budget_envelopes_insert AFTER INSERT ON gce_budget_envelopes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_gce_budget_envelopes_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_budget_envelopes_update AFTER UPDATE ON gce_budget_envelopes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_gce_budget_envelopes_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_budget_envelopes_delete AFTER DELETE ON gce_budget_envelopes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_gce_constraints_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_constraints_insert AFTER INSERT ON gce_constraints BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_gce_constraints_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_constraints_update AFTER UPDATE ON gce_constraints BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_gce_constraints_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_gce_constraints_delete AFTER DELETE ON gce_constraints BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_audience_rollout_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_audience_rollout_insert AFTER INSERT ON ai_audience_rollout BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_audience_rollout_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_audience_rollout_update AFTER UPDATE ON ai_audience_rollout BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_audience_rollout_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_audience_rollout_delete AFTER DELETE ON ai_audience_rollout BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_executive_runtime_config_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_executive_runtime_config_insert AFTER INSERT ON executive_runtime_config BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_executive_runtime_config_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_executive_runtime_config_update AFTER UPDATE ON executive_runtime_config BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_executive_runtime_config_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_executive_runtime_config_delete AFTER DELETE ON executive_runtime_config BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_kill_switches_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_kill_switches_insert AFTER INSERT ON ai_kill_switches BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_kill_switches_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_kill_switches_update AFTER UPDATE ON ai_kill_switches BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_kill_switches_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_kill_switches_delete AFTER DELETE ON ai_kill_switches BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_assistant_profile_versions_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_assistant_profile_versions_insert AFTER INSERT ON ai_assistant_profile_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_assistant_profile_versions_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_assistant_profile_versions_update AFTER UPDATE ON ai_assistant_profile_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_assistant_profile_versions_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_assistant_profile_versions_delete AFTER DELETE ON ai_assistant_profile_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_intent_versions_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_intent_versions_insert AFTER INSERT ON ai_intent_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_intent_versions_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_intent_versions_update AFTER UPDATE ON ai_intent_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_intent_versions_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_intent_versions_delete AFTER DELETE ON ai_intent_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_prompt_policy_versions_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_prompt_policy_versions_insert AFTER INSERT ON ai_prompt_policy_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_prompt_policy_versions_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_prompt_policy_versions_update AFTER UPDATE ON ai_prompt_policy_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_prompt_policy_versions_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_prompt_policy_versions_delete AFTER DELETE ON ai_prompt_policy_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_knowledge_source_versions_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_knowledge_source_versions_insert AFTER INSERT ON ai_knowledge_source_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_knowledge_source_versions_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_knowledge_source_versions_update AFTER UPDATE ON ai_knowledge_source_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_knowledge_source_versions_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_knowledge_source_versions_delete AFTER DELETE ON ai_knowledge_source_versions BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_whatsapp_conversation_routing_modes_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_whatsapp_conversation_routing_modes_insert AFTER INSERT ON whatsapp_conversation_routing_modes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_whatsapp_conversation_routing_modes_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_whatsapp_conversation_routing_modes_update AFTER UPDATE ON whatsapp_conversation_routing_modes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_whatsapp_conversation_routing_modes_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_whatsapp_conversation_routing_modes_delete AFTER DELETE ON whatsapp_conversation_routing_modes BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_voice_sales_offers_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_voice_sales_offers_insert AFTER INSERT ON voice_sales_offers BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_voice_sales_offers_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_voice_sales_offers_update AFTER UPDATE ON voice_sales_offers BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_voice_sales_offers_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_voice_sales_offers_delete AFTER DELETE ON voice_sales_offers BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_lead_work_items_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_lead_work_items_insert AFTER INSERT ON lead_work_items BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_lead_work_items_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_lead_work_items_update AFTER UPDATE ON lead_work_items BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_lead_work_items_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_lead_work_items_delete AFTER DELETE ON lead_work_items BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_canonical_bookings_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_canonical_bookings_insert AFTER INSERT ON canonical_bookings BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_canonical_bookings_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_canonical_bookings_update AFTER UPDATE OF id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,channel,total_amount,currency,pricing_json,created_by,created_at ON canonical_bookings BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_canonical_bookings_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_canonical_bookings_delete AFTER DELETE ON canonical_bookings BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_lead_ownership_insert;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_lead_ownership_insert AFTER INSERT ON ai_lead_ownership BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_lead_ownership_update;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_lead_ownership_update AFTER UPDATE ON ai_lead_ownership BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;
DROP TRIGGER IF EXISTS grooming_control_ai_lead_ownership_delete;
CREATE TRIGGER IF NOT EXISTS grooming_control_ai_lead_ownership_delete AFTER DELETE ON ai_lead_ownership BEGIN
 UPDATE grooming_effective_control_revision SET revision=revision+1 WHERE id=1;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM grooming_effective_control_revision WHERE id=1) THEN 1 ELSE abs(-9223372036854775808) END;
END;

DROP TRIGGER IF EXISTS grooming_installation_epoch_no_reset;
CREATE TRIGGER IF NOT EXISTS grooming_installation_epoch_no_reset BEFORE UPDATE ON grooming_revision_installation_epoch
WHEN NEW.id IS NOT OLD.id OR NEW.epoch<=OLD.epoch OR NEW.incarnation IS NOT OLD.incarnation BEGIN
 SELECT RAISE(ABORT,'installation_epoch_must_increase');
END;
DROP TRIGGER IF EXISTS grooming_installation_epoch_no_delete;
CREATE TRIGGER IF NOT EXISTS grooming_installation_epoch_no_delete BEFORE DELETE ON grooming_revision_installation_epoch BEGIN
 SELECT RAISE(ABORT,'installation_epoch_tombstone_required');
END;
INSERT INTO grooming_revision_installation VALUES(1,2) ON CONFLICT(id) DO UPDATE SET schema_version=2;
