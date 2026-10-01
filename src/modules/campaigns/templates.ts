import type { CampaignGoal } from "../../core/enums.js";
import type { CampaignSettingsInput } from "../../core/settings.js";
import type { StepInput } from "./steps.js";

/** A campaign blueprint: built-in (code) or saved by a user (`templates` table, kind campaign). */
export interface CampaignTemplate {
  key: string;
  name: string;
  description: string;
  goal: CampaignGoal;
  /** Why the sequence looks like this (from the sequences playbook). */
  why: string;
  settings: CampaignSettingsInput;
  steps: StepInput[];
}

const email = (
  delayDays: number,
  mode: "new_thread" | "reply",
  instruction: string,
  maxWords: number,
): StepInput => ({
  type: "email",
  delay_days: delayDays,
  config: { mode, style: "free", instruction, max_words: maxWords },
});

/**
 * The five built-in sequences from the sequences playbook. Delays count from the previous step,
 * so the "day" column of the playbook is the running sum.
 */
export const BUILTIN_TEMPLATES: CampaignTemplate[] = [
  {
    key: "signal_based_email_4",
    name: "Signal-based email (4 touches)",
    description:
      "Email only, 4 touches over about 14 days: signal-led first touch, proof story, useful resource, close the loop. The default for B2B.",
    goal: "meeting",
    why: "Step 1 does most of the work; step 2 lands while the first email is still findable; step 3 gives a reason to reply that is not a meeting; step 4 in a new thread gets a fresh look and ends politely.",
    settings: {},
    steps: [
      email(
        0,
        "new_thread",
        "Signal-led first touch: name the observed signal in plain words, say what it usually means for someone in their role, one proof point from the knowledge base, one low-friction interest question. No links.",
        90,
      ),
      email(
        3,
        "reply",
        "Proof story: how a similar company handled the same problem, with one number from a knowledge-base proof item. Refer back to the first email in five words or fewer.",
        70,
      ),
      email(
        4,
        "reply",
        "Useful resource or insight: offer a checklist, benchmark or teardown relevant to their situation (offer to send it, attach nothing).",
        70,
      ),
      email(
        7,
        "new_thread",
        "Close the loop: a new subject and a polite permission question about timing or the right person. No guilt, no fake deadline.",
        50,
      ),
    ],
  },
  {
    key: "email_linkedin_6",
    name: "Email plus LinkedIn (6 touches + 2 optional)",
    description:
      "Profile visit, first email, invitation without a note, proof email, LinkedIn message if connected, resource email, like a recent post, close-the-loop email. For tier A personas active on LinkedIn.",
    goal: "meeting",
    why: "The visit and invite make the email sender recognizable; the LinkedIn message lands after the proof email with a different angle; soft touches are skipped when there is nothing real to engage with.",
    settings: {},
    steps: [
      { type: "linkedin_visit", delay_days: 0, config: {} },
      email(
        1,
        "new_thread",
        "Signal-led first touch: the observed signal, why it matters in their role, one proof point, one interest question. No links.",
        90,
      ),
      { type: "linkedin_invite", delay_days: 1, config: { note: "none" } },
      email(
        2,
        "reply",
        "Proof story from a similar company with one number from a knowledge-base proof item.",
        70,
      ),
      {
        type: "condition",
        delay_days: 2,
        config: { if: "linkedin_connected", then_step: null, else_step: 6 },
      },
      {
        type: "linkedin_message",
        delay_days: 0,
        config: {
          style: "free",
          instruction:
            "Thank them for connecting, one useful point with a different angle than the emails, one easy question. Under 60 words, no links.",
        },
      },
      email(
        3,
        "reply",
        "Useful resource or insight, offered not attached, tied to their situation.",
        70,
      ),
      { type: "linkedin_like", delay_days: 3, config: {} },
      email(
        4,
        "new_thread",
        "Close the loop with a new subject: a permission question about timing or the right person.",
        50,
      ),
    ],
  },
  {
    key: "local_business_3",
    name: "Local business (3 touches)",
    description:
      "For clinics, trades, restaurants and other owner-run businesses: an observation-led first touch, local proof, close the loop. Swap step 3 for a call task for tier A.",
    goal: "meeting",
    why: "Owners read email between appointments and shared inboxes get triaged by staff, so fewer, more specific touches work better.",
    settings: {},
    steps: [
      email(
        0,
        "new_thread",
        "Observation-led first touch: one specific thing seen on their website, listing or public reviews (with the source), what it usually costs a business like theirs, one interest question. No links.",
        90,
      ),
      email(
        4,
        "reply",
        "Local proof: a similar business nearby and one number from a knowledge-base proof item.",
        70,
      ),
      email(
        6,
        "new_thread",
        "Close the loop with a new subject: is this worth a look now, or is someone else the right person.",
        50,
      ),
    ],
  },
  {
    key: "event_follow_up",
    name: "Event follow-up",
    description:
      "Only for people with evidence of attendance (booth scans, their session, a published attendee or speaker list): an email the next working day, an invitation naming the event, a resource, close the loop.",
    goal: "meeting",
    why: "Memory of the event fades within days and every other exhibitor emails the same list, so the first email must be early and specific.",
    settings: {},
    steps: [
      email(
        0,
        "new_thread",
        "Reference the session, booth or topic from the event (with the event page as evidence). If there is no record of a meeting, never imply one.",
        90,
      ),
      {
        type: "linkedin_invite",
        delay_days: 1,
        config: {
          note: "free",
          instruction: "One short sentence naming the event as the shared context. No pitch.",
        },
      },
      email(4, "reply", "A resource tied to the event topic, offered not attached.", 70),
      email(5, "reply", "Close the loop politely: timing or the right person.", 50),
    ],
  },
  {
    key: "re_engage_lost",
    name: "Re-engage closed-lost",
    description:
      "For deals lost at least 90 days ago with a known reason and a real change to talk about (a new signal or a product change that answers the lost reason).",
    goal: "meeting",
    why: "Familiarity is real here, so use it, but only with an actual change to talk about.",
    settings: { review_level: "every" },
    steps: [
      email(
        0,
        "new_thread",
        "Honest reference to the past conversation (accurate dates only from the records) plus what changed since. No guessing.",
        90,
      ),
      email(
        5,
        "reply",
        "Proof that addresses the reason they did not go ahead, from a knowledge-base proof item.",
        70,
      ),
      email(7, "reply", "Close the loop: is it worth revisiting now, or later.", 50),
    ],
  },
];

export function findBuiltinTemplate(key: string): CampaignTemplate | undefined {
  return BUILTIN_TEMPLATES.find((template) => template.key === key);
}
