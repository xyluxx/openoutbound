import { describe, expect, it } from "vitest";
import { BUILTIN_DEFINITIONS } from "../signals/catalog.js";
import { BUILTIN_SIGNALS } from "./signal-catalog.js";

describe("built-in signal catalog", () => {
  it("offers bootstrap exactly the signals the signals module defines", () => {
    const defined = BUILTIN_DEFINITIONS.map((definition) => definition.key).sort();
    expect(Object.keys(BUILTIN_SIGNALS).sort()).toEqual(defined);
  });
});
