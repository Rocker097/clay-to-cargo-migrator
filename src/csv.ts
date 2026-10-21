// Minimal RFC 4180 CSV reader/writer, so the tool has no runtime dependencies.

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      if (record.some((f) => f !== "")) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== "" || record.length) {
    record.push(field);
    if (record.some((f) => f !== "")) records.push(record);
  }
  const [headers = [], ...body] = records;
  const rows = body.map((r) => Object.fromEntries(headers.map((h, i) => [h.trim(), r[i] ?? ""])));
  return { headers: headers.map((h) => h.trim()), rows };
}
