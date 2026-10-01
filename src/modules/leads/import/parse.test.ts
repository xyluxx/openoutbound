import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../../../testing/context.js";
import {
  csvExportUrl,
  fetchTable,
  flattenRecord,
  parseCsvText,
  parseJsonText,
  parseXlsx,
  sniffDelimiter,
  tableFromObjects,
  uniqueHeaders,
} from "./parse.js";

/** Minimal XLSX (stored zip, inline strings) so tests need no spreadsheet library. */
function buildXlsx(rows: Array<Array<string | number>>): Buffer {
  const column = (index: number) => String.fromCharCode(65 + index);
  const xmlEscape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sheetRows = rows
    .map((cells, r) => {
      const xml = cells
        .map((cell, c) => {
          const ref = `${column(c)}${r + 1}`;
          return typeof cell === "number"
            ? `<c r="${ref}"><v>${cell}</v></c>`
            : `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${xml}</row>`;
    })
    .join("");
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files: Array<[string, string]> = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ],
    [
      "xl/worksheets/sheet1.xml",
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${main}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ],
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

describe("CSV", () => {
  it("sniffs delimiters outside quotes", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3\n")).toBe(",");
    expect(sniffDelimiter('Name;E-Mail;Firma\nDana;d@x.example.com;"Harbor, Inc"\n')).toBe(";");
    expect(sniffDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(sniffDelimiter('"x,y"|z\n"1,2"|3\n')).toBe("|");
  });

  it("handles BOM, quoted newlines, uneven rows and duplicate headers", () => {
    const bom = String.fromCharCode(0xfeff);
    const table = parseCsvText(
      `${bom}Email;Name;Notes;Email\ndana@harbor.example.com;Dana Reyes;"line one\nline two";x\nomar@example.org;Omar\n`,
    );
    expect(table.delimiter).toBe(";");
    expect(table.headers).toEqual(["Email", "Name", "Notes", "Email (2)"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]?.Notes).toBe("line one\nline two");
    expect(table.rows[1]?.Notes).toBe("");
    expect(table.firstRowNumber).toBe(2);
  });

  it("skips leading blank rows and names empty headers", () => {
    expect(uniqueHeaders(["Email", "", "email"])).toEqual(["Email", "column_2", "email (2)"]);
    const table = parseCsvText("\n\nEmail,Name\nx@example.org,X\n");
    expect(table.headers).toEqual(["Email", "Name"]);
  });

  it("reports unparsable CSV as a validation error", () => {
    expect(() => parseCsvText('a,b\n"unterminated,1\n', ",")).toThrowError(/could not be parsed/);
  });
});

describe("XLSX", () => {
  it("reads the first sheet with numbers and text", async () => {
    const bytes = buildXlsx([
      ["Email", "Company", "Employees"],
      ["dana@harbor.example.com", "Harbor Dental", 25],
    ]);
    const table = await parseXlsx(bytes);
    expect(table.headers).toEqual(["Email", "Company", "Employees"]);
    expect(table.rows).toEqual([
      { Email: "dana@harbor.example.com", Company: "Harbor Dental", Employees: "25" },
    ]);
  });

  it("rejects bytes that are not a spreadsheet", async () => {
    await expect(parseXlsx(Buffer.from("not a zip"))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("JSON and rows", () => {
  it("accepts arrays and common wrappers and flattens nested objects", () => {
    const table = parseJsonText(
      JSON.stringify({
        people: [{ email: "a@example.org", organization: { name: "Acme", tags: ["x", "y"] } }],
      }),
    );
    expect(table.headers).toEqual(["email", "organization.name", "organization.tags"]);
    expect(table.rows[0]?.["organization.tags"]).toBe("x, y");
    expect(flattenRecord({ a: { b: { c: 1 } } })).toEqual({ "a.b.c": "1" });
  });

  it("rejects non-object rows and bad JSON", () => {
    expect(() => tableFromObjects([1])).toThrowError(/not an object/);
    expect(() => parseJsonText("{nope")).toThrowError(/could not be parsed/);
  });
});

describe("URL imports", () => {
  it("turns Google Sheets links into CSV exports", () => {
    expect(csvExportUrl("https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42")).toBe(
      "https://docs.google.com/spreadsheets/d/abc_123/export?format=csv&gid=42",
    );
    expect(csvExportUrl("https://files.example.com/leads.csv")).toBe(
      "https://files.example.com/leads.csv",
    );
  });

  it("downloads through safe fetch and rejects HTML pages", async () => {
    const ctx = await createTestContext({
      fetchRoutes: [
        {
          match: "https://files.example.com/leads.csv",
          response: { body: "Email\nx@example.org\n", headers: { "content-type": "text/csv" } },
        },
        { match: "https://files.example.com/page", response: { body: "<html></html>" } },
        { match: "https://files.example.com/missing.csv", response: { status: 404, body: "" } },
      ],
    });
    try {
      const table = await fetchTable(ctx, "https://files.example.com/leads.csv");
      expect(table.rows).toEqual([{ Email: "x@example.org" }]);
      await expect(fetchTable(ctx, "https://files.example.com/page")).rejects.toMatchObject({
        code: "validation_failed",
      });
      await expect(fetchTable(ctx, "https://files.example.com/missing.csv")).rejects.toMatchObject({
        code: "provider_error",
      });
    } finally {
      await ctx.close();
    }
  });
});
