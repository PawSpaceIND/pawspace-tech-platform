import { chunkedIn } from "./d1-chunked-in";

type Row = Record<string, unknown>;

function newestCases(rows: Row[]): Row[] {
  return rows.sort((left, right) => Number(right.created_at) - Number(left.created_at)
    || (String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0));
}

/** Read customer complaints in the legacy ticket shape without copying their state. */
export async function bookingSupportCases(db: D1Database, bookingIds: string[]): Promise<Row[]> {
  const rows = newestCases(await chunkedIn([...new Set(bookingIds)], async (ids, placeholders) => {
    try {
      const result = await db.prepare(`SELECT id,booking_id,customer_id,case_type AS category,
        severity AS priority,status,title AS subject,description AS detail,
        COALESCE(owner_email,owner_team) AS owner,first_response_due_at AS sla_due_at,
        created_at,updated_at,resolved_at,reopen_count AS reopened_count,
        resolution_note AS resolution,status AS customer_status,'unified_case' AS source_kind
        FROM unified_cases WHERE case_type='customer_complaint' AND booking_id IN (${placeholders})
        ORDER BY created_at DESC,id`).bind(...ids).all<Row>();
      return result.results;
    } catch (error) {
      // Older installations may not have enabled the case module. A failed read
      // of an existing store must surface rather than masquerade as zero tickets.
      if (/no such table: (?:main\.)?unified_cases\b/i.test(error instanceof Error ? error.message : String(error))) return [];
      throw error;
    }
  }));
  return rows;
}
