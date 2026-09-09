// Read the list and its children in one D1 transaction, rather than two round trips per booking.
// Repeating the bounded selection inside the batch keeps all three reads on the same snapshot.
const recent = `SELECT b.*,c.name customer_name,w.id work_order_id,w.provider_name,w.provider_model,
  w.status work_order_status,w.occurrence_count,p.id payment_id,p.status payment_status,p.amount_due_now,p.gateway
  FROM canonical_bookings b JOIN canonical_customers c ON c.id=b.customer_id
  JOIN provider_work_orders w ON w.booking_id=b.id JOIN booking_payments p ON p.booking_id=b.id
  ORDER BY b.created_at DESC,b.id DESC LIMIT 100`;

export async function listCanonicalBookingsForAdmin(db: D1Database) {
  const [rows, pets, events] = await db.batch<Record<string, unknown>>([
    db.prepare(recent),
    db.prepare(`WITH recent AS (${recent}) SELECT b.id AS list_booking_id,p.id,p.name,p.species,p.breed,p.vaccination_status
      FROM recent b JOIN canonical_pets p ON p.customer_id=b.customer_id
      AND p.id IN (SELECT value FROM json_each(b.pet_ids_json)) ORDER BY p.name,p.id`),
    db.prepare(`WITH recent AS (${recent}) SELECT e.* FROM recent b
      JOIN booking_lifecycle_events e ON e.booking_id=b.id ORDER BY e.occurred_at,e.id`),
  ]);
  const petsByBooking = new Map<string, Record<string, unknown>[]>();
  const eventsByBooking = new Map<string, Record<string, unknown>[]>();
  for (const { list_booking_id, ...pet } of pets.results) {
    const key = String(list_booking_id);
    const list = petsByBooking.get(key) ?? [];
    list.push(pet); petsByBooking.set(key, list);
  }
  for (const event of events.results) {
    const key = String(event.booking_id);
    const list = eventsByBooking.get(key) ?? [];
    list.push(event); eventsByBooking.set(key, list);
  }
  return rows.results.map(row => ({ ...row,
    pets: petsByBooking.get(String(row.id)) ?? [],
    events: eventsByBooking.get(String(row.id)) ?? [],
  }));
}
