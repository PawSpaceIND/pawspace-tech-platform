type Row=Record<string,unknown>;
const group=(rows:Row[],key:string)=>{const out=new Map<string,Row[]>();for(const row of rows){const id=String(row[key]);const bucket=out.get(id)||[];bucket.push(row);out.set(id,bucket);}return out;};
/** Preserve every related row in the report, without five remote reads for each programme. */
export async function trainingReconciliationSnapshot(db:D1Database,programmes:Row[]){
 const ids=JSON.stringify(programmes.map(row=>String(row.id))),groups=JSON.stringify(programmes.map(row=>String(row.schedule_group_id))),bookings=JSON.stringify(programmes.map(row=>String(row.booking_id)));
 const [sessions,reservations,consumptions,earnings,quotes]=await Promise.all([
  db.prepare("SELECT programme_id,id,status,provider_id FROM training_sessions WHERE programme_id IN (SELECT value FROM json_each(?))").bind(ids).all<Row>(),
  db.prepare("SELECT group_id,id,status,provider_id FROM scheduling_reservations WHERE group_id IN (SELECT value FROM json_each(?)) AND status!='cancelled'").bind(groups).all<Row>(),
  db.prepare("SELECT programme_id,session_id FROM training_session_consumptions WHERE programme_id IN (SELECT value FROM json_each(?))").bind(ids).all<Row>(),
  db.prepare("SELECT programme_id,session_id,status,gross_earning FROM training_session_earnings WHERE programme_id IN (SELECT value FROM json_each(?))").bind(ids).all<Row>(),
  db.prepare("SELECT l.booking_id,l.quote_id,q.status quote_status,q.used_booking_id,q.sessions quote_sessions,q.total_amount quote_total,q.amount_due_now quote_due_now FROM training_booking_quote_links l LEFT JOIN training_commercial_quotes q ON q.id=l.quote_id WHERE l.booking_id IN (SELECT value FROM json_each(?))").bind(bookings).all<Row>(),
 ]);
 return {sessions:group(sessions.results,'programme_id'),reservations:group(reservations.results,'group_id'),consumptions:group(consumptions.results,'programme_id'),earnings:group(earnings.results,'programme_id'),quotes:new Map(quotes.results.map(row=>[String(row.booking_id),row]))};
}
