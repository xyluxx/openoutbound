import { z } from "zod";
import { definePrompt, UNTRUSTED_CONTENT_RULE, wrapUntrusted } from "../../../brain/prompt.js";

export interface ImportMappingVars {
  /** Headers the heuristics could not map, with a few sample values each. */
  columns: Array<{ header: string; samples: string[] }>;
  /** Allowed target fields with one-line meanings. */
  fields: Array<{ field: string; meaning: string }>;
}

/**
 * Maps spreadsheet columns the synonym table did not recognize (fast tier). Sample rows are
 * untrusted file content, wrapped and treated as data.
 */
export const importMappingPrompt = definePrompt({
  id: "leads.import_map_columns",
  version: 1,
  tier: "fast",
  maxTokens: 1200,
  temperature: 0,
  system: () =>
    [
      "You map spreadsheet columns of a B2B lead list to database fields.",
      'For each column answer with one allowed field, "custom" to keep it as a custom field, or "ignore" for columns that carry no useful lead data (row numbers, internal ids of other tools, empty columns).',
      "Use each allowed field at most once. Prefer custom over guessing when unsure.",
      UNTRUSTED_CONTENT_RULE,
    ].join("\n"),
  user: (vars: ImportMappingVars) =>
    [
      "Allowed fields:",
      ...vars.fields.map((f) => `- ${f.field}: ${f.meaning}`),
      "",
      "Columns with sample values:",
      wrapUntrusted(
        "imported_file",
        vars.columns
          .map(
            (c) =>
              `${c.header}: ${c.samples.map((s) => JSON.stringify(s.slice(0, 80))).join(", ")}`,
          )
          .join("\n"),
      ),
    ].join("\n"),
  schema: z.object({
    mappings: z.array(z.object({ header: z.string(), field: z.string() })),
  }),
});
