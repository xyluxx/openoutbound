/**
 * Turns import input (CSV text, XLSX bytes, JSON, row objects, a CSV URL) into a table of
 * string cells with headers. Imported content is untrusted: it is only parsed, never executed.
 */
import { parse as parseCsv } from "csv-parse/sync";
import { readSheet } from "read-excel-file/node";
import type { OpContext } from "../../../core/context.js";
import { invalid, OpenOutboundError } from "../../../core/errors.js";

export const MAX_IMPORT_ROWS = 50_000;
const MAX_URL_BYTES = 20 * 1024 * 1024;

export interface ParsedTable {
  headers: string[];
  /** One record per data row, keyed by header. */
  rows: Array<Record<string, string>>;
  /** Row number shown to users for rows[i] is i + firstRowNumber (spreadsheet numbering). */
  firstRowNumber: number;
  /** Detected CSV delimiter, when CSV. */
  delimiter?: string;
}

const DELIMITERS = [",", ";", "\t", "|"];

function pushCounts(counts: number[][], current: number[]): void {
  for (const [index, n] of current.entries()) counts[index]?.push(n);
}

/** Guesses the CSV delimiter from the first records (quote-aware). */
export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  const counts: number[][] = DELIMITERS.map(() => []);
  let current = DELIMITERS.map(() => 0);
  let inQuotes = false;
  let records = 0;
  for (let i = 0; i < sample.length && records < 10; i++) {
    const char = sample[i];
    if (char === '"') {
      if (inQuotes && sample[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === "\n") {
      if (current.some((n) => n > 0)) {
        pushCounts(counts, current);
        records++;
      }
      current = DELIMITERS.map(() => 0);
      continue;
    }
    const index = DELIMITERS.indexOf(char ?? "");
    if (index !== -1) current[index] = (current[index] ?? 0) + 1;
  }
  if (current.some((n) => n > 0)) pushCounts(counts, current);
  let best = ",";
  let bestScore = 0;
  DELIMITERS.forEach((delimiter, index) => {
    const values = counts[index] ?? [];
    if (values.length === 0) return;
    const min = Math.min(...values);
    const consistent = values.every((v) => v === values[0]);
    const score = min === 0 ? 0 : consistent ? min * 10 + 1 : min;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  });
  return best;
}

/** Unique, non-empty header names ("" -> "column_3", duplicates get " (2)"). */
export function uniqueHeaders(raw: unknown[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((value, index) => {
    const base =
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim() || `column_${index + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function tableFromMatrix(matrix: unknown[][], firstRowNumber: number): ParsedTable {
  const headerIndex = matrix.findIndex((row) => row.some((cell) => cellText(cell).trim() !== ""));
  if (headerIndex === -1) return { headers: [], rows: [], firstRowNumber };
  const headers = uniqueHeaders(matrix[headerIndex] ?? []);
  const rows: Array<Record<string, string>> = [];
  const dataStart = headerIndex + 1;
  for (let i = dataStart; i < matrix.length; i++) {
    const cells = matrix[i] ?? [];
    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      record[header] = cellText(cells[column]);
    });
    rows.push(record);
  }
  checkRowCount(rows.length);
  return { headers, rows, firstRowNumber: firstRowNumber + dataStart };
}

function checkRowCount(count: number): void {
  if (count > MAX_IMPORT_ROWS) {
    throw new OpenOutboundError(
      "validation_failed",
      `The file has ${count} rows; the limit is ${MAX_IMPORT_ROWS}.`,
      {
        hint: `Split the file into parts of at most ${MAX_IMPORT_ROWS} rows and import them one by one.`,
      },
    );
  }
}

/** CSV text (BOM, quoted newlines, any common delimiter). Header = first non-empty row. */
export function parseCsvText(text: string, delimiter?: string): ParsedTable {
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const chosen = delimiter ?? sniffDelimiter(content);
  let matrix: string[][];
  try {
    matrix = parseCsv(content, {
      bom: true,
      delimiter: chosen,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    });
  } catch (error) {
    throw new OpenOutboundError(
      "validation_failed",
      `The CSV could not be parsed: ${(error as Error).message}`,
      {
        hint: "Check the file is plain CSV (UTF-8). Pass `delimiter` if it uses an unusual separator.",
      },
    );
  }
  // Skipped empty lines shift numbering slightly; row numbers are best effort for CSV.
  return { ...tableFromMatrix(matrix, 1), delimiter: chosen };
}

/** XLSX bytes (base64 in operation inputs). Reads the first sheet unless `sheet` is given. */
export async function parseXlsx(bytes: Buffer, sheet?: string | number): Promise<ParsedTable> {
  let matrix: unknown[][];
  try {
    matrix = (await readSheet(bytes, sheet ?? 1)) as unknown[][];
  } catch (error) {
    throw new OpenOutboundError(
      "validation_failed",
      `The XLSX file could not be read: ${(error as Error).message}`,
      {
        hint: "Send the file as base64 in `content` with source xlsx, or export it as CSV and import that.",
      },
    );
  }
  return tableFromMatrix(matrix, 1);
}

/** Flattens nested objects into "a.b" keys (arrays of scalars are joined with ", "). */
export function flattenRecord(
  value: Record<string, unknown>,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      inner !== null &&
      typeof inner === "object" &&
      !Array.isArray(inner) &&
      !(inner instanceof Date)
    ) {
      flattenRecord(inner as Record<string, unknown>, path, out);
    } else if (Array.isArray(inner)) {
      out[path] = inner.every((item) => item === null || typeof item !== "object")
        ? inner.filter((item) => item !== null && item !== undefined).join(", ")
        : JSON.stringify(inner);
    } else {
      out[path] = cellText(inner);
    }
  }
  return out;
}

/** Objects (from JSON or `rows`) to a table; headers are the union of keys in order of appearance. */
export function tableFromObjects(objects: unknown[]): ParsedTable {
  checkRowCount(objects.length);
  const headers: string[] = [];
  const rows = objects.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw invalid(`Row ${index + 1} is not an object.`, { row: index + 1 });
    }
    const flat = flattenRecord(item as Record<string, unknown>);
    for (const key of Object.keys(flat)) if (!headers.includes(key)) headers.push(key);
    return flat;
  });
  return { headers, rows, firstRowNumber: 1 };
}

/** JSON text: an array of objects, or an object holding one under data/rows/people/contacts/leads/items. */
export function parseJsonText(text: string): ParsedTable {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new OpenOutboundError(
      "validation_failed",
      `The JSON could not be parsed: ${(error as Error).message}`,
      {
        hint: "Send an array of objects, or pass the rows directly with source rows.",
      },
    );
  }
  if (!Array.isArray(value) && value && typeof value === "object") {
    const holder = value as Record<string, unknown>;
    const key = ["data", "rows", "people", "contacts", "leads", "items", "records", "results"].find(
      (k) => Array.isArray(holder[k]),
    );
    value = key ? holder[key] : [value];
  }
  if (!Array.isArray(value)) throw invalid("The JSON must be an array of objects.");
  return tableFromObjects(value);
}

/** Google Sheets share links become their CSV export URL; other URLs are unchanged. */
export function csvExportUrl(url: string): string {
  const match = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(url);
  if (!match) return url;
  const gid = /[#&?]gid=(\d+)/.exec(url)?.[1] ?? "0";
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv&gid=${gid}`;
}

/** Downloads a CSV (or XLSX) from a public URL with the SSRF-safe fetch. */
export async function fetchTable(
  ctx: OpContext,
  url: string,
  delimiter?: string,
): Promise<ParsedTable> {
  const target = csvExportUrl(url);
  const response = await ctx.fetch(target, { maxBytes: MAX_URL_BYTES, timeoutMs: 30_000 });
  if (!response.ok) {
    throw new OpenOutboundError(
      "provider_error",
      `Downloading the file failed with HTTP ${response.status}.`,
      {
        hint: "Check the URL is public (no login needed), or download the file and import its content instead.",
        details: { status: response.status },
      },
    );
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("spreadsheetml") || /\.xlsx(\?|$)/i.test(target)) {
    return parseXlsx(Buffer.from(await response.arrayBuffer()));
  }
  if (type.includes("text/html")) {
    throw invalid("The URL returned a web page, not a CSV file.", { url: target });
  }
  return parseCsvText(await response.text(), delimiter);
}
