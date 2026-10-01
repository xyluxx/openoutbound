import { describe, expect, it } from "vitest";
import {
  addressKind,
  addressMatchesName,
  guessAddresses,
  nameLocalParts,
  nameVariants,
} from "./addresses.js";

describe("addressKind", () => {
  it.each([
    ["dana.rivers@brightsmile.test", "personal"],
    ["drivers@brightsmile.test", "personal"],
    ["info@brightsmile.test", "role"],
    ["praxis-mueller@brightsmile.test", "role"],
    ["kontakt@brightsmile.test", "role"],
    ["hello@brightsmile.test", "role"],
    ["noreply@brightsmile.test", "ignored"],
    ["datenschutz@brightsmile.test", "ignored"],
    ["jobs@brightsmile.test", "ignored"],
    ["press.office@brightsmile.test", "ignored"],
  ])("%s is %s", (email, kind) => {
    expect(addressKind(email)).toBe(kind);
  });
});

describe("name matching", () => {
  it("spells umlauts and accents both ways", () => {
    expect(nameVariants("Müller")).toEqual(["mueller", "muller"]);
    expect(nameVariants("José")).toEqual(["jose"]);
    expect(nameVariants("Anne-Marie")).toEqual(["annemarie"]);
    expect(nameVariants("  ")).toEqual([]);
  });

  it("matches the usual local parts of a person", () => {
    for (const local of [
      "dana.rivers",
      "dana",
      "drivers",
      "d.rivers",
      "danarivers",
      "rivers.dana",
      "dana_rivers",
      "danar",
    ]) {
      expect(addressMatchesName(`${local}@brightsmile.test`, "Dana", "Rivers")).toBe(true);
    }
    expect(addressMatchesName("info@brightsmile.test", "Dana", "Rivers")).toBe(false);
    expect(addressMatchesName("marco@brightsmile.test", "Dana", "Rivers")).toBe(false);
    expect(addressMatchesName("jens.mueller@praxis.test", "Jens", "Müller")).toBe(true);
    expect(addressMatchesName("j.muller@praxis.test", "Jens", "Müller")).toBe(true);
    expect(nameLocalParts(null, "Rivers")).toEqual(["rivers"]);
  });

  it("guesses at most four common patterns", () => {
    expect(guessAddresses("Dana", "Rivers", "brightsmile.test")).toEqual([
      "dana.rivers@brightsmile.test",
      "dana@brightsmile.test",
      "drivers@brightsmile.test",
      "danarivers@brightsmile.test",
    ]);
    expect(guessAddresses("Dana", null, "brightsmile.test")).toEqual(["dana@brightsmile.test"]);
    expect(guessAddresses(null, "Rivers", "brightsmile.test")).toEqual([]);
  });
});
