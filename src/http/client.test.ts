import { describe, expect, it } from "vitest";
import { providerFailure, retryAfterOf } from "../core/failures.js";
import { createRemoteClient } from "./client.js";
import { problemResponse } from "./problem.js";

describe("remote client errors", () => {
  it("keeps the provider failure and its wait from a problem body", async () => {
    const client = createRemoteClient({
      url: "http://127.0.0.1:7331",
      apiKey: null,
      fetch: async () =>
        problemResponse(
          providerFailure({
            provider: "apollo",
            name: "Apollo",
            class: "rate_limited",
            upstreamStatus: 429,
            retryAfterSeconds: 45,
          }),
        ),
    });
    const error = await client.call("leads.search", {}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "provider_error",
      retryAfterSeconds: 45,
      details: { failure: { class: "rate_limited", retry_after_s: 45 } },
    });
    expect(retryAfterOf(error)).toBe(45);
  });
});
