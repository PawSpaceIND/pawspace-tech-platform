import{ensureProviderCapacityTables}from"./provider-capacity-governance";
import{ensureProviderWorkspaceTables}from"./provider-workspace";
import{ensureCommercialTermsTables}from"./provider-commercial-terms";
import{ensureCrmPipelineTables}from"./crm-pipeline-forecast";

type Db=D1Database;

/**
 * D1 trigger installed before a payment link is handed to the customer. The canonical Razorpay webhook
 * owns the booking_payments.status='captured' transition; this trigger makes that signed transition the
 * only event that can promote an autonomous provisional booking and broadcast it to providers.
 *
 * IDs are deterministic from booking/provider identity so webhook retries remain idempotent.
 */
export async function ensureAutonomousBookingCaptureTrigger(db:Db){
 await ensureProviderCapacityTables(db);
 await ensureProviderWorkspaceTables(db);
 await ensureCommercialTermsTables(db);
 await ensureCrmPipelineTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS autonomous_slot_holds (booking_id TEXT PRIMARY KEY,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'provisional',expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS autonomous_provider_broadcasts (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'offered',payout_amount REAL NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,UNIQUE(booking_id,provider_id))"),
  db.prepare("CREATE TABLE IF NOT EXISTS autonomous_booking_events (id TEXT PRIMARY KEY,booking_id TEXT,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
 ]);
 await db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_autonomous_payment_captured
AFTER UPDATE OF status ON booking_payments
WHEN NEW.status='captured' AND OLD.status<>'captured'
BEGIN
  UPDATE canonical_bookings
     SET status='confirmed',updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
   WHERE id=NEW.booking_id
     AND status='provisional_awaiting_payment'
     AND channel='voice'
     AND EXISTS(SELECT 1 FROM autonomous_slot_holds h WHERE h.booking_id=NEW.booking_id);

  UPDATE autonomous_slot_holds
     SET status='confirmed',expires_at=CAST(strftime('%s','now') AS INTEGER)*1000+900000,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
   WHERE booking_id=NEW.booking_id AND status='provisional';

  UPDATE crm_opportunities
     SET stage='won',status='won',amount=(SELECT total_amount FROM canonical_bookings WHERE id=NEW.booking_id),
         amount_basis='captured_booking',stage_probability=1,next_best_action='Booking confirmed; provider assignment in progress',
         next_action_at=NULL,won_booking_id=NEW.booking_id,lost_reason=NULL,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
   WHERE id=(
     SELECT o.id FROM crm_opportunities o JOIN canonical_bookings b ON b.id=NEW.booking_id
      WHERE o.customer_id=b.customer_id AND o.service_code=b.service_code AND o.status='open'
      ORDER BY o.updated_at DESC LIMIT 1
   );

  INSERT OR IGNORE INTO crm_opportunities
    (id,lead_id,customer_id,service_code,owner,stage,status,amount,amount_basis,stage_probability,next_best_action,next_action_at,won_booking_id,lost_reason,source,created_by,created_at,updated_at)
  SELECT 'OPP-AUTO-'||b.id,NULL,b.customer_id,b.service_code,'AI Voice','won','won',b.total_amount,'captured_booking',1,
         'Booking confirmed; provider assignment in progress',NULL,b.id,NULL,'autonomous_voice_booking','system:payment-capture',
         CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000
    FROM canonical_bookings b
   WHERE b.id=NEW.booking_id AND b.status='confirmed'
     AND NOT EXISTS(SELECT 1 FROM crm_opportunities o WHERE o.won_booking_id=b.id OR (o.customer_id=b.customer_id AND o.service_code=b.service_code AND o.status='won' AND o.won_booking_id=b.id));

  INSERT OR IGNORE INTO crm_opportunity_stage_history
    (id,opportunity_id,from_stage,to_stage,probability,amount,reason,actor_id,created_at)
  SELECT 'OPH-AUTO-'||b.id,COALESCE((SELECT o.id FROM crm_opportunities o WHERE o.won_booking_id=b.id ORDER BY o.updated_at DESC LIMIT 1),'OPP-AUTO-'||b.id),
         NULL,'won',1,b.total_amount,'Signed payment capture confirmed autonomous booking','system:payment-capture',CAST(strftime('%s','now') AS INTEGER)*1000
    FROM canonical_bookings b WHERE b.id=NEW.booking_id AND b.status='confirmed';

  INSERT OR IGNORE INTO provider_job_offers(id,provider_id,booking_id,status,offered_at,expires_at,detail_json)
  SELECT 'OFR-AUTO-'||b.id||'-'||p.id,p.id,b.id,'offered',
         CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000+900000,
         json_object(
           'serviceCode',b.service_code,'packageCode',b.package_code,'packageName',b.package_name,
           'scheduledStart',b.scheduled_start,'scheduledEnd',b.scheduled_end,
           'petProfileJson',COALESCE((SELECT json_group_array(json_object('id',cp.id,'name',cp.name,'species',cp.species,'breed',cp.breed)) FROM canonical_pets cp JOIN json_each(b.pet_ids_json) j ON j.value=cp.id),'[]'),
           'address',(SELECT address_text FROM booking_service_locations l WHERE l.booking_id=b.id),
           'latitude',(SELECT latitude FROM booking_service_locations l WHERE l.booking_id=b.id),
           'longitude',(SELECT longitude FROM booking_service_locations l WHERE l.booking_id=b.id),
           'payoutAmount',COALESCE((SELECT ROUND(CASE WHEN t.engagement_model='direct_employee' THEN 0 WHEN t.engagement_model='commission_standard' THEN b.total_amount*100.0/118.0*t.provider_share_pct ELSE b.total_amount*t.provider_share_pct END,2) FROM provider_commercial_terms t WHERE t.service_code=b.service_code AND t.status='active' AND t.effective_from<=substr(b.scheduled_start,1,10) AND (t.provider_id=p.id OR t.provider_id IS NULL) ORDER BY CASE WHEN t.provider_id=p.id THEN 0 ELSE 1 END,t.effective_from DESC,t.version DESC LIMIT 1),0),
           'source','autonomous_booking_confirmed'
         )
    FROM canonical_bookings b JOIN provider_capacity_profiles p ON p.city_id=b.city_id
   WHERE b.id=NEW.booking_id AND b.status='confirmed' AND b.provider_id='unassigned'
     AND p.live=1 AND p.status='active'
     AND EXISTS(SELECT 1 FROM json_each(p.services_json) s WHERE s.value=b.service_code)
     AND EXISTS(SELECT 1 FROM json_each(p.zones_json) z WHERE z.value=b.zone_id)
     AND NOT EXISTS(SELECT 1 FROM provider_unavailability u WHERE u.provider_id=p.id AND u.status='active' AND u.starts_at<b.scheduled_end AND u.ends_at>b.scheduled_start)
     AND NOT EXISTS(SELECT 1 FROM canonical_bookings x WHERE x.id<>b.id AND x.provider_id=p.id AND x.status NOT IN ('cancelled','completed','draft','failed') AND x.scheduled_start<b.scheduled_end AND x.scheduled_end>b.scheduled_start);

  INSERT OR IGNORE INTO autonomous_provider_broadcasts(id,booking_id,provider_id,status,payout_amount,detail_json,offered_at,expires_at)
  SELECT 'APB-AUTO-'||o.booking_id||'-'||o.provider_id,o.booking_id,o.provider_id,'offered',
         COALESCE(json_extract(o.detail_json,'$.payoutAmount'),0),o.detail_json,o.offered_at,o.expires_at
    FROM provider_job_offers o
   WHERE o.booking_id=NEW.booking_id AND o.status='offered';

  INSERT OR IGNORE INTO autonomous_booking_events(id,booking_id,event_type,actor_id,detail_json,created_at)
  SELECT 'ABE-CAPTURE-'||b.id,b.id,'payment.captured','system:payment-capture',
         json_object('paymentId',NEW.id,'crmStage','won','providerOffers',(SELECT COUNT(*) FROM provider_job_offers o WHERE o.booking_id=b.id AND o.status='offered')),
         CAST(strftime('%s','now') AS INTEGER)*1000
    FROM canonical_bookings b WHERE b.id=NEW.booking_id AND b.status='confirmed';
END;
 `);
}
