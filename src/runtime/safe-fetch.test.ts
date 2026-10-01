import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import type { SafeFetch } from "../core/context.js";
import { failureOf } from "../core/failures.js";
import { isAddressAllowed, isMetadataAddress, isPrivateAddress } from "./ip-policy.js";
import {
  createSafeFetch,
  type HostResolver,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from "./safe-fetch.js";

const USER_AGENT = "OpenOutboundBot/1.0 (+https://example.com/bot)";
const PUBLIC_IP = "93.184.215.14";

const dns: Record<string, string[]> = {
  "www.example.com": [PUBLIC_IP],
  "blog.example.org": ["93.184.215.15"],
  "internal.example.com": ["10.0.0.5"],
  "mixed.example.com": [PUBLIC_IP, "127.0.0.1"],
  "metadata.example.com": ["169.254.169.254"],
};
const resolveHost: HostResolver = async (host) => {
  const addresses = dns[host];
  if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
  return addresses;
};

function reply(
  status: number,
  body: string | Buffer | Buffer[] = "",
  headers: Record<string, string> = {},
): TransportResponse {
  const chunks = Array.isArray(body) ? body : [Buffer.from(body)];
  return {
    status,
    statusText: "",
    headers: new Headers(headers),
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  addresses: string[];
}

type Route = (request: TransportRequest) => TransportResponse | Promise<TransportResponse>;

function harness(options: { allowPrivateNetwork?: boolean } = {}) {
  const routes = new Map<string, Route>();
  const requests: Recorded[] = [];
  const clock = fixedClock();
  const transport: Transport = async (request) => {
    requests.push({
      url: request.url.toString(),
      method: request.method,
      headers: { ...request.headers },
      body: request.body ? Buffer.from(request.body).toString("utf8") : null,
      addresses: request.addresses,
    });
    const route = routes.get(request.url.toString());
    return route ? route(request) : reply(404, "not found");
  };
  const fetch = createSafeFetch({
    allowPrivateNetwork: options.allowPrivateNetwork ?? false,
    userAgent: USER_AGENT,
    clock,
    resolveHost,
    transport,
  });
  return { fetch, routes, requests, clock };
}

const hang: Route = (request) =>
  new Promise((_, reject) => {
    if (request.signal.aborted) reject(new Error("socket aborted"));
    request.signal.addEventListener("abort", () => reject(new Error("socket aborted")));
  });

describe("ip policy", () => {
  it("blocks private, reserved and embedded private addresses", () => {
    for (const address of [
      "10.1.2.3",
      "172.16.5.4",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "[::1]",
      "fe80::1%eth0",
      "fd12:3456::1",
      "::ffff:10.0.0.1",
      "::ffff:a00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "64:ff9b::a00:1",
      "::127.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of [PUBLIC_IP, "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("always blocks cloud metadata endpoints", () => {
    for (const address of [
      "169.254.169.254",
      "fd00:ec2::254",
      "[fd00:0ec2:0:0:0:0:0:254]",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "100.100.100.200",
    ]) {
      expect(isMetadataAddress(address), address).toBe(true);
      expect(isAddressAllowed(address, true), address).toBe(false);
    }
    expect(isAddressAllowed("10.0.0.1", true)).toBe(true);
    expect(isAddressAllowed("10.0.0.1", false)).toBe(false);
    expect(isAddressAllowed("8.8.8.8", false)).toBe(true);
  });
});

describe("safe fetch", () => {
  it("rejects invalid URLs and schemes", async () => {
    const { fetch, requests } = harness();
    for (const url of ["not a url", "ftp://www.example.com/x", "file:///etc/passwd"]) {
      await expect(fetch(url)).rejects.toMatchObject({
        code: "validation_failed",
        details: { reason: "invalid_url" },
      });
    }
    expect(requests).toHaveLength(0);
    const error = await fetch("not a url").catch((caught: unknown) => caught);
    expect(failureOf(error)).toEqual({ class: "bad_request", retryable: false, scope: "call" });
  });

  it("never repeats the query of an invalid URL, where keys live", async () => {
    const { fetch } = harness();
    const error = await fetch("api.example.com/v3/credits?api=mv-key-0123456789abcdef").catch(
      (caught: unknown) => caught,
    );
    expect(String((error as Error).message)).not.toContain("mv-key-0123456789abcdef");
    expect(String((error as Error).message)).not.toContain("?");
    expect(String((error as Error).message)).toContain("api.example.com/v3/credits");
  });

  it("blocks private targets after DNS resolution, in every spelling", async () => {
    const { fetch, requests } = harness();
    for (const url of [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://internal.example.com/",
      "http://mixed.example.com/",
      "http://metadata.example.com/latest/meta-data/",
    ]) {
      await expect(fetch(url), url).rejects.toMatchObject({
        code: "forbidden",
        details: { reason: "blocked_address" },
      });
    }
    expect(requests).toHaveLength(0);
    // A refusal, not a network error worth retrying.
    const blocked = await fetch("http://127.0.0.1/").catch((caught: unknown) => caught);
    expect(failureOf(blocked)).toEqual({ class: "refused", retryable: false, scope: "call" });
    await expect(fetch("https://missing.example.com/")).rejects.toMatchObject({
      code: "provider_error",
      details: { reason: "network" },
    });
  });

  it("allows private networks when configured, never metadata", async () => {
    const { fetch, routes, requests } = harness({ allowPrivateNetwork: true });
    routes.set("http://internal.example.com/", () => reply(200, "intranet"));
    await expect((await fetch("http://internal.example.com/")).text()).resolves.toBe("intranet");
    expect(requests[0]?.addresses).toEqual(["10.0.0.5"]);
    await expect(fetch("http://metadata.example.com/")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(fetch("http://169.254.169.254/")).rejects.toMatchObject({ code: "forbidden" });
    const strict = harness({ allowPrivateNetwork: true });
    await expect(
      strict.fetch("http://internal.example.com/", { allowPrivate: false }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("pins the checked addresses and sends the OpenOutbound user agent", async () => {
    const { fetch, routes, requests } = harness();
    routes.set("https://www.example.com/", () => reply(200, "<html>hi</html>"));
    const response = await fetch("https://www.example.com/", {
      method: "post",
      headers: { "x-test": "1" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(response.status).toBe(200);
    expect(response.url).toBe("https://www.example.com/");
    expect(response.redirected).toBe(false);
    expect(requests[0]).toMatchObject({
      method: "POST",
      addresses: [PUBLIC_IP],
      body: '{"a":1}',
      headers: {
        "user-agent": USER_AGENT,
        "x-test": "1",
        "accept-encoding": "gzip, deflate, br",
        "content-length": "7",
      },
    });
    const custom = await fetch("https://www.example.com/", { headers: { "User-Agent": "Custom" } });
    expect(custom.status).toBe(200);
    expect(requests[1]?.headers["user-agent"]).toBe("Custom");
    const missing = await fetch("https://www.example.com/missing");
    expect(missing.status).toBe(404);
  });

  it("follows redirects with checks on every hop", async () => {
    const { fetch, routes, requests } = harness();
    routes.set("https://www.example.com/old", () => reply(301, "", { location: "/new" }));
    routes.set("https://www.example.com/new", () => reply(200, "moved"));
    const moved = await fetch("https://www.example.com/old");
    expect(await moved.text()).toBe("moved");
    expect(moved.url).toBe("https://www.example.com/new");
    expect(moved.redirected).toBe(true);

    routes.set("https://www.example.com/evil", () =>
      reply(302, "", { location: "http://127.0.0.1/admin" }),
    );
    requests.length = 0;
    await expect(fetch("https://www.example.com/evil")).rejects.toMatchObject({
      code: "forbidden",
      details: { reason: "blocked_address" },
    });
    expect(requests).toHaveLength(1);

    routes.set("https://www.example.com/form", () =>
      reply(303, "", { location: "https://blog.example.org/thanks" }),
    );
    routes.set("https://blog.example.org/thanks", () => reply(200, "thanks"));
    requests.length = 0;
    await fetch("https://www.example.com/form", {
      method: "POST",
      headers: { authorization: "Bearer example", "content-type": "text/plain" },
      body: "hello",
    });
    expect(requests[1]).toMatchObject({ method: "GET", body: null });
    expect(requests[1]?.headers.authorization).toBeUndefined();
    expect(requests[1]?.headers["content-type"]).toBeUndefined();

    routes.set("https://www.example.com/keep", () =>
      reply(307, "", { location: "https://www.example.com/kept" }),
    );
    routes.set("https://www.example.com/kept", () => reply(200, "kept"));
    requests.length = 0;
    await fetch("https://www.example.com/keep", {
      method: "POST",
      headers: { authorization: "Bearer example" },
      body: "x",
    });
    expect(requests[1]).toMatchObject({
      method: "POST",
      body: "x",
      headers: { authorization: "Bearer example" },
    });

    routes.set("https://www.example.com/loop", () => reply(302, "", { location: "/loop" }));
    requests.length = 0;
    await expect(fetch("https://www.example.com/loop", { maxRedirects: 2 })).rejects.toMatchObject({
      details: { reason: "too_many_redirects" },
    });
    expect(requests).toHaveLength(3);

    const manual = await fetch("https://www.example.com/old", { redirect: "manual" });
    expect(manual.status).toBe(301);
    expect(manual.headers.get("location")).toBe("/new");
    await expect(fetch("https://www.example.com/old", { redirect: "error" })).rejects.toMatchObject(
      {
        details: { reason: "network" },
      },
    );
  });

  it("caps response size, including after decompression", async () => {
    const { fetch, routes } = harness();
    routes.set("https://www.example.com/declared", () =>
      reply(200, "small", { "content-length": "999999" }),
    );
    routes.set("https://www.example.com/stream", () =>
      reply(200, [Buffer.alloc(600, 97), Buffer.alloc(600, 98)]),
    );
    routes.set("https://www.example.com/bomb", () =>
      reply(200, gzipSync(Buffer.alloc(2 * 1024 * 1024, 48)), { "content-encoding": "gzip" }),
    );
    routes.set("https://www.example.com/gzip", () =>
      reply(200, gzipSync(Buffer.from("compressed hello")), {
        "content-encoding": "gzip",
        "content-length": "36",
      }),
    );
    for (const url of [
      "https://www.example.com/declared",
      "https://www.example.com/stream",
      "https://www.example.com/bomb",
    ]) {
      await expect(fetch(url, { maxBytes: 1000 }), url).rejects.toMatchObject({
        code: "provider_error",
        details: { reason: "too_large", max_bytes: 1000 },
      });
    }
    const unzipped = await fetch("https://www.example.com/gzip");
    expect(await unzipped.text()).toBe("compressed hello");
    expect(unzipped.headers.get("content-encoding")).toBeNull();
    expect(unzipped.headers.get("content-length")).toBeNull();
  });

  it("respects robots.txt when asked, with caching", async () => {
    const { fetch, routes, requests, clock } = harness();
    routes.set("https://www.example.com/robots.txt", () =>
      reply(200, "User-agent: *\nDisallow: /private\n", { "content-type": "text/plain" }),
    );
    routes.set("https://www.example.com/private/page", () => reply(200, "secret"));
    routes.set("https://www.example.com/public", () => reply(200, "public"));
    await expect(
      fetch("https://www.example.com/private/page", { respectRobots: true }),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "robots_disallowed" } });
    expect((await fetch("https://www.example.com/public", { respectRobots: true })).status).toBe(
      200,
    );
    expect((await fetch("https://www.example.com/private/page")).status).toBe(200);
    const robotsCalls = () => requests.filter((request) => request.url.endsWith("/robots.txt"));
    expect(robotsCalls()).toHaveLength(1);

    let robotsStatus = 503;
    routes.set("https://blog.example.org/robots.txt", () => reply(robotsStatus, "down"));
    routes.set("https://blog.example.org/post", () => reply(200, "post"));
    await expect(
      fetch("https://blog.example.org/post", { respectRobots: true }),
    ).rejects.toMatchObject({ details: { reason: "robots_disallowed" } });
    robotsStatus = 404;
    clock.advance(61 * 60_000);
    expect((await fetch("https://blog.example.org/post", { respectRobots: true })).status).toBe(
      200,
    );
    clock.advance(25 * 60 * 60_000);
    await fetch("https://www.example.com/public", { respectRobots: true });
    expect(robotsCalls()).toHaveLength(4);
  });

  it("backs off a host after 429 until Retry-After", async () => {
    const { fetch, routes, clock } = harness();
    routes.set("https://www.example.com/busy", () =>
      reply(429, "slow down", { "retry-after": "120" }),
    );
    routes.set("https://www.example.com/other", () => reply(200, "fine"));
    routes.set("https://blog.example.org/", () => reply(200, "fine"));
    expect((await fetch("https://www.example.com/busy")).status).toBe(429);
    await expect(fetch("https://www.example.com/other")).rejects.toMatchObject({
      code: "provider_error",
      retryAfterSeconds: 120,
      details: {
        reason: "rate_limited",
        host: "www.example.com",
        failure: { class: "rate_limited", retryable: true, retry_after_s: 120 },
      },
    });
    expect((await fetch("https://blog.example.org/")).status).toBe(200);
    clock.advance(121_000);
    expect((await fetch("https://www.example.com/other")).status).toBe(200);
  });

  it("times out and honours the caller's abort signal", async () => {
    const { fetch, routes } = harness();
    routes.set("https://www.example.com/slow", hang);
    await expect(fetch("https://www.example.com/slow", { timeoutMs: 30 })).rejects.toMatchObject({
      code: "provider_error",
      details: { reason: "timeout", timeout_ms: 30 },
    });
    const controller = new AbortController();
    const pending = fetch("https://www.example.com/slow", { signal: controller.signal });
    controller.abort(new Error("stopped by caller"));
    await expect(pending).rejects.toThrowError("stopped by caller");
    const later = new AbortController();
    const waiting = fetch("https://www.example.com/slow", { signal: later.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    later.abort(new Error("stopped while waiting"));
    await expect(waiting).rejects.toThrowError("stopped while waiting");
  });
});

describe("safe fetch over real sockets", () => {
  let server: http.Server;
  let port = 0;
  const seen: Array<{ url: string; host: string | undefined; agent: string | undefined }> = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      seen.push({
        url: request.url ?? "",
        host: request.headers.host,
        agent: request.headers["user-agent"],
      });
      if (request.url === "/hello") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("hello");
      } else if (request.url === "/start") {
        response.writeHead(302, { location: "/hello" });
        response.end();
      } else if (request.url === "/gzip") {
        response.writeHead(200, { "content-encoding": "gzip" });
        response.end(gzipSync(Buffer.from("zipped over the wire")));
      } else if (request.url === "/big") {
        response.writeHead(200);
        response.end(Buffer.alloc(64 * 1024, 120));
      } else if (request.url === "/slow") {
        setTimeout(() => response.end("late"), 2000).unref();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const realFetch = (allowPrivateNetwork: boolean): SafeFetch =>
    createSafeFetch({
      allowPrivateNetwork,
      userAgent: USER_AGENT,
      clock: fixedClock(),
      resolveHost: async (host) =>
        host === "pinned.localhost" ? ["127.0.0.1"] : resolveHost(host),
    });

  it("refuses loopback by default without connecting", async () => {
    seen.length = 0;
    await expect(realFetch(false)(`http://127.0.0.1:${port}/hello`)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(seen).toHaveLength(0);
  });

  it("connects to the pinned address, follows redirects and decompresses", async () => {
    seen.length = 0;
    const fetch = realFetch(true);
    const response = await fetch(`http://pinned.localhost:${port}/start`);
    expect(await response.text()).toBe("hello");
    expect(response.url).toBe(`http://pinned.localhost:${port}/hello`);
    expect(seen).toEqual([
      { url: "/start", host: `pinned.localhost:${port}`, agent: USER_AGENT },
      { url: "/hello", host: `pinned.localhost:${port}`, agent: USER_AGENT },
    ]);
    expect(await (await fetch(`http://127.0.0.1:${port}/gzip`)).text()).toBe(
      "zipped over the wire",
    );
    await expect(fetch(`http://127.0.0.1:${port}/big`, { maxBytes: 1024 })).rejects.toMatchObject({
      details: { reason: "too_large" },
    });
    await expect(fetch(`http://127.0.0.1:${port}/slow`, { timeoutMs: 100 })).rejects.toMatchObject({
      details: { reason: "timeout" },
    });
  });
});
