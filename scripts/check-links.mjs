#!/usr/bin/env node
// Checks relative links in Markdown files: every linked file must exist and every #anchor must
// match a heading in the target file (GitHub slug rules). External links are not fetched.
//
//   node scripts/check-links.mjs            # every tracked or new Markdown file
//   node scripts/check-links.mjs docs       # only files under these paths
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, normalize, relative, resolve } from "node:path";

const root = process.cwd();
const filters = process.argv.slice(2).map((path) => normalize(path).replaceAll("\\", "/"));

function listMarkdown() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\0")
    .filter((file) => file.endsWith(".md"))
    .filter((file) => existsSync(file))
    .filter((file) => filters.length === 0 || filters.some((filter) => file.startsWith(filter)));
}

/** GitHub-style heading slug: lowercase, punctuation removed, spaces become hyphens. */
function slugify(heading) {
  return heading
    .replace(/<[^>]+>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Tracks fenced code blocks line by line; returns true while inside one. */
function fenceTracker() {
  let fence = null;
  return (line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      const char = match[1][0];
      if (!fence) fence = char;
      else if (char === fence) fence = null;
      return true;
    }
    return fence !== null;
  };
}

const anchorCache = new Map();

/** Anchors a Markdown file offers: heading slugs (-1, -2 for repeats) and explicit ids. */
function anchorsOf(file) {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const anchors = new Set();
  const counts = new Map();
  const inFence = fenceTracker();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (inFence(line)) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = slugify(heading[1]);
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      anchors.add(seen === 0 ? base : `${base}-${seen}`);
    }
    for (const match of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(match[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

/** Link targets on one line, ignoring inline code spans. */
function targetsIn(line) {
  const text = line.replace(/`[^`]*`/g, (span) => " ".repeat(span.length));
  const targets = [];
  for (const match of text.matchAll(
    /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
  )) {
    targets.push(match[1]);
  }
  const definition = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/.exec(text);
  if (definition) targets.push(definition[1]);
  for (const match of text.matchAll(/\b(?:href|src)="([^"]+)"/g)) targets.push(match[1]);
  for (const match of text.matchAll(/\bsrcset="([^"]+)"/g)) {
    for (const candidate of match[1].split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url) targets.push(url);
    }
  }
  return targets;
}

const problems = [];
let checked = 0;
for (const file of listMarkdown()) {
  const inFence = fenceTracker();
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (inFence(line)) return;
    for (const target of targetsIn(line)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      checked++;
      const hash = target.indexOf("#");
      const path = decodeURIComponent(hash === -1 ? target : target.slice(0, hash));
      const anchor = hash === -1 ? "" : target.slice(hash + 1);
      const where = `${file}:${index + 1}`;
      const resolved = path === "" ? resolve(file) : resolve(dirname(file), path);
      if (relative(root, resolved).startsWith("..")) {
        problems.push(`${where}: ${target} points outside the repository`);
        continue;
      }
      if (!existsSync(resolved)) {
        problems.push(`${where}: ${target} does not exist`);
        continue;
      }
      if (anchor && statSync(resolved).isFile() && resolved.endsWith(".md")) {
        if (!anchorsOf(resolved).has(decodeURIComponent(anchor).toLowerCase())) {
          problems.push(`${where}: ${target} has no heading for #${anchor}`);
        }
      }
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\ncheck-links: ${problems.length} broken link(s) out of ${checked} checked.`);
  process.exit(1);
}
console.log(`check-links: ok (${checked} relative links)`);
