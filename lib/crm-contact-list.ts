/*
 * The CRM contact list query, and the only place it is written.
 *
 * It sits in lib rather than inline in app/api/crm so that a test can import and run the real
 * statement instead of scraping it out of the route as text. Reading SQL out of source and executing
 * it works, but it does not survive contact with escaping: `\\` is one backslash to the TypeScript
 * parser and two to whoever reads the file, and SQLite rejects a two-character ESCAPE expression.
 * Imported, the string is simply the string.
 *
 * WHY THE UNCLAIMED BRANCH EXISTS. An unclaimed lead belongs to nobody, not to somebody else, so it
 * must not be hidden from everybody. Nine paths insert into crm_contacts and only two - app/api/crm
 * and app/api/public-contact - write city_id/team_code/department_code. The other seven (WhatsApp via
 * interakt, chat via haptik, inbound AI capture, admin data ingest, system integration, revenue-crm,
 * and a booking creating its own contact) leave all three NULL, and an equality test over
 * COALESCE(col,'') can never match a real scope. Every lead from those seven was invisible to every
 * scoped user while sitting in the table: reported as "lead not found in CRM", and true. Inventing a
 * city for a WhatsApp lead that never stated one would be worse - it would look assigned while nobody
 * worked it. A contact carrying ANOTHER city's scope is still filtered out; only the unclaimed return.
 *
 * WHY SEARCH IS HERE AND NOT IN THE PAGE. app/crm/page.tsx filtered the array it had been given, so a
 * lead outside the newest 100 by updated_at could not be found by typing its name or number - the
 * loaded page was the whole searchable universe.
 *
 * Every placeholder is anonymous, because SQLite gives a bare ? that follows a numbered one an index
 * nobody intends, and D1 binds positionally. Each filter is switched on by a bound flag so the SQL
 * stays one constant statement: tests/crm-stack-hardening prepares every statement in the CRM stack
 * against the real DDL to catch a mistyped column, and it scrapes source text, so a query assembled
 * from variables at runtime would silently drop out of that audit.
 */
export const CRM_CONTACT_LIST_SQL=`SELECT * FROM crm_contacts
     WHERE (?=0
            OR (lower(COALESCE(city_id,''))=? AND lower(COALESCE(team_code,''))=? AND lower(COALESCE(department_code,''))=?)
            OR (COALESCE(TRIM(city_id),'')='' AND COALESCE(TRIM(team_code),'')='' AND COALESCE(TRIM(department_code),'')=''))
       AND (?=0
            OR lower(COALESCE(name,'')) LIKE ? ESCAPE '\\'
            OR lower(COALESCE(primary_phone,'')) LIKE ? ESCAPE '\\'
            OR lower(COALESCE(email,'')) LIKE ? ESCAPE '\\'
            OR lower(id) LIKE ? ESCAPE '\\')
     ORDER BY updated_at DESC LIMIT 100`;

/** Bind order for CRM_CONTACT_LIST_SQL: scope flag, the three scope values, search flag, term x4. */
export function crmContactListBinds(scope:{cityId:string;teamCode:string;departmentCode:string}|null,search:string){
 const like=`%${search.toLowerCase().replace(/[\\%_]/g,c=>`\\${c}`)}%`;
 return [scope?1:0,scope?.cityId??"",scope?.teamCode??"",scope?.departmentCode??"",search?1:0,like,like,like,like];
}
