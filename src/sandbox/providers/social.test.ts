import { describe, expect, it } from "vitest";
import { fixedClock } from "../../core/clock.js";
import type { ProviderRuntime } from "../../providers/types.js";
import { createSandboxSocial } from "./social.js";

function runtime(): ProviderRuntime {
  return {
    fetch: fetch,
    safeFetch: (() => {
      throw new Error("not used");
    }) as unknown as ProviderRuntime["safeFetch"],
    log: { info: () => {}, warn: () => {}, error: () => {} } as unknown as ProviderRuntime["log"],
    clock: fixedClock(),
    baseUrl: "http://localhost:7331",
    workspaceId: "ws_test",
    db: {} as ProviderRuntime["db"],
  };
}

describe("sandbox social publisher", () => {
  it("publishes to an example.com URL", async () => {
    const social = createSandboxSocial(runtime());
    const result = await social.publish({
      accountRef: { provider: "sandbox", account_id: "acct_1" },
      text: "Hello",
    });
    expect(new URL(result.url ?? "").hostname).toBe("posts.example.com");
    expect(result.externalId).toBeTruthy();
  });

  it("is deterministic for the same text at the same clock time", async () => {
    const social = createSandboxSocial(runtime());
    const a = await social.publish({
      accountRef: { provider: "sandbox", account_id: "acct_1" },
      text: "Hello",
    });
    const b = await social.publish({
      accountRef: { provider: "sandbox", account_id: "acct_1" },
      text: "Hello",
    });
    expect(a).toEqual(b);
  });
});
