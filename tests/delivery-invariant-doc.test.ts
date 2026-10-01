/**
 * The table of proofs on docs/concepts/delivery-guarantees.md must stay true.
 *
 * The page promises that every outbound action is handed to its provider at most once per
 * attempt, and its table names, for every boundary (B1 to B6) and scenario (S1 to S8), the test
 * that proves it. This test reads that table and fails when:
 * - a boundary row or a scenario column is missing,
 * - a cell is empty, or says n/a without a reason,
 * - a cell names a test that does not exist. A cell names its tests as code spans
 *   `file > test title` (several joined by <br>); the file (a path from the repository root)
 *   must run a test with exactly that title, as it("title", ...) or test("title", ...), outside
 *   any describe.skip or describe.todo block. A skipped or todo test proves nothing.
 *
 * Every failure says what to add or fix.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PAGE = "docs/concepts/delivery-guarantees.md";
const RULE =
  "Every outbound action is handed to its provider at most once per attempt, and a new attempt starts only with proof or a decision.";

const BOUNDARIES = ["B1", "B2", "B3", "B4", "B5", "B6"] as const;
const SCENARIOS = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"] as const;

const CELL_FORMAT =
  "name the test that proves it as `file > test title` (several joined by <br>), or write `n/a: <reason>`";

/** Reads a file by its path from the repository root; null when there is no such file. */
type ReadFile = (path: string) => string | null;

function readRepoFile(path: string): string | null {
  const full = resolve(ROOT, path);
  const inside = relative(ROOT, full);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

/** The cells of a Markdown table row, without the outer pipes; an escaped pipe stays in its cell. */
function cellsOf(line: string): string[] {
  const inner = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** The first table under the `## Proofs` heading: header row first, separator row left out. */
function proofsTable(markdown: string): string[][] | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Proofs\s*$/.test(line));
  if (start < 0) return null;
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    if (line.trim().startsWith("|")) rows.push(cellsOf(line));
    else if (rows.length > 0) break;
  }
  const table = rows.filter((row) => !row.every((cell) => /^:?-{3,}:?$/.test(cell)));
  return table.length > 0 ? table : null;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern for the title as a JavaScript string literal, in any of the three quotes. */
function titleLiteral(title: string): string {
  const backslashed = title.replace(/\\/g, "\\\\");
  const spellings = [
    `"${backslashed.replace(/"/g, '\\"')}"`,
    `'${backslashed.replace(/'/g, "\\'")}'`,
    `\`${backslashed.replace(/`|\$\{/g, "\\$&")}\``,
  ];
  return `(?:${spellings.map(escapeRegExp).join("|")})`;
}

/** Words after which a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

/**
 * Where the `describe.skip(...)` and `describe.todo(...)` calls (or `suite.` ones) of a test file
 * start and end: no test inside them runs. Reads the code only: strings, template literals,
 * comments and regular expressions are passed over, so a parenthesis inside them ends nothing.
 */
