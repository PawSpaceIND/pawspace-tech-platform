/** Current date-only Pricing Control rows. A catalogue preview is not a future booking quote. */
export async function currentGroomingCatalogue(db:D1Database,asOf=Date.now()){
 if(!Number.isFinite(asOf))throw new Error('A valid catalogue observation time is required');
 // Match the existing Pricing Control effective-day convention (ISO date, inclusive end day).
 const day=new Date(asOf).toISOString().slice(0,10);
 const result=await db.prepare("SELECT * FROM service_packages WHERE service_code='grooming' AND active=1 AND date(effective_from)=effective_from AND effective_from<=? AND (effective_to IS NULL OR (date(effective_to)=effective_to AND effective_to>=?)) ORDER BY base_price,package_code").bind(day,day).all<Record<string,unknown>>();
 return result.results;
}
