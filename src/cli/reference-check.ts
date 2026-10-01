/**
 * Freshness check for the generated reference: compares what `renderReference` writes now with
 * the files on disk (docs/reference/ and the Agent Skill's copies). `scripts/generate-reference.ts
 * --check` uses it, and `pnpm check` runs that, so a changed operation or tool fails the check
 * until the reference is generated again.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** SKILL.md links references/tools.md and references/cli.md: copies of two reference files. */
export const SKILL_COPIES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["mcp-tools.md", "skills/openoutbound/references/tools.md"],
  ["cli.md", "skills/openoutbound/references/cli.md"],
];

export const GENERATE_REFERENCE_COMMAND = "pnpm generate:reference";

/** One file the generator writes: its absolute path and the content it should have. */
export interface ReferenceTarget {
  path: string;
  content: string;
}

export interface ReferenceTargetOptions {
  /** Folder for the reference files (docs/reference by default). */
  outDir: string;
  /** Repository root the skill copies are relative to. */
  root: string;
  /** Also write the skill copies (only for the default output folder). */
  skillCopies: boolean;
}

/** Every file the generator writes, sorted by path. */
export function referenceTargets(
  files: Readonly<Record<string, string>>,
  options: ReferenceTargetOptions,
): ReferenceTarget[] {
  const targets = Object.entries(files).map(([name, content]) => ({
    path: join(options.outDir, name),
    content,
  }));
  if (options.skillCopies) {
    for (const [from, to] of SKILL_COPIES) {
      const content = files[from];
      if (content !== undefined) targets.push({ path: resolve(options.root, to), content });
    }
  }
  return targets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The file's text, or undefined when it cannot be read (missing). */
export function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

/** Targets that are missing on disk or differ from what the generator writes now. */
export function staleReferenceTargets(
  targets: readonly ReferenceTarget[],
  read: (path: string) => string | undefined = readIfPresent,
): ReferenceTarget[] {
  return targets.filter((target) => {
    const current = read(target.path);
    return current === undefined || normalize(current) !== normalize(target.content);
  });
}

/** What `--check` prints when files are stale: the list and the command that fixes it. */
export function staleReferenceMessage(paths: readonly string[]): string {
  const list = paths.map((path) => `  ${path}`).join("\n");
  return `The generated reference is stale (${paths.length} file${paths.length === 1 ? "" : "s"}):\n${list}\nRun ${GENERATE_REFERENCE_COMMAND} and commit the result.\n`;
}