function skippedBlocks(source: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  // Per open parenthesis: where its skipped call starts, or null for any other.
  const parens: Array<number | null> = [];
  // Per template literal being read: the brace depth of the `${...}` code inside it.
  const templates: number[] = [];
  let inTemplateText = false;
  // The last code token, to tell a regular expression from a division.
  let last = "";
  let i = 0;
  const skipQuoted = (quote: string) => {
    for (i += 1; i < source.length && source[i] !== quote && source[i] !== "\n"; i++) {
      if (source[i] === "\\") i += 1;
    }
    i += 1;
  };
  const skipRegex = () => {
    let inClass = false;
    for (i += 1; i < source.length && source[i] !== "\n"; i++) {
      const char = source[i];
      if (char === "\\") i += 1;
      else if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) break;
    }
    i += 1;
    while (i < source.length && /[a-z]/i.test(source[i] ?? "")) i += 1;
  };
  while (i < source.length) {
    const char = source[i] ?? "";
    if (inTemplateText) {
      if (char === "\\") i += 2;
      else if (char === "`") {
        inTemplateText = false;
        templates.pop();
        last = "`";
        i += 1;
      } else if (char === "$" && source[i + 1] === "{") {
        inTemplateText = false;
        i += 2;
        last = "{";
      } else i += 1;
      continue;
    }
    const next = source[i + 1];
    if (/\s/.test(char)) {
      i += 1;
    } else if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (char === '"' || char === "'") {
      skipQuoted(char);
      last = char;
    } else if (char === "`") {
      templates.push(0);
      inTemplateText = true;
      i += 1;
    } else if (char === "/") {
      if (last === "" || BEFORE_REGEX.has(last) || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(last)) {
        skipRegex();
        last = "/regex/";
      } else {
        last = "/";
        i += 1;
      }
    } else if (/[\w$]/.test(char)) {
      const word = /^[\w$]+/.exec(source.slice(i))?.[0] ?? char;
      last = word;
      i += word.length;
    } else {
      if (char === "(") {
        const call = /(?:describe|suite)\s*\.\s*(?:skip|todo)\s*$/.exec(
          source.slice(Math.max(0, i - 40), i),
        );
        const start = call ? i - call[0].length : -1;
        parens.push(start >= 0 && !/[\w$.]/.test(source[start - 1] ?? "") ? start : null);
      } else if (char === ")") {
        const start = parens.pop();
        if (start !== null && start !== undefined) blocks.push([start, i]);
      } else if (char === "{" && templates.length > 0) {
        templates[templates.length - 1] = (templates.at(-1) ?? 0) + 1;
      } else if (char === "}" && templates.length > 0) {
        const depth = templates.at(-1) ?? 0;
        if (depth === 0) {
          // The end of a `${...}`: back to the template's text.
          inTemplateText = true;
          i += 1;
          continue;
        }
        templates[templates.length - 1] = depth - 1;
      }
      last = char;
      i += 1;
    }
  }
  return blocks;
}

/** What is wrong with one cell, one line each. */
function checkCell(where: string, cell: string, readFile: ReadFile): string[] {
  if (cell === "") return [`${where} is empty: ${CELL_FORMAT}.`];
  if (/^n\/a\b/i.test(cell)) {
    return /^n\/a:\s*\S/.test(cell)
      ? []
      : [
          `${where} says n/a without a reason: write "n/a: <why this scenario cannot happen at this boundary>".`,
        ];
  }
  const problems: string[] = [];
  for (const part of cell.split(/<br\s*\/?>/i).map((text) => text.trim())) {
    const ref = /^`([^`]+?) > ([^`]+)`$/.exec(part);
    const file = ref?.[1]?.trim();
    const title = ref?.[2]?.trim().replace(/\\\|/g, "|");
    if (!file || !title) {
      problems.push(`${where} has "${part}", which does not name a test: ${CELL_FORMAT}.`);
      continue;
    }
    if (!file.endsWith(".test.ts")) {
      problems.push(
        `${where} names ${file}, which is not a test file: name a *.test.ts file and the title of a test in it.`,
      );
      continue;
    }
    const source = readFile(file);
    if (source === null) {
      problems.push(
        `${where} names ${file}, which does not exist: fix the path (from the repository root) or add that file with the test "${title}".`,
      );
      continue;
    }
    const literal = titleLiteral(title);
    const running = new RegExp(
      `(?<![.\\w])(?:it|test)(?:\\.(?:concurrent|sequential))?\\s*\\(\\s*${literal}`,
      "g",
    );
    const found = [...source.matchAll(running)].map((match) => match.index);
    const blocks = found.length > 0 ? skippedBlocks(source) : [];
    const runs = (at: number) => !blocks.some(([start, end]) => at > start && at < end);
    if (found.some(runs)) continue;
    if (found.length > 0) {
      problems.push(
        `${where}: "${title}" in ${file} sits in a describe.skip or describe.todo block, which does not run: move it out of that block; a skipped or todo test proves nothing.`,
      );
      continue;
    }
    problems.push(
      new RegExp(literal).test(source)
        ? `${where}: "${title}" is in ${file}, but not as the title of a test that runs: write it as it("${title}", ...); a skipped or todo test proves nothing.`
        : `${where}: ${file} has no test "${title}": add that test, or copy the exact title of the test that proves this cell.`,
    );
  }
  return problems;
}

