type Row=Record<string,unknown>;

export async function finalizeSittingRecoveryAcceptance(db:D1Database,bookingId:string,actorId:string){
 const booking=await db.prepare("SELECT b.id,b.provider_id,b.status,b.schedule_group_id,w.provider_id work_order_provider_id,w.status work_order_status FROM canonical_bookings b LEFT JOIN provider_work_orders w ON w.booking_id=b.id WHERE b.id=? AND b.service_code='pet_sitting'").bind(bookingId).first<Row>();
 if(!booking)throw new Response("Canonical Sitting booking not found",{status:404});
 if(String(booking.status)!=="assigned")throw new Response("Replacement sitter acceptance is required before recovery finalization",{status:409});
 const recovery=await db.prepare("SELECT id,replacement_provider_id,status FROM sitting_recovery_cases WHERE booking_id=? ORDER BY opened_at DESC LIMIT 1").bind(bookingId).first<Row>();
 if(!recovery)throw new Response("No Sitting recovery case exists",{status:409});
 const providerId=String(booking.provider_id),replacementId=String(recovery.replacement_provider_id||""),groupId=String(booking.schedule_group_id||"");
 if(!replacementId||replacementId!==providerId||String(booking.work_order_provider_id)!==providerId)throw new Response("Accepted recovery provider is inconsistent across canonical records",{status:409});
 const offer=await db.prepare("SELECT provider_id,status FROM provider_assignment_offers WHERE group_id=?").bind(groupId).first<Row>();
 if(!offer||String(offer.provider_id)!==providerId||String(offer.status)!=="accepted")throw new Response("Accepted replacement sitter offer is required before recovery finalization",{status:409});
 const decision=await db.prepare("SELECT selected_provider_id,status FROM scheduling_assignment_decisions WHERE group_id=?").bind(groupId).first<Row>();
 if(!decision||String(decision.selected_provider_id)!==providerId)throw new Response("Accepted replacement sitter is inconsistent with scheduling",{status:409});
 const reservations=await db.prepare("SELECT provider_id,status FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").bind(groupId).all<Row>();
 if(reservations.results.length!==1||String(reservations.results[0].provider_id)!==providerId)throw new Response("Accepted replacement sitter is inconsistent with the canonical reservation",{status:409});
 const now=Date.now();await db.batch([
  db.prepare("UPDATE canonical_bookings SET status='assigned',updated_at=? WHERE id=?").bind(now,bookingId),
  db.prepare("UPDATE provider_work_orders SET status='accepted',updated_at=? WHERE booking_id=? AND provider_id=?").bind(now,bookingId,providerId),
  db.prepare("UPDATE scheduling_assignment_decisions SET status='assigned',actor_id=?,reason='Replacement sitter accepted',updated_at=? WHERE group_id=? AND selected_provider_id=?").bind(actorId,now,groupId,providerId),
  db.prepare("UPDATE scheduling_reservations SET status='assigned' WHERE group_id=? AND provider_id=? AND status!='cancelled'").bind(groupId,providerId),
 ]);
 return{bookingId:String(booking.id),providerId,status:"assigned",bookingPreserved:true};
}
