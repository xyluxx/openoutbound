/**
 * Rule-based ICP fit score (0-100) with one reason per configured criterion (matched, missed
 * or unknown, with points earned out of the weight). Disqualifiers set the score to 0.
 * Missing data (no industry, size, location, title, ...) is unknown, never a miss: it earns
 * unknown_share of the weight and the reason says "<criterion> unknown".
 * score = round(100 x earned / sum of weights of configured criteria).
 */
import type { Company, FitReason, Person } from "../../../db/schema/index.js";
import { normalizeCountry } from "../countries.js";
import { isFreeMailDomain } from "../free-mail.js";
import { emailDomain, employeeEstimate } from "../normalize.js";
import type { ParsedIcp } from "./criteria.js";
import { resolveSeniority, SENIORITY_RANK, type Seniority } from "./seniority.js";

export type ScorePerson = Pick<
  Person,
  "title" | "seniority" | "department" | "email" | "country" | "region" | "city"
>;
export type ScoreCompany = Pick<
  Company,
  | "name"
  | "domain"
  | "industry"
  | "description"
  | "employee_count"
  | "employee_range"
  | "country"
  | "region"
  | "city"
  | "technologies"
  | "status"
>;

export interface FitResult {
  /** Null when the ICP has no criteria that apply. */
  score: number | null;
  reasons: FitReason[];
  disqualified: boolean;
  /** One line for previews, e.g. "industry, title matched; missed employees". */
  summary: string;
}

const PHRASES: Array<[RegExp, string]> = [
  [/\bvice president\b/g, "vp"],
  [/\bchief executive officer\b/g, "ceo"],
  [/\bchief technology officer\b/g, "cto"],
  [/\bchief operating officer\b/g, "coo"],
  [/\bchief financial officer\b/g, "cfo"],
  [/\bchief marketing officer\b/g, "cmo"],
  [/\bchief revenue officer\b/g, "cro"],
  [/\bops\b/g, "operations"],
  [/\bmgr\b/g, "manager"],
  [/\bdir\b/g, "director"],
  [/\bsr\b/g, "senior"],
];

