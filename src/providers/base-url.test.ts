import { describe, expect, it } from "vitest";
import { builtinProviders } from "./all.js";
import type { ProviderDefinition } from "./types.js";

/** Issues of a parse that concern `base_url` (other required settings may fail on their own). */
function baseUrlIssues(definition: ProviderDefinition, value: string): number {
  const result = definition.configSchema?.safeParse({ base_url: value });
  if (!result || result.success) return 0;
  return result.error.issues.filter((issue) => issue.path[0] === "base_url").length;
}

const withBaseUrl = builtinProviders.filter((definition) => {
  const shape = (definition.configSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return shape !== undefined && "base_url" in shape;
});

describe("provider base_url settings", () => {
  it("are found on the providers that take one", () => {
    expect(withBaseUrl.length).toBeGreaterThanOrEqual(10);
  });

  // Several providers send their key in the query string, so an address the fetch cannot parse
  // would come back in error messages with the key in it.
  it.each(withBaseUrl.map((definition) => [`${definition.slot}:${definition.id}`, definition]))(
    "%s accepts only an http(s) address",
    (_name, definition) => {
      for (const bad of ["api.example.com", "api.example.com/v1?api=k", "ftp://api.example.com"]) {
        expect(baseUrlIssues(definition, bad), bad).toBeGreaterThan(0);
      }
      expect(baseUrlIssues(definition, "https://api.example.com/v1")).toBe(0);
    },
  );
});
