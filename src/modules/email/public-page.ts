import type { Context } from "hono";
import { escapeHtml } from "./render.js";

const STYLE =
  "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}" +
  "button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid currentColor;background:none;cursor:pointer}";

/** A tiny self-contained HTML page for the public routes (unsubscribe, OAuth callback). */
export function renderPage(title: string, paragraphs: string[], form?: { button: string }): string {
  const body = paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const action = form
    ? `<form method="post"><button type="submit">${escapeHtml(form.button)}</button></form>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1>${body}${action}</body></html>`;
}

/** Sends a page with headers that keep tokens out of caches, referrers and frames. */
export function sendPage(c: Context, status: 200 | 400 | 404 | 500, html: string): Response {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  );
  return c.html(html, status);
}

/** "d***@example.com": enough to recognize the address without printing it in full. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "your address";
  return `${email[0]}***${email.slice(at)}`;
}