function singular(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Normalized tokens: lowercase, no accents, hyphens joined, abbreviations expanded, singular. */
export function termTokens(text: string): string[] {
  let value = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[_]+/g, " ")
    .replace(/-/g, "")
    .replace(/[^a-z0-9+#]+/g, " ");
  for (const [pattern, replacement] of PHRASES) value = value.replace(pattern, replacement);
  return value.split(" ").filter(Boolean).map(singular);
}

/** True when every token of `phrase` appears in `text` ("vp operations" in "VP of Operations"). */
export function phraseMatches(text: string | null | undefined, phrase: string): boolean {
  if (!text) return false;
  const tokens = new Set(termTokens(text));
  const wanted = termTokens(phrase);
  return wanted.length > 0 && wanted.every((token) => tokens.has(token));
}

function firstMatch(text: string | null | undefined, phrases: string[]): string | null {
  return phrases.find((phrase) => phraseMatches(text, phrase)) ?? null;
}

function companyText(company: ScoreCompany | null | undefined): string | null {
  if (!company) return null;
  const parts = [
    company.name,
    company.industry,
    company.description,
    ...(company.technologies ?? []),
  ];
  const text = parts.filter(Boolean).join(" \n ");
  return text || null;
}

function countriesOf(values: string[]): string[] {
  return values
    .map((value) => normalizeCountry(value))
    .filter((code): code is string => Boolean(code));
}

/** Scores a person (with their company) or a company alone against an ICP. */
export function scoreFit(
  icp: ParsedIcp,
  subject: { person?: ScorePerson | null; company?: ScoreCompany | null },
): FitResult {
  const { criteria, scoring } = icp;
  const weights = scoring.weights;
  const person = subject.person ?? null;
  const company = subject.company ?? null;
  const reasons: FitReason[] = [];
  const exclusions: FitReason[] = [];
  const exclude = criteria.exclude;
  const country = person?.country ?? company?.country ?? null;
  const text = companyText(company);

  // --- Disqualifiers ------------------------------------------------------------------------
  const disqualify = (rule: string, detail: string) =>
    exclusions.push({ rule: `exclude_${rule}`, points: 0, matched: false, detail });
  if (company?.status && exclude.company_statuses.includes(company.status)) {
    disqualify("company_status", `company status is ${company.status}`);
  }
  const excludedIndustry = firstMatch(company?.industry, exclude.industries);
  if (excludedIndustry) disqualify("industry", `industry matches excluded "${excludedIndustry}"`);
  const excludedKeyword = firstMatch(text, exclude.keywords);
  if (excludedKeyword) disqualify("keyword", `company text mentions excluded "${excludedKeyword}"`);
  const excludedTitle = firstMatch(person?.title, exclude.titles);
  if (excludedTitle) disqualify("title", `title matches excluded "${excludedTitle}"`);
  if (country && countriesOf(exclude.countries).includes(country)) {
    disqualify("country", `country ${country} is excluded`);
  }
  const domains = exclude.domains.map((d) => d.toLowerCase());
  const personDomain = emailDomain(person?.email ?? null);
  if (
    (company?.domain && domains.includes(company.domain)) ||
    (personDomain && domains.includes(personDomain))
  ) {
    disqualify("domain", "company domain is excluded");
  }
  if (exclude.free_mail && personDomain && isFreeMailDomain(personDomain)) {
    disqualify("free_mail", `personal mailbox domain ${personDomain}`);
  }
  const employees = company ? employeeEstimate(company) : null;
  const limits = criteria.employee_limits;
  if (limits && employees !== null) {
    if (
      (limits.min !== undefined && employees < limits.min) ||
      (limits.max !== undefined && employees > limits.max)
    ) {
      disqualify("employees", `${employees} employees is outside the hard limits`);
    }
  }
  if (exclusions.length > 0) {
    return {
      score: 0,
      reasons: exclusions,
      disqualified: true,
      summary: `disqualified: ${exclusions.map((r) => r.detail).join("; ")}`,
    };
  }

  // --- Criteria -------------------------------------------------------------------------------
  const unknownShare = scoring.unknown_share;
  let earned = 0;
  let possible = 0;
  const unknownRules = new Set<string>();
  const add = (rule: string, weight: number, points: number, matched: boolean, detail: string) => {
    if (weight <= 0) return;
    const rounded = Math.round(points * 10) / 10;
    possible += weight;
    earned += rounded;
    reasons.push({ rule, points: rounded, matched, detail: `${detail} (${rounded}/${weight})` });
  };
  const unknown = (rule: string, weight: number, what: string) => {
    if (weight > 0) unknownRules.add(rule);
    add(rule, weight, weight * unknownShare, false, `${what} unknown`);
  };

  if (criteria.industries.length || criteria.industries_adjacent.length) {
    const w = weights.industry;
    const industryText = company?.industry || null;
    const fallbackText = industryText ?? text;
    const core =
      firstMatch(industryText, criteria.industries) ??
      firstMatch(fallbackText, criteria.industries);
    const adjacent = core
      ? null
      : (firstMatch(industryText, criteria.industries_adjacent) ??
        firstMatch(fallbackText, criteria.industries_adjacent));
    if (core) add("industry", w, w, true, `industry matches "${core}"`);
    else if (adjacent) add("industry", w, w / 2, true, `industry is adjacent ("${adjacent}")`);
    // No industry on record (CSV rows, Apollo previews): a name or description that does not
    // name a target proves nothing, so this is unknown, not a wrong industry.
    else if (!industryText) unknown("industry", w, "industry");
    else add("industry", w, 0, false, `industry "${industryText}" is not a target`);
  }

  if (criteria.employee_range) {
    const w = weights.employees;
    const { min, max } = criteria.employee_range;
    if (employees === null) unknown("employees", w, "company size");
    else if ((min === undefined || employees >= min) && (max === undefined || employees <= max)) {
      add("employees", w, w, true, `${employees} employees is in range`);
    } else if (
      (min === undefined || employees >= min / 2) &&
      (max === undefined || employees <= max * 2)
    ) {
      add("employees", w, w / 2, false, `${employees} employees is near the range`);
    } else add("employees", w, 0, false, `${employees} employees is out of range`);
  }

  if (criteria.countries.length || criteria.countries_secondary.length || criteria.regions.length) {
    const w = weights.geography;
    const places = [person?.region, person?.city, company?.region, company?.city]
      .filter(Boolean)
      .join(" \n ");
    const region = firstMatch(places, criteria.regions);
    if (region) add("geography", w, w, true, `located in ${region}`);
    else if (country && countriesOf(criteria.countries).includes(country)) {
      add("geography", w, w, true, `country ${country} is a core market`);
    } else if (country && countriesOf(criteria.countries_secondary).includes(country)) {
      add("geography", w, w / 2, true, `country ${country} is a secondary market`);
    } else if (!country && !places) unknown("geography", w, "location");
    else add("geography", w, 0, false, `location ${country ?? places} is not a target market`);
  }

  if (criteria.technologies.length) {
    const w = weights.technologies;
    const technologies = company?.technologies ?? [];
    const hit = criteria.technologies.find((tech) =>
      technologies.some((used) => phraseMatches(used, tech)),
    );
    if (hit) add("technologies", w, w, true, `uses ${hit}`);
    else if (technologies.length === 0) unknown("technologies", w, "technologies");
    else add("technologies", w, 0, false, "none of the target technologies");
  }

  if (criteria.keywords.length) {
    const w = weights.keywords;
    const haystack = [text, person?.title].filter(Boolean).join(" \n ");
    const hit = firstMatch(haystack, criteria.keywords);
    if (hit) add("keywords", w, w, true, `mentions "${hit}"`);
    else if (!haystack) unknown("keywords", w, "company description");
    else add("keywords", w, 0, false, "no target keywords");
  }

  if (person) {
    if (criteria.titles.length) {
      const w = weights.title;
      const hit = firstMatch(person.title, criteria.titles);
      if (hit) add("title", w, w, true, `title matches "${hit}"`);
      else if (!person.title) unknown("title", w, "title");
      else add("title", w, 0, false, `title "${person.title}" is not a target`);
    }
    if (criteria.seniorities.length) {
      const w = weights.seniority;
      const level = resolveSeniority(person.seniority, person.title);
      if (!level) unknown("seniority", w, "seniority");
      else if (criteria.seniorities.includes(level))
        add("seniority", w, w, true, `seniority ${level}`);
      else if (
        criteria.seniorities.some(
          (wanted: Seniority) => Math.abs(SENIORITY_RANK[wanted] - SENIORITY_RANK[level]) === 1,
        )
      ) {
        add("seniority", w, w / 2, false, `seniority ${level} is one level off`);
      } else add("seniority", w, 0, false, `seniority ${level} is not a target`);
    }
    if (criteria.departments.length) {
      const w = weights.department;
      const hit =
        firstMatch(person.department, criteria.departments) ??
        firstMatch(person.title, criteria.departments);
      if (hit) add("department", w, w, true, `department ${hit}`);
      else if (!person.department && !person.title) unknown("department", w, "department");
      else add("department", w, 0, false, "not in a target department");
    }
  }

  if (possible === 0) {
    return { score: null, reasons: [], disqualified: false, summary: "no ICP criteria apply" };
  }
  const score = Math.max(0, Math.min(100, Math.round((100 * earned) / possible)));
  return { score, reasons, disqualified: false, summary: summarize(reasons, unknownRules) };
}

function summarize(reasons: FitReason[], unknownRules: ReadonlySet<string>): string {
  const matched = reasons.filter((r) => r.matched).map((r) => r.rule);
  const unknowns = reasons.filter((r) => !r.matched && unknownRules.has(r.rule)).map((r) => r.rule);
  const missed = reasons.filter((r) => !r.matched && !unknownRules.has(r.rule)).map((r) => r.rule);
  const parts: string[] = [];
  if (matched.length) parts.push(`${matched.join(", ")} matched`);
  if (missed.length) parts.push(`missed ${missed.join(", ")}`);
  if (unknowns.length) parts.push(`unknown ${unknowns.join(", ")}`);
  return parts.join("; ");
}
