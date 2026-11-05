import { AppError } from "./store.js";
import { runPython } from "./python-worker.js";

export type ArtifactFile = { data: string; mimeType: string; name: string };
export type DataValue = string | number | boolean | null;
type Row = Record<string, DataValue>;
type Chart = { type: "bar" | "line" | "scatter" | "histogram"; x?: string; y?: string; title?: string; bins?: number };
export type ExportFileInput = { format: "csv" | "pdf"; filename?: string; title?: string; columns?: string[]; rows?: DataValue[][]; text?: string };
export type AnalyzeDataInput = {
  rows: Row[]; operation?: "describe" | "group" | "correlation"; columns?: string[];
  group_by?: string; value_column?: string; aggregation?: "sum" | "mean" | "count"; chart?: Chart;
};
export type AnalysisResult = { text: string; images: ArtifactFile[]; files: ArtifactFile[] };
const MAX_BYTES = 8 * 1024 * 1024;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, `${label} must be an object.`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AppError(400, `${label} contains unsupported fields.`);
}
function text(value: unknown, label: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > maximum || value.includes("\0"))
    throw new AppError(400, `${label} must be text of at most ${maximum} characters.`);
  return value;
}
function scalar(value: unknown): DataValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e100) return value;
  if (typeof value === "string" && value.length <= 4096 && !value.includes("\0")) return value;
  throw new AppError(400, "Table cells must be short text, finite numbers, booleans, or null.");
}
function columns(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw new AppError(400, "Choose between 1 and 30 table columns.");
  const names = value.map((item) => text(item, "Column name", 120)!);
  if (new Set(names).size !== names.length || names.some((name) => ["__proto__", "prototype", "constructor"].includes(name)))
    throw new AppError(400, "Column names must be unique ordinary names.");
  return names;
}
function filename(value: unknown, format: "csv" | "pdf"): string {
  if (value !== undefined) text(value, "Filename", 255);
  const base = String(value || "family-agent-export").split(/[\\/]/).at(-1)!
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069:*?"<>|]/g, "").replace(/\.[^.]*$/, "").trim().replace(/^\.+/, "").trim().slice(0, 100);
  return `${base || "family-agent-export"}.${format}`;
}
function resultFile(value: unknown, expected: string): ArtifactFile {
  const file = object(value, "Generated file");
  if (file.mimeType !== expected || typeof file.data !== "string" || typeof file.name !== "string"
    || file.data.length > 4 * Math.ceil(MAX_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.data))
    throw new AppError(400, "The generated file is invalid or too large.");
  const bytes = Buffer.from(file.data, "base64");
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString("base64") !== file.data
    || (expected === "application/pdf" && bytes.subarray(0, 5).toString() !== "%PDF-")
    || (expected === "image/png" && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))))
    throw new AppError(400, "The generated file is invalid or too large.");
  return { data: file.data, mimeType: expected, name: expected === "application/pdf" ? filename(file.name, "pdf") : "analysis.png" };
}