/** What is wrong with the page's table of proofs, one actionable line each; empty when it holds. */
function checkProofs(markdown: string, readFile: ReadFile): string[] {
  const table = proofsTable(markdown);
  if (!table) {
    return [
      `${PAGE} has no table under "## Proofs": add one with a row per boundary (${BOUNDARIES.join(", ")}) and a column per scenario (${SCENARIOS.join(", ")}).`,
    ];
  }
  const [header = [], ...rows] = table;
  const problems: string[] = [];
  const columns = new Map<string, number>();
  header.forEach((cell, index) => {
    if (index > 0) columns.set(cell, index);
  });
  for (const scenario of SCENARIOS) {
    if (!columns.has(scenario)) {
      problems.push(
        `The table of proofs has no column ${scenario}: add "${scenario}" to its header and fill that column for every boundary.`,
      );
    }
  }
  for (const name of columns.keys()) {
    if (!(SCENARIOS as readonly string[]).includes(name)) {
      problems.push(
        `The table of proofs has a column "${name}", which is not a scenario: use ${SCENARIOS.join(", ")}. A new scenario also goes in the Scenarios table and in SCENARIOS in tests/delivery-invariant-doc.test.ts.`,
      );
    }
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const boundary = /^(B\d+)\b/.exec(row[0] ?? "")?.[1];
    if (!boundary || !(BOUNDARIES as readonly string[]).includes(boundary)) {
      problems.push(
        `The table of proofs has a row "${row[0] ?? ""}", which is not a boundary: start each row with ${BOUNDARIES.join(", ")}. A new boundary also goes in BOUNDARIES in tests/delivery-invariant-doc.test.ts.`,
      );
      continue;
    }
    if (seen.has(boundary)) {
      problems.push(`The table of proofs has two rows for ${boundary}: keep one.`);
      continue;
    }
    seen.add(boundary);
    for (const scenario of SCENARIOS) {
      const index = columns.get(scenario);
      if (index === undefined) continue;
      problems.push(...checkCell(`${boundary} ${scenario}`, row[index] ?? "", readFile));
    }
  }
  for (const boundary of BOUNDARIES) {
    if (!seen.has(boundary)) {
      problems.push(
        `The table of proofs has no row for ${boundary}: add one with a cell per scenario; in each, ${CELL_FORMAT}.`,
      );
    }
  }
  return problems;
}

describe("delivery guarantees page", () => {
  const page = readRepoFile(PAGE) ?? "";

  it("states the rule", () => {
    expect(page, `${PAGE} must state the rule: "${RULE}"`).toContain(RULE);
  });

  it("names a test that exists for every boundary and scenario", () => {
    const problems = checkProofs(page, readRepoFile);
    expect(problems, `Fix the table of proofs in ${PAGE}:\n${problems.join("\n")}`).toEqual([]);
  });
});

