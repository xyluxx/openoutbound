/**
 * Evidence rules (playbook-signals section 6): every signal has an evidence URL. Public
 * evidence is an http(s) URL; first-party evidence may be an internal reference
 * (`openoutbound://messages/<id>`).
 */
import { createHash } from "node:crypto";
import { OpenOutboundError } from "../../core/errors.js";

export const INTERNAL_SCHEME = "openoutbound:";
const MAX_URL_LENGTH = 2000;
const TRACKING_PARAMS =
  /^(utm_[a-z_]+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_src|_hsenc|_hsmi)$/i;

/** Internal evidence reference for first-party records, e.g. `openoutbound://messages/msg_...`. */
export function internalEvidenceUrl(kind: string, id: string): string {
  return `openoutbound://${kind}/${encodeURIComponent(id)}`;
}

/**
 * Canonical evidence URL: http(s) or openoutbound scheme, lowercase host, no default port,
 * no fragment, no tracking parameters, sorted query, no trailing slash. Null when invalid.
 */
export function canonicalEvidenceUrl(input: string | null | undefined): string | null {
  const value = (input ?? "").trim();
  if (!value || value.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === INTERNAL_SCHEME) {
    return url.host && url.pathname.length > 1 ? url.toString() : null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  url.hash = "";
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAMS.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [name, param] of kept) url.searchParams.append(name, param);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  const text = url.toString();
  return url.pathname === "/" && !url.search ? text.replace(/\/$/, "") : text;
}

/** Like canonicalEvidenceUrl, but throws an actionable `validation_failed` error. */
export function requireEvidenceUrl(input: string | null | undefined): string {
  const url = canonicalEvidenceUrl(input);
  if (url) return url;
  const missing = !(input ?? "").trim();
  throw new OpenOutboundError(
    "validation_failed",
    missing
      ? "A signal needs an evidence_url: no URL, no signal."
      : `The evidence_url "${String(input).slice(0, 200)}" is not a valid http(s) URL.`,
    {
      hint: "Pass evidence_url as the public page that proves the signal (https://...). Store facts without a source as research notes instead.",
      details: { field: "evidence_url" },
    },
  );
}

/**
 * Dedupe key: `<definition key>:<provided key>` when the source gives a stable key, else
 * `<definition key>:<person or company id>:<canonical evidence URL>`. Long keys are hashed.
 */
export function buildDedupeKey(input: {
  definitionKey: string;
  companyId: string | null;
  personId: string | null;
  evidenceUrl: string;
  provided?: string | null | undefined;
}): string {
  const provided = input.provided?.trim();
  const tail = provided
    ? provided
    : `${input.personId ?? input.companyId ?? "none"}:${input.evidenceUrl}`;
  const key = `${input.definitionKey}:${tail}`;
  if (key.length <= 400) return key;
  return `${input.definitionKey}:h:${createHash("sha256").update(tail).digest("hex")}`;
}

/** Trims and caps free text; null when empty. */
export function clip(value: string | null | undefined, max: number): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...` : text;
}
