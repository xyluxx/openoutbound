import { describe, expect, it } from "vitest";
import { BLOCKED_ROLE_LOCAL_PARTS, isBlockedRoleAddress } from "./role-address.js";

describe("isBlockedRoleAddress", () => {
  it("blocks system, abuse and no-reply mailboxes in any spelling", () => {
    for (const local of BLOCKED_ROLE_LOCAL_PARTS) {
      expect(isBlockedRoleAddress(`${local}@clinic.example.com`), local).toBe(true);
    }
    for (const email of [
      "No_Reply@clinic.example.com",
      "no.reply@clinic.example.com",
      "noreply+invoices@clinic.example.com",
      "DO_NOT_REPLY@clinic.example.com",
      "Mailer_Daemon@clinic.example.com",
    ]) {
      expect(isBlockedRoleAddress(email), email).toBe(true);
    }
  });

  it("keeps business inboxes and personal addresses", () => {
    for (const email of [
      "info@clinic.example.com",
      "sales@clinic.example.com",
      "contact@clinic.example.com",
      "hello@clinic.example.com",
      "office@clinic.example.com",
      "dana.rivers@clinic.example.com",
      "root.beer@clinic.example.com",
      "spamalot@clinic.example.com",
    ]) {
      expect(isBlockedRoleAddress(email), email).toBe(false);
    }
    expect(isBlockedRoleAddress(null)).toBe(false);
    expect(isBlockedRoleAddress("@clinic.example.com")).toBe(false);
  });
});