describe("the table of proofs check", () => {
  const FILE = "src/example/proofs.test.ts";
  const SOURCE = [
    'it("proves it", async () => {});',
    "it(",
    '  "proves it across lines",',
    "  async () => {},",
    ");",
    'it.skip("skipped", () => {});',
    'it("the agent\'s own", () => {});',
  ].join("\n");
  const read: ReadFile = (path) => (path === FILE ? SOURCE : null);
  const proof = `\`${FILE} > proves it\``;

  /** A page with a full table whose every cell is `proof`, changed by `edit`. */
  function pageWith(edit: (cells: Map<string, string>) => void, header = [...SCENARIOS]): string {
    const cells = new Map<string, string>();
    for (const boundary of BOUNDARIES) {
      for (const scenario of SCENARIOS) cells.set(`${boundary} ${scenario}`, proof);
    }
    edit(cells);
    const boundaries = [...new Set([...cells.keys()].map((key) => key.split(" ")[0]))];
    const rows = boundaries.map(
      (boundary) =>
        `| ${boundary} name | ${header.map((scenario) => cells.get(`${boundary} ${scenario}`) ?? "").join(" | ")} |`,
    );
    return [
      "## Proofs",
      "",
      `| Boundary | ${header.join(" | ")} |`,
      `| --- | ${header.map(() => "---").join(" | ")} |`,
      ...rows,
      "",
      "## Next",
    ].join("\n");
  }

  it("passes a full table of tests that run", () => {
    const page = pageWith((cells) => {
      cells.set("B1 S2", `\`${FILE} > proves it across lines\`<br>${proof}`);
      cells.set("B2 S3", `\`${FILE} > the agent's own\``);
      cells.set("B3 S4", "n/a: two workers never claim this row");
    });
    expect(checkProofs(page, read)).toEqual([]);
  });

  it("asks for a missing boundary, scenario or table", () => {
    const noRow = pageWith((cells) => {
      for (const scenario of SCENARIOS) cells.delete(`B6 ${scenario}`);
    });
    expect(checkProofs(noRow, read)).toEqual([
      expect.stringContaining("has no row for B6: add one with a cell per scenario"),
    ]);
    const noColumn = pageWith(() => {}, SCENARIOS.slice(0, 7));
    expect(checkProofs(noColumn, read)).toEqual([
      expect.stringContaining('has no column S8: add "S8" to its header'),
    ]);
    expect(checkProofs("# Delivery guarantees\n", read)).toEqual([
      expect.stringContaining('has no table under "## Proofs"'),
    ]);
  });

  it("asks to fill an empty cell or give a reason for n/a", () => {
    const page = pageWith((cells) => {
      cells.set("B1 S3", "");
      cells.set("B4 S5", "n/a");
      cells.set("B5 S1", "see the email tests");
    });
    expect(checkProofs(page, read)).toEqual([
      expect.stringMatching(/^B1 S3 is empty: name the test that proves it/),
      expect.stringMatching(/^B4 S5 says n\/a without a reason/),
      expect.stringMatching(/^B5 S1 has "see the email tests", which does not name a test/),
    ]);
  });

  it("asks for a test that sits in a skipped or todo describe block", () => {
    const file = "src/example/blocks.test.ts";
    const source = [
      'describe.skip("parked", () => {',
      '  // An unbalanced ")" in a comment, a string, a pattern or a template ends nothing.',
      "  const pattern = /\\)+/;",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the source of a test file, with a template in it
      '  const text = ")" + `${"("})`;',
      '  it("waits in a skipped block", () => {});',
      "});",
      'describe.todo("later", () => {',
      '  it("waits in a todo block", () => {});',
      "});",
      'describe("running", () => {',
      '  const note = "describe.skip(";',
      '  it("runs after the blocks", () => {});',
      "});",
    ].join("\n");
    const readBoth: ReadFile = (path) => (path === file ? source : read(path));
    const page = pageWith((cells) => {
      cells.set("B1 S1", `\`${file} > waits in a skipped block\``);
      cells.set("B1 S2", `\`${file} > waits in a todo block\``);
      cells.set("B1 S3", `\`${file} > runs after the blocks\``);
    });
    expect(checkProofs(page, readBoth)).toEqual([
      `B1 S1: "waits in a skipped block" in ${file} sits in a describe.skip or describe.todo block, which does not run: move it out of that block; a skipped or todo test proves nothing.`,
      `B1 S2: "waits in a todo block" in ${file} sits in a describe.skip or describe.todo block, which does not run: move it out of that block; a skipped or todo test proves nothing.`,
    ]);
  });

  it("asks for a test that does not exist or does not run", () => {
    const page = pageWith((cells) => {
      cells.set("B2 S6", `\`${FILE} > proves nothing\``);
      cells.set("B3 S7", "`src/example/gone.test.ts > proves it`");
      cells.set("B4 S8", `\`${FILE} > skipped\``);
      cells.set("B6 S2", "`docs/concepts/delivery-guarantees.md > proves it`");
    });
    expect(checkProofs(page, read)).toEqual([
      `B2 S6: ${FILE} has no test "proves nothing": add that test, or copy the exact title of the test that proves this cell.`,
      expect.stringMatching(/^B3 S7 names src\/example\/gone\.test\.ts, which does not exist/),
      expect.stringMatching(/^B4 S8: "skipped" is in .+, but not as the title of a test that runs/),
      expect.stringMatching(
        /^B6 S2 names docs\/concepts\/delivery-guarantees\.md, which is not a test file/,
      ),
    ]);
  });
});
