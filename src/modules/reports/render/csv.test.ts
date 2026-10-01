import { describe, expect, it } from "vitest";
import { csvTable, csvValue } from "./csv.js";

describe("csv", () => {
  it("writes plain values", () => {
    expect(csvValue("Signal play")).toBe("Signal play");
    expect(csvValue(12.5)).toBe("12.5");
    expect(csvValue(0)).toBe("0");
    expect(csvValue(null)).toBe("");
    expect(csvValue(undefined)).toBe("");
    expect(csvValue(Number.NaN)).toBe("");
    expect(csvValue(true)).toBe("true");
  });

  it("quotes commas, quotes and line breaks (RFC 4180)", () => {
    expect(csvValue("Harbor, Inc.")).toBe('"Harbor, Inc."');
    expect(csvValue('The "big" one')).toBe('"The ""big"" one"');
    expect(csvValue("two\nlines")).toBe('"two\nlines"');
  });

  it("defuses text a spreadsheet would run as a formula", () => {
    expect(csvValue('=HYPERLINK("http://example.com")')).toBe(
      `"'=HYPERLINK(""http://example.com"")"`,
    );
    expect(csvValue("+1 555")).toBe("'+1 555");
    expect(csvValue("-budget")).toBe("'-budget");
    expect(csvValue("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvValue("\tcmd")).toBe("'\tcmd");
    expect(csvValue(-3)).toBe("-3");
  });

  it("joins rows with CRLF and ends with one", () => {
    expect(
      csvTable(
        ["a", "b"],
        [
          [1, "x,y"],
          [null, 2],
        ],
      ),
    ).toBe('a,b\r\n1,"x,y"\r\n,2\r\n');
  });
});
