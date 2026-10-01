import dns from "node:dns";
import { lookup, Resolver, resolveTxt } from "node:dns/promises";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { allowNetwork, isHostAllowed } from "./setup-no-network.js";

describe("no-network guard", () => {
  it("blocks fetch to external hosts", async () => {
    await expect(fetch("https://api.example.com/v1")).rejects.toThrow(/Network access blocked/);
  });

  it("blocks raw sockets to external hosts", () => {
    expect(() => net.connect({ host: "db.example.com", port: 5432 })).toThrow(
      /Network access blocked/,
    );
  });

  it("blocks direct DNS queries for external names", async () => {
    const blockedDns = /Network access blocked in tests: dns mail\.example\.com/;
    await expect(new Resolver().resolveMx("mail.example.com")).rejects.toThrow(blockedDns);
    await expect(resolveTxt("mail.example.com")).rejects.toThrow(blockedDns);
    await expect(lookup("mail.example.com")).rejects.toThrow(blockedDns);
    expect(() => dns.resolveMx("mail.example.com", () => {})).toThrow(blockedDns);
    expect(() => new dns.Resolver().resolveTxt("mail.example.com", () => {})).toThrow(blockedDns);
    expect(() => dns.lookup("mail.example.com", () => {})).toThrow(blockedDns);
  });

  it("still resolves localhost and IP literals", async () => {
    expect((await lookup("localhost")).address).toMatch(/^(127\.0\.0\.1|::1)$/);
    expect((await lookup("192.0.2.10")).address).toBe("192.0.2.10");
  });

  it("allows localhost and explicitly allowed hosts for one test", () => {
    expect(isHostAllowed("localhost")).toBe(true);
    expect(isHostAllowed("127.0.0.1")).toBe(true);
    expect(isHostAllowed("api.example.com")).toBe(false);
    allowNetwork("api.example.com", /\.example\.org$/);
    expect(isHostAllowed("api.example.com")).toBe(true);
    expect(isHostAllowed("cdn.example.org")).toBe(true);
  });

  it("resets allowances after each test", () => {
    expect(isHostAllowed("api.example.com")).toBe(false);
  });
});
