import { rangeDays, type DateRange } from "./analytics-visuals";
export type BookingSlice = DateRange & { serviceCode?: string; status?: string };
export function parseBookingSlice(params: URLSearchParams) {
  const slice = { from: params.get("from") || "", to: params.get("to") || "", serviceCode: params.get("serviceCode") || "", status: params.get("status") || "all" };
  if (rangeDays(slice) > 366) throw new Error("Choose 366 days or fewer.");
  if (slice.serviceCode && !/^[a-z0-9_-]{1,80}$/i.test(slice.serviceCode)) throw new Error("Invalid service.");
  if (!["all", "recognized", "completed", "cancelled", "other"].includes(slice.status)) throw new Error("Invalid booking status.");
  const offset = Number(params.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new Error("Invalid page.");
  return { ...slice, offset };
}
export async function analyticsBookings(db: D1Database, input: ReturnType<typeof parseBookingSlice>, cityId?: string) {
  const where = ["substr(scheduled_start,1,10)>=?", "substr(scheduled_start,1,10)<=?"], values: (string | number)[] = [input.from, input.to];
  if (input.serviceCode) { where.push("service_code=?"); values.push(input.serviceCode); }
  if (cityId) { where.push("lower(city_id)=?"); values.push(cityId); }
  if (input.status === "recognized") where.push("status NOT IN ('cancelled','draft')");
  if (input.status === "other") where.push("status NOT IN ('completed','cancelled')");
  if (["completed", "cancelled"].includes(input.status)) { where.push("status=?"); values.push(input.status); }
  const predicate = where.join(" AND ");
  const count = await db.prepare(`SELECT COUNT(*) total FROM canonical_bookings WHERE ${predicate}`).bind(...values).first<{ total: number }>();
  const rows = await db.prepare(`SELECT id,service_code,status,scheduled_start,total_amount,currency FROM canonical_bookings WHERE ${predicate} ORDER BY scheduled_start DESC,id DESC LIMIT 50 OFFSET ?`).bind(...values, input.offset).all();
  return { rows: rows.results, total: count?.total ?? 0, offset: input.offset, pageSize: 50, cityId: cityId || null };
}
