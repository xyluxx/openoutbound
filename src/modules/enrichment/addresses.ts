/**
 * Email address helpers for enrichment: role versus personal addresses, name variants,
 * matching a published address to a person, and pattern guesses (first.last@, first@,
 * flast@, firstlast@). Pure functions.
 */
import { isBlockedRoleAddress } from "../leads/role-address.js";

/** Shared business inboxes: usable as a verified fallback when settings allow. */
const ROLE_PARTS = new Set([
  "info",
  "contact",
  "contacts",
  "kontakt",
  "hello",
  "hallo",
  "hi",
  "office",
  "buero",
  "mail",
  "email",
  "post",
  "praxis",
  "kanzlei",
  "team",
  "sales",
  "vertrieb",
  "support",
  "service",
  "admin",
  "reception",
  "rezeption",
  "empfang",
  "booking",
  "bookings",
  "appointments",
  "termin",
  "termine",
  "enquiries",
  "inquiries",
  "enquiry",
  "inquiry",
  "welcome",
  "general",
  "marketing",
  "bonjour",
  "ciao",
  "hola",
  "contacto",
  "contatto",
  "info-de",
]);

/** Addresses that are never outreach contacts (legal, technical, hiring, no-reply). */
const IGNORED_PARTS = new Set([
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
  "privacy",
  "datenschutz",
  "dsgvo",
  "gdpr",
  "dpo",
  "abuse",
  "postmaster",
  "hostmaster",
  "webmaster",
  "security",
  "jobs",
  "job",
  "careers",
  "career",
  "karriere",
  "bewerbung",
  "bewerbungen",
  "recruiting",
  "hr",
  "press",
  "presse",
  "media",
  "billing",
  "invoice",
  "invoices",
  "rechnung",
  "rechnungen",
  "accounting",
  "buchhaltung",
  "legal",
  "unsubscribe",
  "newsletter",
]);

export type AddressKind = "personal" | "role" | "ignored";

/** personal (a named person), role (shared inbox like info@) or ignored (no-reply, privacy, jobs). */
export function addressKind(email: string): AddressKind {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  const first = local.split(/[.+_-]/)[0] ?? local;
  if (isBlockedRoleAddress(email)) return "ignored";
  if (IGNORED_PARTS.has(local) || IGNORED_PARTS.has(first)) return "ignored";
  if (ROLE_PARTS.has(local) || ROLE_PARTS.has(first)) return "role";
  return "personal";
}

const GERMAN: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/**
 * Lowercase ASCII spellings of a name part used in addresses: "Müller" gives mueller and
 * muller, "José" gives jose, "Anne-Marie" gives annemarie.
 */
export function nameVariants(value: string | null | undefined): string[] {
  const lower = value?.trim().toLowerCase() ?? "";
  if (!lower) return [];
  const spelled = [lower.replace(/[äöüß]/g, (c) => GERMAN[c] ?? c), lower];
  const out = spelled.map((v) =>
    v
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z]/g, ""),
  );
  return [...new Set(out.filter(Boolean))];
}

/** Local parts a person's address commonly uses, most common first. */
export function nameLocalParts(
  first: string | null | undefined,
  last: string | null | undefined,
): string[] {
  const out: string[] = [];
  const firsts = nameVariants(first);
  const lasts = nameVariants(last);
  for (const f of firsts) {
    for (const l of lasts) {
      const i = f[0] ?? "";
      out.push(
        `${f}.${l}`,
        `${f}_${l}`,
        `${f}-${l}`,
        `${f}${l}`,
        `${i}${l}`,
        `${i}.${l}`,
        `${l}.${f}`,
        `${l}${f}`,
        `${f}${l[0] ?? ""}`,
        `${f}.${l[0] ?? ""}`,
        l,
      );
    }
    out.push(f);
  }
  if (firsts.length === 0) out.push(...lasts);
  return [...new Set(out.filter((part) => part.length >= 2))];
}

/** True when the address's local part is a usual spelling of the person's name. */
export function addressMatchesName(
  email: string,
  first: string | null | undefined,
  last: string | null | undefined,
): boolean {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  return nameLocalParts(first, last).includes(local);
}

/** The pattern guesses tried when `pattern_guessing` is on (at most four, each verified). */
export function guessAddresses(
  first: string | null | undefined,
  last: string | null | undefined,
  domain: string,
): string[] {
  const f = nameVariants(first)[0];
  const l = nameVariants(last)[0];
  if (!f) return [];
  const locals = l ? [`${f}.${l}`, f, `${f[0]}${l}`, `${f}${l}`] : [f];
  return [...new Set(locals)].map((local) => `${local}@${domain}`);
}
