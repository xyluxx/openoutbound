import { describe, expect, it } from "vitest";
import { isSecretField, REDACTED, redact } from "./redact.js";

describe("redact", () => {
  it("hides secret fields, key-shaped values and Slack webhook URLs", () => {
    const out = redact({
      api_key: "sk-live-123",
      nested: { accessToken: "abc", password: "hunter2" },
      name: "Harbor Dental",
      url: "https://hooks.slack.com/services/T000/B000/XXXX",
      website: "https://harbor.example.com",
      key: `oo_${"a".repeat(43)}`,
    }) as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED);
    expect(out.nested).toEqual({ accessToken: REDACTED, password: REDACTED });
    expect(out.name).toBe("Harbor Dental");
    expect(out.url).toBe(REDACTED);
    expect(out.website).toBe("https://harbor.example.com");
    expect(out.key).toBe(REDACTED);
  });

  it("keeps counters and ids that only look similar", () => {
    expect(isSecretField("input_tokens")).toBe(false);
    expect(isSecretField("secret_id")).toBe(false);
    expect(isSecretField("webhook_url")).toBe(true);
  });

  it("truncates long strings", () => {
    const out = redact({ body: "x".repeat(600) }, { maxString: 100 }) as { body: string };
    expect(out.body.startsWith("x".repeat(100))).toBe(true);
    expect(out.body.length).toBeLessThan(200);
  });
});
