/**
 * Message rendering: `{{var}}` resolution with fallbacks, signature, compliance footer and an
 * optional minimal HTML alternative. Plain text first; no tracking pixels, no link rewriting.
 */

/** Template values: standard variables plus `custom.<key>` lookups. */
export interface TemplateVars {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  title?: string | null;
  city?: string | null;
  sender_name?: string | null;
  offer?: string | null;
  booking_url?: string | null;
  custom?: Record<string, unknown>;
  [name: string]: unknown;
}

export interface TemplateResult {
  text: string;
  /** Variables with no value and no fallback, plus unfilled `[[ai: ...]]` slots. */
  missing: string[];
}

const VARIABLE = /\{\{\s*([a-zA-Z_][\w.]*)\s*(?:\|([^}]*))?\}\}/g;
const AI_SLOT = /\[\[\s*ai\s*:[^\]]*\]\]/gi;

function lookup(vars: TemplateVars, name: string): string | null {
  const value = name.startsWith("custom.") ? vars.custom?.[name.slice(7)] : vars[name];
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : String(value);
  return text.trim() === "" ? null : text.trim();
}

/**
 * Replaces `{{name}}`, `{{name|fallback}}` and `{{custom.key}}`. Unknown or empty variables use
 * the fallback; without one they stay in place and are reported in `missing`. `escapeValue` is applied
 * to substituted values (HTML).
 */
export function renderTemplate(
  template: string,
  vars: TemplateVars,
  escapeValue: (value: string) => string = (value) => value,
): TemplateResult {
  const missing = new Set<string>();
  const text = template.replace(VARIABLE, (match, name: string, fallback: string | undefined) => {
    const value = lookup(vars, name);
    if (value !== null) return escapeValue(value);
    if (fallback !== undefined) return escapeValue(fallback.trim());
    missing.add(name);
    return match;
  });
  for (const slot of text.match(AI_SLOT) ?? []) missing.add(slot);
  return { text, missing: [...missing] };
}

/** Footer content decided by the workspace compliance settings. */
export interface FooterContent {
  /** "Company, postal address" identity line (empty to omit). */
  identity?: string | null;
  /** Advertisement disclosure (CAN-SPAM) for recipients in the configured countries. */
  adDisclosure?: string | null;
  /** Unsubscribe page URL (one-click); the line links to it. */
  unsubscribeUrl?: string | null;
  /** No public link: the line asks recipients to reply "unsubscribe" instead. */
  unsubscribeByReply?: boolean;
  /** GDPR source notice for EU/EEA/UK recipients. */
  sourceNotice?: string | null;
}

export interface RenderInput {
  subject: string;
  bodyText: string;
  /** User-provided HTML body; when set an HTML alternative is always produced. */
  bodyHtml?: string | null;
  vars: TemplateVars;
  signature?: string | null;
  footer: FooterContent;
  /** Produce a minimal HTML alternative from the text (tracking campaigns). */
  html?: boolean;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string | null;
  missing: string[];
}

/** Footer unsubscribe line when there is no public link (the reply is read by IMAP sync). */
export const REPLY_UNSUBSCRIBE_LINE = 'Prefer not to hear from us? Reply "unsubscribe" to opt out.';

/** Footer text lines, in order: identity, ad disclosure, unsubscribe, source notice. */
export function footerLines(footer: FooterContent): string[] {
  const lines: string[] = [];
  if (footer.identity?.trim()) lines.push(footer.identity.trim());
  if (footer.adDisclosure?.trim()) lines.push(footer.adDisclosure.trim());
  if (footer.unsubscribeUrl)
    lines.push(`Prefer not to hear from us? Unsubscribe: ${footer.unsubscribeUrl}`);
  else if (footer.unsubscribeByReply) lines.push(REPLY_UNSUBSCRIBE_LINE);
  if (footer.sourceNotice?.trim()) lines.push(footer.sourceNotice.trim());
  return lines;
}

/** Renders subject, plain text body (+ signature + footer) and the optional HTML alternative. */
export function renderEmail(input: RenderInput): RenderedEmail {
  const subject = renderTemplate(input.subject, input.vars);
  const body = renderTemplate(normalizeNewlines(input.bodyText), input.vars);
  const missing = new Set([...subject.missing, ...body.missing]);
  const signature = input.signature?.trim() ? normalizeNewlines(input.signature.trim()) : null;
  const bodyText = body.text.trim();

  const blocks = [bodyText];
  if (signature && !bodyText.includes(signature)) blocks.push(signature);
  const footer = footerLines(input.footer);
  let text = blocks.join("\n\n");
  if (footer.length > 0) text += `\n\n${footer.join("\n")}`;

  let html: string | null = null;
  if (input.bodyHtml?.trim()) {
    const custom = renderTemplate(input.bodyHtml, input.vars, escapeHtml);
    for (const name of custom.missing) missing.add(name);
    html = wrapHtml(
      custom.text.trim(),
      signature && !bodyText.includes(signature) ? signature : null,
      input.footer,
    );
  } else if (input.html) {
    html = wrapHtml(
      textToHtml(bodyText),
      signature && !bodyText.includes(signature) ? signature : null,
      input.footer,
    );
  }

  return { subject: collapseSpaces(subject.text), text, html, missing: [...missing] };
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;

/** Escaped paragraphs with line breaks and clickable links. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => {
      const escaped = escapeHtml(paragraph).replace(
        URL_PATTERN,
        (url) => `<a href="${url}">${url}</a>`,
      );
      return `<p style="margin:0 0 1em 0">${escaped.replaceAll("\n", "<br>")}</p>`;
    })
    .join("\n");
}

function wrapHtml(bodyHtml: string, signature: string | null, footer: FooterContent): string {
  const parts = [bodyHtml];
  if (signature) parts.push(textToHtml(signature));
  const lines: string[] = [];
  if (footer.identity?.trim()) lines.push(escapeHtml(footer.identity.trim()));
  if (footer.adDisclosure?.trim()) lines.push(escapeHtml(footer.adDisclosure.trim()));
  if (footer.unsubscribeUrl) {
    const url = escapeHtml(footer.unsubscribeUrl);
    lines.push(`Prefer not to hear from us? <a href="${url}">Unsubscribe</a>`);
  } else if (footer.unsubscribeByReply) {
    lines.push(escapeHtml(REPLY_UNSUBSCRIBE_LINE));
  }
  if (footer.sourceNotice?.trim()) lines.push(escapeHtml(footer.sourceNotice.trim()));
  if (lines.length > 0) {
    parts.push(
      `<p style="margin:1em 0 0 0;color:#666666;font-size:12px">${lines.join("<br>")}</p>`,
    );
  }
  return `<div>\n${parts.join("\n")}\n</div>`;
}
