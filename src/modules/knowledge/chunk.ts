/**
 * Turns long content into knowledge item drafts of about 1,500 characters, each with a title.
 * Markdown (and HTML, via headings) is split by headings first; long sections are chunked at
 * paragraph, then line, then sentence, then word boundaries.
 */
import { load } from "cheerio";
import { htmlToText } from "../../lib/web/extract.js";
import { cleanTitle, stripMarkdown, titleFromText } from "./text.js";

export interface ItemDraft {
  title: string;
  body: string;
}

export const TARGET_CHUNK_CHARS = 1_500;
export const MAX_CHUNK_CHARS = 2_000;

interface Section {
  title: string | null;
  body: string;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Markdown sections by heading. Content before the first heading has a null title. A heading
 * with no body of its own is folded into the next heading's title ("Product: Pricing").
 */
export function splitMarkdownSections(markdown: string): Section[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const sections: Section[] = [];
  let current: { title: string | null; lines: string[] } = { title: null, lines: [] };
  let carry: string | null = null;
  let inFence = false;

  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (body) {
      sections.push({ title: current.title, body });
      carry = null;
    } else if (current.title) {
      carry = current.title;
    }
  };

  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(line);
    if (match) {
      flush();
      const heading = stripMarkdown(match[2] ?? "");
      current = { title: carry ? `${carry}: ${heading}` : heading, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  return sections;
}

/** Splits text into chunks of about `target` characters, never longer than `max`. */
export function chunkText(
  text: string,
  target = TARGET_CHUNK_CHARS,
  max = MAX_CHUNK_CHARS,
): string[] {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const pieces = splitPieces(clean, max);
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current ? `${current}${piece.separator}${piece.text}` : piece.text;
    if (current && joined.length > target) {
      chunks.push(current.trim());
      current = piece.text;
    } else {
      current = joined;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

interface Piece {
  text: string;
  /** How the piece joins the previous one. */
  separator: string;
}

/** Breaks text into pieces no longer than `max`, keeping the coarsest boundary possible. */
function splitPieces(text: string, max: number): Piece[] {
  const levels: Array<{ split: RegExp; separator: string }> = [
    { split: /\n\n+/, separator: "\n\n" },
    { split: /\n/, separator: "\n" },
    { split: /(?<=[.!?])\s+/, separator: " " },
    { split: /\s+/, separator: " " },
  ];
  const walk = (value: string, level: number, separator: string): Piece[] => {
    if (value.length <= max) return [{ text: value, separator }];
    const rule = levels[level];
    if (!rule) {
      const out: Piece[] = [];
      for (let start = 0; start < value.length; start += max) {
        out.push({
          text: value.slice(start, start + max),
          separator: start === 0 ? separator : "",
        });
      }
      return out;
    }
    const parts = value.split(rule.split).filter((part) => part.trim().length > 0);
    if (parts.length <= 1) return walk(value, level + 1, separator);
    return parts.flatMap((part, index) =>
      walk(part.trim(), level + 1, index === 0 ? separator : rule.separator),
    );
  };
  return walk(text, 0, "\n\n");
}

/** Drafts from sections: one per section, long sections as "(part n)" chunks. */
function draftsFromSections(sections: Section[], fallbackTitle: string): ItemDraft[] {
  const drafts: ItemDraft[] = [];
  for (const section of sections) {
    const title = cleanTitle(section.title ?? fallbackTitle);
    const chunks = chunkText(section.body);
    if (chunks.length === 1) {
      drafts.push({ title, body: chunks[0] ?? "" });
      continue;
    }
    chunks.forEach((body, index) => {
      drafts.push({ title: cleanTitle(`${title} (part ${index + 1})`), body });
    });
  }
  return drafts;
}

/** Markdown -> drafts, one per heading section. `title` names content before the first heading. */
export function markdownToDrafts(markdown: string, options: { title?: string } = {}): ItemDraft[] {
  const fallback = options.title?.trim() || titleFromText(markdown);
  return draftsFromSections(splitMarkdownSections(markdown), fallback);
}

/** Plain text -> drafts of about 1,500 characters titled `title` (or the first line). */
export function textToDrafts(text: string, options: { title?: string } = {}): ItemDraft[] {
  const fallback = options.title?.trim() || titleFromText(text);
  return draftsFromSections([{ title: null, body: text }], fallback);
}

/**
 * HTML -> readable text with headings kept as markdown heading lines and list items as "- "
 * lines. Scripts, styles, nav, header, footer and forms are dropped (see `htmlToText`).
 */
export function htmlToMarkdownText(
  html: string,
  options: { maxChars?: number } = {},
): { title: string | null; text: string } {
  const $ = load(html);
  $("h1, h2, h3, h4, h5, h6").each((_, element) => {
    const level = Number(element.tagName.slice(1)) || 2;
    $(element).prepend(`${"#".repeat(level)} `);
  });
  $("li").each((_, element) => {
    $(element).prepend("- ");
  });
  const { title, text } = htmlToText($.html(), { maxChars: options.maxChars ?? 200_000 });
  return { title: title ? stripMarkdown(title) : null, text };
}

/** HTML -> drafts, split by headings. */
export function htmlToDrafts(html: string, options: { title?: string } = {}): ItemDraft[] {
  const { title, text } = htmlToMarkdownText(html);
  return markdownToDrafts(text, { title: options.title?.trim() || title || undefined });
}