/** Produces CSV directly or sends only structured content to the fixed local PDF renderer. */
export async function exportFile(input: unknown, signal?: AbortSignal): Promise<ArtifactFile> {
  if (signal?.aborted) throw new AppError(409, "The export was cancelled.");
  const value = object(input, "File export");
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw new AppError(413, "The export data is too large.");
  fields(value, ["format", "filename", "title", "columns", "rows", "text"], "File export");
  if (value.format !== "csv" && value.format !== "pdf") throw new AppError(400, "Choose CSV or PDF export.");
  const name = filename(value.filename, value.format), title = text(value.title, "Title", 200, true), content = text(value.text, "Document text", 48_000, true);
  const names = value.columns === undefined ? undefined : columns(value.columns);
  let rows: DataValue[][] | undefined;
  if (value.rows !== undefined) {
    if (!names || !Array.isArray(value.rows) || value.rows.length > 5000) throw new AppError(400, "Tables need column names and at most 5,000 rows.");
    rows = value.rows.map((row) => {
      if (!Array.isArray(row) || row.length !== names.length) throw new AppError(400, "Every table row must match the column count.");
      return row.map(scalar);
    });
  }
  if (value.format === "csv") {
    if (!names || !rows) throw new AppError(400, "CSV export needs column names and rows.");
    const cell = (item: DataValue) => {
      let field = item === null ? "" : String(item);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(field))
        throw new AppError(400, "CSV text cannot contain control characters.");
      // Quoting alone does not prevent spreadsheet formula execution.
      if (typeof item === "string" && (/^[\s]*[=+\-@]/.test(field) || /^[\t\r\n]/.test(field))) field = "'" + field;
      return `"${field.replaceAll('"', '""')}"`;
    };
    const bytes = Buffer.from("\uFEFF" + [names, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n", "utf8");
    if (bytes.length > MAX_BYTES) throw new AppError(413, "The exported file is larger than 8 MiB.");
    return { data: bytes.toString("base64"), mimeType: "text/csv", name };
  }
  if (!content?.trim() && !names) throw new AppError(400, "PDF export needs document text or a table.");
  if (names && !rows) throw new AppError(400, "PDF table export needs rows.");
  if (rows && rows.length > 1000) throw new AppError(400, "PDF tables support at most 1,000 rows. Use CSV for larger tables.");
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw new AppError(413, "The export data is too large.");
  return resultFile(await runPython({ task: "pdf", filename: name, title, text: content, columns: names, rows }, signal), "application/pdf");
}

/** Declarative statistics and plots, with no user-supplied Python program or filesystem path. */
export async function analyzeData(input: unknown, signal?: AbortSignal): Promise<AnalysisResult> {
  if (signal?.aborted) throw new AppError(409, "The analysis was cancelled.");
  const value = object(input, "Data analysis");
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) throw new AppError(413, "The analysis data is too large.");
  fields(value, ["rows", "operation", "columns", "group_by", "value_column", "aggregation", "chart"], "Data analysis");
  if (!Array.isArray(value.rows) || !value.rows.length || value.rows.length > 5000) throw new AppError(400, "Analysis needs between 1 and 5,000 data rows.");
  const rows = value.rows.map((item) => {
    const raw = object(item, "Data row");
    const result: Row = Object.create(null);
    for (const key of columns(Object.keys(raw))) result[key] = scalar(raw[key]);
    return result;
  });
  const keys = columns([...new Set(rows.flatMap((row) => Object.keys(row)))]);
  for (const row of rows) for (const key of keys) if (!(key in row)) row[key] = null;
  const selected = value.columns === undefined ? undefined : columns(value.columns);
  const key = (item: unknown, label: string, optional = false) => {
    const name = text(item, label, 120, optional);
    if (name !== undefined && !keys.includes(name)) throw new AppError(400, `${label} is not present in the data.`);
    return name;
  };
  if (selected?.some((name) => !keys.includes(name))) throw new AppError(400, "An analysis column is not present in the data.");
  const operation = value.operation ?? "describe";
  if (!["describe", "group", "correlation"].includes(String(operation))) throw new AppError(400, "Choose describe, group, or correlation analysis.");
  const groupBy = key(value.group_by, "Group column", operation !== "group"), aggregate = value.aggregation ?? "sum";
  if (!["sum", "mean", "count"].includes(String(aggregate))) throw new AppError(400, "Choose sum, mean, or count aggregation.");
  const valueColumn = key(value.value_column, "Value column", operation !== "group" || aggregate === "count");
  if (operation === "correlation" && (selected?.length ?? keys.length) < 2) throw new AppError(400, "Correlation needs at least two numeric columns.");
  let chart: Chart | undefined;
  if (value.chart !== undefined) {
    const raw = object(value.chart, "Chart"); fields(raw, ["type", "x", "y", "title", "bins"], "Chart");
    if (!["bar", "line", "scatter", "histogram"].includes(String(raw.type))) throw new AppError(400, "Choose bar, line, scatter, or histogram chart.");
    if (raw.bins !== undefined && (!Number.isInteger(raw.bins) || Number(raw.bins) < 5 || Number(raw.bins) > 100)) throw new AppError(400, "Histogram bins must be between 5 and 100.");
    chart = { type: raw.type as Chart["type"], x: key(raw.x, "Chart X column", true), y: key(raw.y, "Chart Y column", true), title: text(raw.title, "Chart title", 160, true), bins: raw.bins as number | undefined };
  }
  const task = { task: "analysis", rows, operation, columns: selected, group_by: groupBy, value_column: valueColumn, aggregation: aggregate, chart };
  const result = object(await runPython(task, signal), "Analysis result");
  const statistics = JSON.stringify(result.statistics, null, 2);
  if (!statistics || statistics.length > 128_000 || !Array.isArray(result.images) || result.images.length > 1) throw new AppError(400, "The analysis output is invalid or too large.");
  return { text: statistics, images: result.images.map((image) => resultFile(image, "image/png")), files: [] };
}
