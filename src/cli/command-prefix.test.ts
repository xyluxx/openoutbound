import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { shellWords } from "../testing/cli-commands.js";
import { cliCommandPrefix, mcpLaunchCommand, withCommandPrefix } from "./command-prefix.js";

const slashes = (path: string) => path.replaceAll("\\", "/");

describe("mcpLaunchCommand", () => {
  it("prints the built entry point when init runs from source", () => {
    const command = mcpLaunchCommand("/repo/src/cli/main.ts", "/repo", (path) =>
      slashes(path).endsWith("/repo/dist/cli/main.js"),
    );
    expect(slashes(command)).toMatch(/^node \S*\/repo\/dist\/cli\/main\.js --home \/repo mcp$/);
  });

  it("falls back to tsx when there is no build", () => {
    expect(mcpLaunchCommand("/repo/src/cli/main.ts", "/repo", () => false)).toMatch(
      /^npx tsx \S*main\.ts --home \/repo mcp$/,
    );
  });

  it("quotes paths with spaces", () => {
    expect(mcpLaunchCommand("/my repo/dist/cli/main.js", "/my repo")).toBe(
      'node "/my repo/dist/cli/main.js" --home "/my repo" mcp',
    );
  });
});

describe("cliCommandPrefix", () => {
  const source = { scriptPath: "/repo/src/cli/main.ts", home: "/repo", cwd: "/repo" };

  it("uses the package script when init ran through it", () => {
    const env = { npm_lifecycle_event: "openoutbound", npm_config_user_agent: "pnpm/11.8.0" };
    expect(cliCommandPrefix({ ...source, env })).toBe("pnpm openoutbound");
    expect(
      cliCommandPrefix({
        ...source,
        env: { npm_lifecycle_event: "openoutbound", npm_config_user_agent: "npm/11.6.0 node/v24" },
      }),
    ).toBe("npm run openoutbound --");
  });

  it("uses node and the entry point when node ran it directly", () => {
    // Inside the clone the entry point is short, with forward slashes that work in every shell.
    const inside = cliCommandPrefix({
      scriptPath: "/repo/dist/cli/main.js",
      home: "/repo",
      cwd: "/repo",
      env: {},
    });
    expect(inside).toBe("node dist/cli/main.js");
    const outside = cliCommandPrefix({
      scriptPath: "/repo/dist/cli/main.js",
      home: "/work",
      cwd: "/work",
      env: {},
    });
    expect(slashes(outside)).toMatch(/^node \S*\/repo\/dist\/cli\/main\.js$/);
  });

  it("uses the built entry point (or tsx) when tsx ran the source", () => {
    const built = cliCommandPrefix({
      ...source,
      env: {},
      exists: (path) => slashes(path).endsWith("/repo/dist/cli/main.js"),
    });
    expect(built).toBe("node dist/cli/main.js");
    const unbuilt = cliCommandPrefix({ ...source, env: {}, exists: () => false });
    expect(unbuilt).toBe("npx tsx src/cli/main.ts");
  });

  it("uses the plain command only from an installed binary", () => {
    for (const scriptPath of [
      "/usr/local/bin/openoutbound",
      "/work/node_modules/.bin/openoutbound",
      "/home/dana/.npm-global/lib/node_modules/openoutbound/dist/cli/main.js",
    ]) {
      expect(cliCommandPrefix({ scriptPath, home: "/work", cwd: "/work", env: {} })).toBe(
        "openoutbound",
      );
    }
  });

  it("adds --home when the home is not the current directory", () => {
    const env = { npm_lifecycle_event: "openoutbound", npm_config_user_agent: "pnpm/11.8.0" };
    expect(slashes(cliCommandPrefix({ ...source, home: "/data/outbound", env }))).toMatch(
      /^pnpm openoutbound --home \S*\/data\/outbound$/,
    );
    expect(
      slashes(
        cliCommandPrefix({
          scriptPath: "/usr/local/bin/openoutbound",
          home: "/my home/outbound",
          cwd: "/work",
          env: {},
        }),
      ),
    ).toMatch(/^openoutbound --home "\S*\/my home\/outbound"$/);
  });
});

