// In-memory synthetic fixture only; never publishes a live caregiver rate.
export async function publishStayRates(w, service, packageCode) {
 const terms = await import('../../lib/provider-commercial-terms.ts');
 const pricing = await import('../../lib/provider-service-pricing.ts');
 await terms.ensureCommercialTermsTables(w.db); await pricing.ensureProviderServicePricingTables(w.db);
 for (const p of w.sqlite.prepare("SELECT id,city_id,zones_json FROM provider_capacity_profiles WHERE live=1 AND status='active'").all()) {
  w.sqlite.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES (?,?,?,1,'active','commission_standard',.70,'provider_gst_on_behalf',.18,0,0,0,12,'2026-01-01','synthetic stay rate','maker','checker','TEST',1,1)").run('stay-term-'+service+'-'+p.id,service,p.id);
  for (const zone of JSON.parse(p.zones_json)) await pricing.saveProviderServiceRate(w.db,{providerId:p.id,serviceCode:service,packageCode:service==='pet_sitting'?'sitting-4h':packageCode,cityId:p.city_id,zoneId:zone,rate:7999,floorPrice:0,actorId:p.id});
 }
}
