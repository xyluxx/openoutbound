import { describe, expect, it } from "vitest";
import { createSystemDns } from "./dns.js";

describe("createSystemDns", () => {
  it("queries the system resolver, which the test network guard blocks", async () => {
    const dns = createSystemDns();
    await expect(dns.resolveMx("mail.example.com")).rejects.toThrow(
      /Network access blocked in tests: dns mail\.example\.com/,
    );
    await expect(dns.resolveTxt("mail.example.com")).rejects.toThrow(/Network access blocked/);
  });
});
