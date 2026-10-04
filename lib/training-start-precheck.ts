type Row=Record<string,unknown>;
/** Workbook policy is attached to new automatic bookings; historical assigned programmes retain their contract. */
export async function trainingStartPrecheck(db:D1Database,row:Row){
 const present=await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduling_assignment_decisions'").first();
 if(!present)return null;
 const policy=await db.prepare("SELECT d.shortlist_json FROM scheduling_assignment_decisions d JOIN canonical_bookings b ON b.schedule_group_id=d.group_id WHERE b.id=?").bind(row.booking_id).first<Row>();
 let required=false;try{required=JSON.parse(String(policy?.shortlist_json||'{}')).trainingDispatchVersion===1;}catch{}
 if(!required)return null;
 const sql="EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND provider_id=? AND json_extract(attendance_json,'$.mode') IN ('parent','trainer_led') AND json_extract(attendance_json,'$.safeAreaConfirmed')=1 AND (json_extract(attendance_json,'$.mode')!='parent' OR json_extract(attendance_json,'$.parentOrCaretakerConfirmed')=1)) AND EXISTS(SELECT 1 FROM training_session_media_links l JOIN service_media_assets a ON a.id=l.media_id WHERE l.session_id=? AND l.provider_id=? AND l.booking_id=? AND a.booking_id=l.booking_id AND a.provider_id=l.provider_id AND a.purpose='before_service' AND a.access_status IN ('quarantined','ready') AND a.retention_status='active' AND a.synthetic=0 AND a.scan_status!='infected' AND COALESCE(a.review_status,'')!='rejected')";
 const binds=[row.id,row.provider_id,row.id,row.provider_id,row.booking_id];
 if(!await db.prepare(`SELECT 1 WHERE ${sql}`).bind(...binds).first())throw new Response(JSON.stringify({error:'Save attendance and safety, then capture the before photo before starting this session',code:'training_start_precheck_required'}),{status:409,headers:{'content-type':'application/json'}});
 return{sql,binds};
}
