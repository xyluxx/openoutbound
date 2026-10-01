#!/usr/bin/env node
// Fails when a tracked (or new, not ignored) text file contains the em dash character
// or something that looks like a real secret, and checks Agent Skill (SKILL.md) frontmatter.
// Prints file:line for every hit.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Built from its code point so no formatter can turn it into the literal character.
const EM_DASH = String.fromCharCode(0x2014);

/** [label, pattern] pairs. Patterns are written so this file never matches itself. */
const SECRET_PATTERNS = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{16,}/],
  ["OpenAI project key", /sk-proj-[A-Za-z0-9_-]{16,}/],
  ["GitHub token", /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}/],
  ["GitHub fine-grained token", /github_pat_[A-Za-z0-9_]{40,}/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  [
    "Private key",
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/,
  ],
];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".wasm",
  ".xlsx",
]);

function listFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

function isBinary(file, buffer) {
  const dot = file.lastIndexOf(".");
  if (dot !== -1 && BINARY_EXTENSIONS.has(file.slice(dot).toLowerCase())) return true;
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Agent Skill frontmatter must be valid YAML or the skill loads with no name or description.
 * The classic break is an unquoted value containing ": " (a plain scalar cannot hold one).
 */
function checkSkillFrontmatter(file, lines, problems) {
  if (lines[0] !== "---") {
    problems.push(`${file}:1: SKILL.md must start with YAML frontmatter (---)`);
    return;
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    problems.push(`${file}:1: SKILL.md frontmatter is not closed with ---`);
    return;
  }
  const fields = new Map();
  for (let index = 1; index < end; index++) {
    const match = /^(\s*)([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(lines[index]);
    if (!match) continue;
    const value = (match[3] ?? "").trim();
    if (match[1] === "") fields.set(match[2], value);
    if (value === "" || /^["'|>]/.test(value)) continue;
    if (value.includes(": ") || value.includes(" #") || /^[[\]{}&*!%@`,?-]/.test(value)) {
      problems.push(
        `${file}:${index + 1}: "${match[2]}" needs quotes: unquoted YAML values cannot contain ": " or " #" or start with a YAML indicator`,
      );
    }
  }
  const unquote = (value) => value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  const name = unquote(fields.get("name") ?? "");
  const description = unquote(fields.get("description") ?? "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    problems.push(`${file}: frontmatter name must be 1-64 lowercase letters, digits and hyphens`);
  }
  if (description.length === 0 || description.length > 1024) {
    problems.push(`${file}: frontmatter description must be 1-1024 characters`);
  }
}

const problems = [];
for (const file of listFiles()) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue; // deleted in the working tree
  }
  if (isBinary(file, buffer)) continue;
  const lines = buffer.toString("utf8").split(/\r?\n/);
  if (file === "SKILL.md" || file.endsWith("/SKILL.md"))
    checkSkillFrontmatter(file, lines, problems);
  lines.forEach((line, index) => {
    if (line.includes(EM_DASH)) {
      problems.push(`${file}:${index + 1}: em dash (U+2014); use a hyphen, colon or comma`);
    }
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(line)) problems.push(`${file}:${index + 1}: looks like a secret (${label})`);
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\ncheck-text: ${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("check-text: ok");
