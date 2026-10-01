import { z } from "zod";
import { definePrompt } from "../../../brain/prompt.js";

export interface DraftPostVars {
  company_name: string;
  language: string;
  tone_notes: string;
  /** Pillar to write for, or null to let the model pick from `pillars`. */
  pillar: string | null;
  pillars: string[];
  topic: string | null;
  instructions: string | null;
  /** Rendered grounding pack (our own knowledge base). */
  grounding: string;
  /** `[id] title` lines the model may cite in knowledge_item_ids. */
  fact_index: string[];
  voice_samples: string[];
  /** First lines of recent posts, to avoid repeating topics. */
  recent_posts: string[];
  count: number;
  length: "short" | "medium" | "long";
}

const LENGTH_WORDS: Record<DraftPostVars["length"], string> = {
  short: "60-120 words",
  medium: "120-220 words",
  long: "220-350 words",
};

export const draftPostSchema = z.object({
  posts: z
    .array(
      z.object({
        body: z.string().min(1).max(3000).describe("The post text, ready to publish"),
        pillar: z.string().min(1).max(80).describe("Content pillar this post serves"),
        angle: z.string().max(300).describe("One line: the idea and why it matters to readers"),
        knowledge_item_ids: z
          .array(z.string())
          .describe("Ids from the fact index that the post relies on"),
      }),
    )
    .min(1)
    .max(5),
});

/** Drafts LinkedIn posts from the knowledge base, content pillars and voice samples. */
export const draftPostPrompt = definePrompt({
  id: "content.post.draft",
  version: 1,
  tier: "standard",
  maxTokens: 3000,
  temperature: 0.7,
  schema: draftPostSchema,
  system: (vars: DraftPostVars) =>
    [
      `You write LinkedIn posts for ${vars.company_name || "the company"}, in the voice of the person who publishes them.`,
      "Rules:",
      "- Every claim about the company, its results, clients or numbers must come from the knowledge block. Never invent facts, numbers, names or quotes.",
      "- One idea per post. Open with a concrete first line, no clickbait. Plain words, short paragraphs.",
      "- No links in the body, no tagging people, no engagement bait, at most 3 hashtags at the end (zero is fine).",
      "- Write like a practitioner sharing something useful, not like an ad. No sales pitch, no generic AI phrasing.",
      `- Length: ${LENGTH_WORDS[vars.length]}.`,
      `- Language: ${vars.language}.`,
      vars.tone_notes ? `- Tone notes: ${vars.tone_notes}` : "",
      "- Do not repeat topics of the recent posts.",
      "Return only JSON matching the schema.",
    ]
      .filter(Boolean)
      .join("\n"),
  user: (vars: DraftPostVars) =>
    [
      `Write ${vars.count} distinct post${vars.count === 1 ? "" : "s"}.`,
      vars.pillar
        ? `Content pillar: ${vars.pillar}`
        : vars.pillars.length
          ? `Pick one pillar per post from: ${vars.pillars.join("; ")}`
          : "Pick a fitting content pillar per post (2-4 words) from the knowledge block.",
      vars.topic ? `Topic: ${vars.topic}` : "",
      vars.instructions ? `Instructions: ${vars.instructions}` : "",
      "",
      "<knowledge>",
      vars.grounding ||
        "(empty: write only general, verifiable observations; make no claims about the company)",
      "</knowledge>",
      vars.fact_index.length ? `Fact index:\n${vars.fact_index.join("\n")}` : "",
      vars.voice_samples.length
        ? `Voice samples (match this style, do not copy):\n${vars.voice_samples.map((s) => `---\n${s}`).join("\n")}`
        : "",
      vars.recent_posts.length
        ? `Recent posts (first lines):\n${vars.recent_posts.map((p) => `- ${p}`).join("\n")}`
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
});
