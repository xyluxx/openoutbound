import { TEMPLATE_VARIABLES, type TemplateVariable } from "../../../core/settings.js";

/** Values for template variables (`{{first_name}}`, `{{custom.x}}`, ...). */
export type TemplateVars = Partial<Record<TemplateVariable, string | null>> & {
  custom?: Record<string, unknown>;
};

export interface RenderResult {
  text: string;
  /** Variables without a value and without a fallback (left in the text as is). */
  missing: string[];
  /** Variable names that are not known template variables. */
  unknown: string[];
}

const VARIABLE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|([^}]*))?\}\}/g;
const SLOT = /\[\[\s*ai\s*:([\s\S]*?)\]\]/gi;

function customValue(custom: Record<string, unknown> | undefined, key: string): string | null {
  const value = custom?.[key];
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/**
 * Replaces `{{name}}`, `{{name|fallback}}` and `{{custom.key}}`. A variable without a value uses
 * its fallback; without one it stays in the text and is reported in `missing` (the writing
 * checks then flag it, and the step's missing-data policy applies).
 */
export function renderTemplate(template: string, vars: TemplateVars): RenderResult {
  const missing: string[] = [];
  const unknown: string[] = [];
  const text = template.replace(VARIABLE, (whole, rawName: string, fallback?: string) => {
    const name = rawName.trim();
    let value: string | null = null;
    if (name.startsWith("custom.")) {
      value = customValue(vars.custom, name.slice("custom.".length));
    } else if ((TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      const raw = vars[name as TemplateVariable];
      value = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    } else {
      unknown.push(name);
      return whole;
    }
    if (value !== null) return value;
    if (fallback !== undefined) return fallback.trim();
    missing.push(name);
    return whole;
  });
  return { text, missing: [...new Set(missing)], unknown: [...new Set(unknown)] };
}

export interface Slot {
  index: number;
  instruction: string;
}

/** `[[ai: instruction]]` slots in order. */
export function extractSlots(template: string): Slot[] {
  return [...template.matchAll(SLOT)].map((match, index) => ({
    index,
    instruction: (match[1] ?? "").trim(),
  }));
}

/** Replaces slots in order with the given values (missing values leave the slot in place). */
export function fillSlots(template: string, values: ReadonlyMap<number, string>): string {
  let index = 0;
  return template.replace(SLOT, (whole) => {
    const value = values.get(index);
    index += 1;
    return value === undefined ? whole : value.trim();
  });
}

/** Template with slots numbered for prompts: `[[slot 0: instruction]]`. */
export function numberSlots(template: string): string {
  let index = 0;
  return template.replace(SLOT, (_whole, instruction: string) => {
    const label = `[[slot ${index}: ${instruction.trim()}]]`;
    index += 1;
    return label;
  });
}
