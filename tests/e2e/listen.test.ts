import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isOpenOutboundError } from "../../src/core/errors.js";
import { listenError, startHttpServer } from "../../src/http/server.js";
import { createFakeEngine } from "./fake-engine.js";

const blockers: Server[] = [];
afterEach(async () => {
  for (const server of blockers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function occupyPort(): Promise<number> {
  const server = createServer();
  blockers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

describe("startHttpServer listen errors", () => {
  it("says the port is taken, and how to pick another, when another program holds it", async () => {
    const port = await occupyPort();
    const engine = createFakeEngine();
    const failure = await startHttpServer(engine, { port, host: "127.0.0.1", writeLock: false })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(isOpenOutboundError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "conflict",
      message: `Port ${port} on 127.0.0.1 is already in use by another program.`,
    });
    expect((failure as { hint: string }).hint).toContain("openoutbound serve --port");
  });

  it("maps permission and address errors, and passes anything else through", () => {
    const denied = Object.assign(new Error("listen EACCES"), { code: "EACCES" });
    expect(listenError(denied, "0.0.0.0", 80, "linux")).toMatchObject({ code: "forbidden" });
    // Windows reports a port held by another program (AnyDesk on 7070, say) as EACCES.
    const held = listenError(denied, "127.0.0.1", 7070, "win32");
    expect(held).toMatchObject({
      code: "conflict",
      message:
        "Port 7070 on 127.0.0.1 is blocked: another program holds it, or the system reserved it.",
    });
    expect((held as { hint: string }).hint).toContain("excludedportrange");
    expect(listenError(denied, "127.0.0.1", 7070, "linux")).toMatchObject({ code: "conflict" });
    const badHost = Object.assign(new Error("listen EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" });
    expect(listenError(badHost, "10.9.9.9", 7070)).toMatchObject({ code: "validation_failed" });
    const other = new Error("boom");
    expect(listenError(other, "127.0.0.1", 7070)).toBe(other);
  });
});
