/**
 * Every way the pages connect an agent lands in a workspace: an HTTP line carries a workspace
 * header, and a key for a client that sends none (the Claude Code plugin, Codex over HTTP) is
 * created for one workspace. Without it the calls land in the empty `default` workspace.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

const PAGES = [
  "README.md",
  "docs/getting-started/connect-your-agent.md",
  "docs/getting-started/first-hour.md",
  "examples/agents/README.md",
];

describe("agent connection routes in the pages", () => {
  it("send a workspace header on every Claude Code HTTP line", () => {
    const lines = PAGES.flatMap((path) =>
      read(path)
        .split("\n")
        .filter((line) => line.includes("claude mcp add --transport http"))
        .map((line) => ({ path, line })),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const { path, line } of lines) {
      expect(line, path).toMatch(/--header "OpenOutbound-(Bind-)?Workspace: northwind"/);
    }
    const guide = lines.find((entry) => entry.path.endsWith("connect-your-agent.md"));
    expect(guide?.line).toContain('--header "OpenOutbound-Bind-Workspace: northwind"');
  });

  it("create the key for the sandbox workspace where the client sends no workspace header", () => {
    const guide = read("docs/getting-started/connect-your-agent.md");
    const plugin = guide.slice(guide.indexOf("### Claude Code plugin"), guide.indexOf("## Codex"));
    expect(plugin).toContain(
      'openoutbound keys create --name "Claude Code" --kind agent --workspace northwind',
    );
    const codex = guide.slice(guide.indexOf("## Codex"), guide.indexOf("## Claude Desktop"));
    expect(codex).toMatch(/--bearer-token-env-var[\s\S]*keys create [^`]*--workspace northwind/);
  });

  it("point the examples at the plugin steps", () => {
    expect(read("examples/agents/README.md")).toContain(
      "(../../docs/getting-started/connect-your-agent.md#claude-code-plugin)",
    );
  });
});
