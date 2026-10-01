/**
 * Links in reply text and how they compare. Two links are the same only as whole URLs: same
 * scheme, host, path, query and fragment, ignoring case, trailing sentence punctuation, trailing
 * slashes and the order of query parameters. With `ignoreTag`, the booking tag (see
 * `isBookingTagParam`) is left out, so the tagged and the plain booking link are the same link.
 * A longer link that merely starts with an allowed one (another host or path) never matches.
 */
import { isBookingTagParam } from "./booking-links.js";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The http(s) links in a text, as written (trailing punctuation included). */
export function linksIn(text: string): string[] {
  return text.match(URL_PATTERN) ?? [];
}

/** The text with its http(s) links blanked out. */
export function withoutLinks(text: string): string {
  return text.replace(URL_PATTERN, " ");
}

/** A link as shown in messages: trimmed, without trailing sentence punctuation. */
export function displayLink(link: string): string {
  return link.trim().replace(TRAILING_PUNCTUATION, "");
}

/** The comparable form of an http(s) link, or null when it is not one. */
export function linkKey(link: string, options: { ignoreTag?: boolean } = {}): string | null {
  const text = displayLink(link).toLowerCase();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const params = [...url.searchParams.entries()]
    .filter(([key, value]) => !(options.ignoreTag && isBookingTagParam(key, value)))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .sort();
  const path = url.pathname.replace(/\/+$/, "");
  const query = params.length > 0 ? `?${params.join("&")}` : "";
  return `${url.protocol}//${url.host}${path}${query}${url.hash}`;
}

/**
 * Comparable forms of the links a reply may contain. A configured link without a scheme (a
 * website saved as `example.org`) allows both its https and its http form.
 */
export function allowedLinkKeys(links: string[], options: { ignoreTag?: boolean } = {}): string[] {
  return links
    .map((link) => link.trim())
    .filter(Boolean)
    .flatMap((link) => (HAS_SCHEME.test(link) ? [link] : [`https://${link}`, `http://${link}`]))
    .map((link) => linkKey(link, options))
    .filter((key): key is string => key !== null);
}
