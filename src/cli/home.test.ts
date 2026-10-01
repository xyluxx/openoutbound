import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { homeFlag, resolveHome } from "./home.js";

const cwd = resolve("/work/project");
const pkg = resolve("/opt/openoutbound");

function existsIn(paths: string[]) {
  const set = new Set(paths.map((path) => resolve(path)));
  return (path: string) => set.has(resolve(path));
}

describe("resolveHome", () => {
  it("prefers --home, then OPENOUTBOUND_HOME", () => {
    expect(
      resolveHome({ flag: "rel/home", env: {}, cwd, packageRoot: pkg, exists: () => false }),
    ).toEqual({
      dir: join(cwd, "rel/home"),
      source: "flag",
    });
    expect(
      resolveHome({
        env: { OPENOUTBOUND_HOME: resolve("/srv/oo") },
        cwd,
        packageRoot: pkg,
        exists: () => false,
      }),
    ).toEqual({ dir: resolve("/srv/oo"), source: "env" });
  });

  it("uses the current directory when it has .env or .openoutbound/", () => {
    const exists = existsIn([join(cwd, ".openoutbound"), join(pkg, ".env")]);
    expect(resolveHome({ env: {}, cwd, packageRoot: pkg, exists })).toEqual({
      dir: cwd,
      source: "cwd",
    });
  });

  it("falls back to the package root when it has .env, else the current directory", () => {
    const exists = existsIn([join(pkg, ".env")]);
    expect(resolveHome({ env: {}, cwd, packageRoot: pkg, exists })).toEqual({
      dir: pkg,
      source: "package",
    });
    expect(resolveHome({ env: {}, cwd, packageRoot: pkg, exists: () => false })).toEqual({
      dir: cwd,
      source: "default",
    });
  });

  it("ignores a blank OPENOUTBOUND_HOME", () => {
    expect(
      resolveHome({ env: { OPENOUTBOUND_HOME: "  " }, cwd, packageRoot: pkg, exists: () => false })
        .source,
    ).toBe("default");
  });
});

describe("homeFlag", () => {
  it("reads --home <dir> and --home=<dir> before --", () => {
    expect(homeFlag(["--home", "/a", "mcp"])).toBe("/a");
    expect(homeFlag(["mcp", "--home=/b"])).toBe("/b");
    expect(homeFlag(["mcp", "--", "--home", "/c"])).toBeNull();
    expect(homeFlag(["doctor"])).toBeNull();
  });
});
