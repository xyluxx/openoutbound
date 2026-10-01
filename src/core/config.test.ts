import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseDatabaseUrl, resolveSecretKey } from "./config.js";
import { OpenOutboundError } from "./errors.js";

const KEY = Buffer.alloc(32, 1).toString("base64");

describe("parseDatabaseUrl", () => {
  it("recognizes postgres, pglite and memory", () => {
    expect(parseDatabaseUrl("postgres://u:p@db:5432/oo")).toEqual({
      kind: "postgres",
      url: "postgres://u:p@db:5432/oo",
    });
    expect(parseDatabaseUrl("postgresql://db/oo").kind).toBe("postgres");
    expect(parseDatabaseUrl("memory://")).toEqual({ kind: "memory" });
    expect(parseDatabaseUrl("pglite://.openoutbound/pglite", "/srv/app")).toEqual({
      kind: "pglite",
      dataDir: resolve("/srv/app", ".openoutbound/pglite"),
    });
  });

  it("fails with a hint on unknown schemes", () => {
    try {
      parseDatabaseUrl("mysql://x");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OpenOutboundError);
      expect((error as OpenOutboundError).code).toBe("validation_failed");
      expect((error as OpenOutboundError).hint).toContain("postgres://");
    }
  });
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({}, { cwd: "/srv/app", envFile: false });
    expect(config.database).toEqual({
      kind: "pglite",
      dataDir: resolve("/srv/app", ".openoutbound/pglite"),
    });
    expect(config.port).toBe(7331);
    expect(config.host).toBe("127.0.0.1");
    expect(config.baseUrl).toBe("http://localhost:7331");
    expect(config.logLevel).toBe("info");
    expect(config.mcpToolsets).toEqual(["core"]);
    // Like agent keys: no approve, no admin (an owner adds them with OPENOUTBOUND_AGENT_SCOPES).
    expect(config.agentScopes).toEqual(["read", "write", "send", "spend"]);
    expect(config.allowPrivateNetwork).toBe(false);
    expect(config.secretKey).toBeNull();
    expect(config.userAgent).toMatch(
      /^OpenOutboundBot\/\d+\.\d+\.\d+ \(\+https:\/\/github.com\/xyluxx\/openoutbound\)$/,
    );
  });

  it("parses every variable", () => {
    const config = loadConfig(
      {
        DATABASE_URL: "memory://",
        OPENOUTBOUND_SECRET_KEY: KEY,
        OPENOUTBOUND_BASE_URL: "https://outbound.example.com/",
        PORT: "8080",
        HOST: "0.0.0.0",
        LOG_LEVEL: "DEBUG",
        OPENOUTBOUND_API_KEY: "oo_test",
        OPENOUTBOUND_MCP_TOOLSETS: "core, leads",
        OPENOUTBOUND_AGENT_SCOPES: "read,write",
        OPENOUTBOUND_ALLOW_PRIVATE_NETWORK: "true",
        APOLLO_API_KEY: "apollo-test",
      },
      { envFile: false },
    );
    expect(config.database).toEqual({ kind: "memory" });
    expect(config.secretKey?.length).toBe(32);
    expect(config.baseUrl).toBe("https://outbound.example.com");
    expect(config.port).toBe(8080);
    expect(config.host).toBe("0.0.0.0");
    expect(config.logLevel).toBe("debug");
    expect(config.apiKey).toBe("oo_test");
    expect(config.mcpToolsets).toEqual(["core", "leads"]);
    expect(config.agentScopes).toEqual(["read", "write"]);
    expect(config.allowPrivateNetwork).toBe(true);
    expect(config.env.APOLLO_API_KEY).toBe("apollo-test");
  });

  it("rejects bad values with actionable errors", () => {
    expect(() => loadConfig({ PORT: "abc" }, { envFile: false })).toThrow(/PORT/);
    expect(() => loadConfig({ OPENOUTBOUND_SECRET_KEY: "short" }, { envFile: false })).toThrow(
      /OPENOUTBOUND_SECRET_KEY/,
    );
    expect(() =>
      loadConfig({ OPENOUTBOUND_AGENT_SCOPES: "read,root" }, { envFile: false }),
    ).toThrow(/root/);
    expect(() =>
      loadConfig({ OPENOUTBOUND_MCP_TOOLSETS: "everything" }, { envFile: false }),
    ).toThrow(/everything/);
    expect(() =>
      loadConfig({ OPENOUTBOUND_ALLOW_PRIVATE_NETWORK: "maybe" }, { envFile: false }),
    ).toThrow();
  });

  it("merges a .env file without overriding explicit variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "oo-config-"));
    const file = join(dir, ".env");
    writeFileSync(file, "PORT=9090\nHOST=0.0.0.0\n# comment\nLOG_LEVEL=warn\n");
    const config = loadConfig({ HOST: "127.0.0.1" }, { cwd: dir, envFile: file });
    expect(config.port).toBe(9090);
    expect(config.host).toBe("127.0.0.1");
    expect(config.logLevel).toBe("warn");
  });

  it("resolveSecretKey: ephemeral for memory, error otherwise", () => {
    const memory = loadConfig({ DATABASE_URL: "memory://" }, { envFile: false });
    const key = resolveSecretKey(memory);
    expect(key.length).toBe(32);
    expect(resolveSecretKey(memory)).toBe(key);
    const disk = loadConfig({}, { envFile: false });
    expect(() => resolveSecretKey(disk)).toThrow(/OPENOUTBOUND_SECRET_KEY/);
  });
});