describe("Windows paths", () => {
  // Git Bash (the shell Claude Code uses on Windows) drops the backslashes of a bare Windows
  // path, so absolute paths are printed with forward slashes, which Git Bash, PowerShell, cmd
  // and node all accept.
  const clone = "C:\\code\\openoutbound";
  const main = `${clone}\\dist\\cli\\main.js`;
  const spaced = "C:\\Users\\Dana Reyes\\openoutbound";
  const same = (printed: string | undefined, path: string) =>
    expect(win32.normalize(printed ?? "")).toBe(win32.normalize(path));

  it("prints the agent line so a POSIX shell splits it into the same paths", () => {
    const line = `${mcpLaunchCommand(main, clone, () => false, "win32")} --workspace northwind`;
    expect(line).not.toContain("\\");
    const words = shellWords(line);
    expect(words).toHaveLength(7);
    expect(words[0]).toBe("node");
    same(words[1], main);
    expect(words[2]).toBe("--home");
    same(words[3], clone);
    expect(words.slice(4)).toEqual(["mcp", "--workspace", "northwind"]);
  });

  it("keeps quoting a path with spaces", () => {
    const script = `${spaced}\\dist\\cli\\main.js`;
    const line = mcpLaunchCommand(script, spaced, () => false, "win32");
    expect(line).toBe(
      'node "C:/Users/Dana Reyes/openoutbound/dist/cli/main.js" --home "C:/Users/Dana Reyes/openoutbound" mcp',
    );
    const words = shellWords(line);
    same(words[1], script);
    same(words[3], spaced);
  });

  it("prints the built entry point with forward slashes when init runs from source", () => {
    const line = mcpLaunchCommand(
      `${clone}\\src\\cli\\main.ts`,
      clone,
      (path) => win32.normalize(path) === main,
      "win32",
    );
    expect(line).toBe("node C:/code/openoutbound/dist/cli/main.js --home C:/code/openoutbound mcp");
  });

  it("writes hint prefixes with forward slashes, inside and outside the clone", () => {
    const base = { scriptPath: main, env: {}, platform: "win32" as const };
    expect(cliCommandPrefix({ ...base, home: clone, cwd: clone })).toBe("node dist/cli/main.js");
    const outside = cliCommandPrefix({ ...base, home: "D:\\outbound", cwd: "D:\\work" });
    expect(outside).toBe("node C:/code/openoutbound/dist/cli/main.js --home D:/outbound");
    const words = shellWords(`${outside} serve`);
    same(words[1], main);
    same(words[3], "D:\\outbound");
    const spacedHome = cliCommandPrefix({
      ...base,
      home: spaced,
      cwd: "D:\\work",
      env: { npm_lifecycle_event: "openoutbound", npm_config_user_agent: "pnpm/11.8.0" },
    });
    expect(spacedHome).toBe('pnpm openoutbound --home "C:/Users/Dana Reyes/openoutbound"');
  });

  it("leaves POSIX paths as they are", () => {
    expect(
      mcpLaunchCommand(
        "/srv/openoutbound/dist/cli/main.js",
        "/srv/openoutbound",
        () => false,
        "linux",
      ),
    ).toBe("node /srv/openoutbound/dist/cli/main.js --home /srv/openoutbound mcp");
  });
});

describe("withCommandPrefix", () => {
  it("rewrites the commands in a hint to the way the person runs the CLI", () => {
    const hint =
      "Create them with `openoutbound sandbox` (or run `openoutbound doctor`); the openoutbound engine stays.";
    expect(withCommandPrefix(hint, "node dist/cli/main.js")).toBe(
      "Create them with `node dist/cli/main.js sandbox` (or run `node dist/cli/main.js doctor`); the openoutbound engine stays.",
    );
    expect(withCommandPrefix("(openoutbound serve)", "pnpm openoutbound")).toBe(
      "(pnpm openoutbound serve)",
    );
    expect(
      withCommandPrefix("List them (CLI: openoutbound workspaces list).", "node dist/cli/main.js"),
    ).toBe("List them (CLI: node dist/cli/main.js workspaces list).");
    expect(withCommandPrefix(hint, "openoutbound")).toBe(hint);
  });
});
