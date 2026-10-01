import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeEngine } from "../../tests/e2e/fake-engine.js";
import { renderReference } from "./reference.js";
import {
  referenceTargets,
  SKILL_COPIES,
  staleReferenceMessage,
  staleReferenceTargets,
} from "./reference-check.js";

const root = resolve("/repo");
const outDir = join(root, "docs", "reference");
const files = renderReference(createFakeEngine().registry, "1.2.3");
const targets = referenceTargets(files, { outDir, root, skillCopies: true });

/** A disk that holds exactly what the generator writes, to be edited per test. */
function diskOf(): Map<string, string> {
  return new Map(targets.map((target) => [target.path, target.content]));
}

describe("generate-reference --check", () => {
  it("covers the reference files and the skill copies", () => {
    expect(targets.map((target) => target.path)).toEqual(
      [
        ...Object.keys(files).map((name) => join(outDir, name)),
        ...SKILL_COPIES.map(([, to]) => resolve(root, to)),
      ].sort(),
    );
    const copy = targets.find((target) => target.path.endsWith("tools.md"));
    expect(copy?.content).toBe(files["mcp-tools.md"]);
    const elsewhere = referenceTargets(files, { outDir, root, skillCopies: false });
    expect(elsewhere).toHaveLength(Object.keys(files).length);
  });

  it("passes when every file matches, whatever the line endings", () => {
    const disk = diskOf();
    for (const [path, content] of disk) disk.set(path, content.replace(/\n/g, "\r\n"));
    expect(staleReferenceTargets(targets, (path) => disk.get(path))).toEqual([]);
  });

  it("detects a stale file and a missing one", () => {
    const disk = diskOf();
    const cli = join(outDir, "cli.md");
    const skillTools = resolve(root, "skills/openoutbound/references/tools.md");
    disk.set(cli, `${disk.get(cli)}\n| an operation that no longer exists |\n`);
    disk.delete(skillTools);
    const stale = staleReferenceTargets(targets, (path) => disk.get(path));
    expect(stale.map((target) => target.path)).toEqual([cli, skillTools].sort());
  });

  it("tells people to run pnpm generate:reference", () => {
    const message = staleReferenceMessage(["docs/reference/cli.md"]);
    expect(message).toContain("docs/reference/cli.md");
    expect(message).toContain("Run pnpm generate:reference and commit the result.");
    expect(staleReferenceMessage(["a.md", "b.md"])).toContain("(2 files)");
  });
});
