/** Local downloads retain exact source scope. Never invent filter or audit metadata. */
export function snapshotCsv(records: object[], metadata: Record<string, string>) {
  const cell = (value: unknown) => {
    let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    // Quoting alone does not prevent spreadsheet formula execution.
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const keys = [...new Set(records.flatMap(row => Object.keys(row)))];
  return [...Object.entries(metadata), [], keys, ...records.map(row => keys.map(key => (row as Record<string, unknown>)[key]))].map(row => row.map(cell).join(",")).join("\r\n");
}
export function downloadSnapshot(name: string, records: object[], metadata: Record<string, string>, format: "CSV" | "JSON" = "CSV") {
  const body = format === "CSV" ? snapshotCsv(records, metadata) : JSON.stringify({metadata, records}, null, 2);
  const url = URL.createObjectURL(new Blob([body], {type:format === "CSV" ? "text/csv;charset=utf-8" : "application/json"}));
  const link = document.createElement("a"); link.href = url; link.download = `${name}.${format.toLowerCase()}`;
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
