import type { WorkspaceSettings } from "../../core/settings.js";
import type { FooterContent } from "./render.js";

/** EU member states, the other EEA countries and the UK (GDPR / UK GDPR source notice). */
const GDPR_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO",
  "GB",
]);

/** Country-code top-level domains of GDPR countries (`uk` and `eu` included). */
const GDPR_TLDS = new Set([
  ...[...GDPR_COUNTRIES].map((code) => code.toLowerCase()).filter((code) => code !== "gb"),
  "uk",
  "eu",
]);

/**
 * True when GDPR (or UK GDPR) applies: the person's (or company's) country is in the EU, EEA or
 * UK, or, with no country known, the email domain uses one of their country TLDs.
 */
export function isGdprRecipient(country: string | null | undefined, email: string): boolean {
  if (country?.trim()) return GDPR_COUNTRIES.has(country.trim().toUpperCase());
  const tld = email.slice(email.lastIndexOf(".") + 1).toLowerCase();
  return GDPR_TLDS.has(tld);
}

/** Human wording for a person's `source` (GDPR Art. 14 asks for the source of the data). */
export function sourceLabel(source: string | null | undefined): string {
  const value = (source ?? "").toLowerCase();
  if (value.includes("apollo")) return "a B2B contact database (Apollo)";
  if (value.includes("google_maps") || value.includes("maps"))
    return "your public business listing";
  if (value.includes("website") || value.includes("crawl")) return "your company website";
  if (value.includes("linkedin")) return "your public LinkedIn profile";
  if (value.includes("referral")) return "a referral from a colleague";
  if (["csv", "xlsx", "json", "rows", "import", "api"].some((word) => value.includes(word))) {
    return "a business contact list we compiled";
  }
  return "public business sources";
}

export interface FooterInput {
  /** Recipient country (person.country, else the company country); null when unknown. */
  country: string | null | undefined;
  email: string;
  source: string | null | undefined;
  /**
   * Unsubscribe link, or null when the engine has no public https base URL (the footer then asks
   * recipients to reply "unsubscribe").
   */
  unsubscribeUrl: string | null;
}

/**
 * Footer of every prospect email (campaign steps and replies): sender identity with the postal
 * address, the ad disclosure where configured, the unsubscribe line and the GDPR source notice.
 * The unsubscribe line and the postal address are always there (CAN-SPAM, GDPR);
 * compliance.include_unsubscribe_link and include_postal_address only apply to system and
 * notification email.
 */
export function buildFooter(settings: WorkspaceSettings, input: FooterInput): FooterContent {
  const { company, compliance } = settings;
  const sender = company.sender_company_line.trim() || company.name.trim();
  const identity = [sender, company.postal_address.trim()].filter(Boolean).join(", ");
  const unsubscribeUrl = input.unsubscribeUrl?.trim() || null;
  // Unknown country: include the disclosure (the safe default).
  const country = input.country?.trim().toUpperCase() || null;
  const disclosure = compliance.ad_disclosure;
  const adDisclosure =
    disclosure.text.trim() && (country === null || disclosure.countries.includes(country))
      ? disclosure.text.trim()
      : null;
  let sourceNotice: string | null = null;
  if (compliance.gdpr_source_notice && isGdprRecipient(input.country, input.email)) {
    const objection = unsubscribeUrl
      ? "reply or use the unsubscribe link to object"
      : "reply to object";
    sourceNotice = `Data source: ${sourceLabel(input.source)}. We contact you based on legitimate interest (GDPR Art. 6(1)(f)); ${objection}.`;
  }
  return {
    identity: identity || null,
    adDisclosure,
    unsubscribeUrl,
    unsubscribeByReply: !unsubscribeUrl,
    sourceNotice,
  };
}
