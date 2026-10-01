/**
 * Hand-written narrative content per sandbox workspace: knowledge, offers, ICPs, lists, draft
 * campaigns and sender identities. Generated world companies/people (companies.ts, people.ts)
 * supply the leads; this file supplies the business the two fake agencies are running.
 */
import type { CampaignGoal, KnowledgeKind, ListKind, StepType } from "../../core/enums.js";
import type { IcpCriteriaInput, IcpScoringInput } from "../../modules/leads/icp/criteria.js";

export interface BlueprintOffer {
  name: string;
  summary: string;
  details: string;
  value_props: string[];
  cta: string;
  booking_url: string;
  is_default: boolean;
}

export interface BlueprintKnowledgeItem {
  kind: KnowledgeKind;
  title: string;
  body: string;
}

/** An ICP as manage_icp action create takes it (seed.ts stores it through the same schemas). */
export interface BlueprintIcp {
  name: string;
  description: string;
  criteria: IcpCriteriaInput;
  scoring: IcpScoringInput;
  signal_keys: string[];
  is_default: boolean;
}

export interface BlueprintList {
  name: string;
  description: string;
  kind: ListKind;
  filter?: Record<string, unknown>;
  /** For static lists: how many seeded people to add (picked deterministically). */
  static_member_count?: number;
}

export interface BlueprintStep {
  type: StepType;
  delay_days?: number;
  delay_hours?: number;
  /** Step config fields, without `type` (added at insert time). */
  config: Record<string, unknown>;
}

export interface BlueprintCampaign {
  name: string;
  description: string;
  goal: CampaignGoal;
  offer_index: number;
  icp_index: number;
  steps: BlueprintStep[];
}

export interface BlueprintSender {
  first_name: string;
  last_name: string;
  title: string;
}

export interface WorkspaceBlueprint {
  slug: string;
  name: string;
  timezone: string;
  segment: "ecommerce" | "dental";
  company_domain: string;
  company_website: string;
  company_line: string;
  knowledge: BlueprintKnowledgeItem[];
  offers: BlueprintOffer[];
  icps: BlueprintIcp[];
  lists: BlueprintList[];
  campaigns: BlueprintCampaign[];
  senders: BlueprintSender[];
  quick_start_prompts: string[];
}

const northwind: WorkspaceBlueprint = {
  slug: "northwind",
  name: "Northwind Analytics (sandbox)",
  timezone: "America/Chicago",
  segment: "ecommerce",
  company_domain: "northwindanalytics.example.com",
  company_website: "https://northwindanalytics.example.com",
  company_line: "Helix Outbound on behalf of Northwind Analytics",
  knowledge: [
    {
      kind: "about",
      title: "About Northwind Analytics",
      body: "Northwind Analytics builds demand forecasting software for direct-to-consumer e-commerce brands. We predict stockouts and overstock 6-8 weeks out from a brand's own sales history, so operations teams can reorder with confidence instead of guessing.",
    },
    {
      kind: "product",
      title: "The forecasting engine",
      body: "Connects to Shopify, BigCommerce and NetSuite in under two weeks. Produces a weekly reorder recommendation per SKU and location, with a confidence band instead of a single number. No data science team required.",
    },
    {
      kind: "proof",
      title: "Case study: a home goods brand",
      body: "A 120-person home goods brand cut stockouts on its top 200 SKUs by about a third in one quarter and freed up warehouse space by trimming slow-moving overstock. Typical results vary by catalog size and seasonality.",
    },
    {
      kind: "objection",
      title: "We already use spreadsheets",
      body: "Spreadsheets work until a brand carries more than a few hundred SKUs across more than one warehouse; past that, reorder points drift and nobody notices until a stockout happens. Northwind does not replace the spreadsheet habit, it feeds the same reorder decision with a forecast instead of a gut check.",
    },
    {
      kind: "faq",
      title: "Does it integrate with our WMS?",
      body: "Yes, through a daily CSV export or a direct API connection for common warehouse management systems. Setup typically takes one to two weeks including a historical data backfill.",
    },
    {
      kind: "voice_sample",
      title: "Tone sample",
      body: 'Direct and specific. Lead with a number or a named risk, not a compliment. Example: "Your top 20 SKUs are the ones that go out of stock first when a channel spikes. Worth a 15-minute look at where the gaps are?"',
    },
    {
      kind: "rule",
      title: "Never promise a specific percentage without a source",
      body: 'Only state a percentage improvement when citing the specific customer story it came from, and say "typically" rather than guaranteeing a result.',
    },
    {
      kind: "competitor",
      title: "Competitors",
      body: "Some prospects already run a rival demand-planning tool. We win on time-to-value (two weeks, not two quarters) and on direct operator support, not on raw feature count. Never disparage a named competitor by name.",
    },
  ],
  offers: [
    {
      name: "Demand Forecasting Starter",
      summary:
        "Cut stockouts and overstock with a 6-8 week forecast built from your own sales history.",
      details:
        "A guided setup that connects to Shopify or NetSuite, backfills 12 months of history, and produces a weekly reorder recommendation per SKU. Most teams are live inside two weeks.",
      value_props: [
        "Fewer stockouts on top-selling SKUs",
        "Less cash tied up in overstock",
        "Live in under two weeks",
      ],
      cta: "Book a 15-minute forecast walkthrough",
      booking_url: "https://cal.example.com/northwind/intro",
      is_default: true,
    },
    {
      name: "Stockout Risk Audit",
      summary:
        "A free, no-obligation look at where current reorder points are leaving money on the table.",
      details:
        "We run a brand's own historical order data through the forecasting engine and hand back a short list of at-risk SKUs, no login or integration required.",
      value_props: [
        "Free 20-minute audit",
        "Named SKUs at risk",
        "No integration required to see it",
      ],
      cta: "Get the free audit",
      booking_url: "https://cal.example.com/northwind/audit",
      is_default: false,
    },
  ],
  icps: [
    {
      name: "DTC e-commerce, operations buyer",
      description:
        "Direct-to-consumer e-commerce brands, 20-500 employees, where an operations or supply chain lead owns reorder decisions.",
      criteria: {
        industries: [
          "home goods e-commerce",
          "apparel e-commerce",
          "consumer electronics e-commerce",
        ],
        industries_adjacent: [
          "beauty and personal care e-commerce",
          "food and beverage e-commerce",
        ],
        keywords: ["direct to consumer"],
        titles: ["vp operations", "head of supply chain", "director of operations", "coo"],
        seniorities: ["c_suite", "vp", "head", "director"],
        departments: ["operations", "supply chain"],
        employee_range: { min: 50, max: 250 },
        employee_limits: { min: 20, max: 500 },
        countries: ["US", "CA", "GB"],
        countries_secondary: ["DE", "AT", "NL", "AU"],
        technologies: ["shopify", "shopify plus", "netsuite"],
        exclude: { company_statuses: ["customer", "competitor", "do_not_contact"] },
      },
      scoring: { unknown_share: 0.4, ai_refinement: { max_adjust: 10 } },
      signal_keys: ["hiring_relevant_roles", "new_exec_hire", "funding_round", "tech_adopted"],
      is_default: true,
    },
    {
      name: "Enterprise DTC (tier A)",
      description:
        "Larger DTC brands (250-500 employees) with a dedicated operations org; slower cycle but bigger deals.",
      criteria: {
        industries: ["home goods e-commerce", "apparel e-commerce"],
        titles: ["vp operations", "coo", "head of supply chain"],
        seniorities: ["c_suite", "vp", "head"],
        employee_range: { min: 250, max: 500 },
        employee_limits: { min: 200, max: 2000 },
        countries: ["US", "CA", "GB"],
      },
      scoring: {},
      signal_keys: ["funding_round", "new_exec_hire"],
      is_default: false,
    },
  ],
  lists: [
    {
      name: "All active leads",
      description: "Every new or active person in the sandbox.",
      kind: "smart",
      filter: { status: ["new", "active"] },
    },
    {
      name: "High fit, hiring signal",
      description: "Fit score 70+ with a recent relevant hiring signal.",
      kind: "smart",
      filter: { min_fit_score: 70, signal_keys: ["hiring_relevant_roles"] },
    },
    {
      name: "Imported this week",
      description: "A static list, as if imported from a saved search.",
      kind: "static",
      static_member_count: 12,
    },
  ],
  campaigns: [
    {
      name: "Signal-triggered ops outreach",
      description:
        "Draft sequence for operations leaders at companies showing a relevant hiring signal.",
      goal: "meeting",
      offer_index: 0,
      icp_index: 0,
      steps: [
        {
          type: "email",
          config: {
            mode: "new_thread",
            style: "guided",
            subject: "Quick question about {{company}}'s reorder process",
            body:
              "Hi {{first_name|there}},\n\n" +
              "[[ai: Reference {{company}} recently hiring for an operations or supply chain role, and introduce forecast accuracy as the fix for stockouts and overstock. Two short sentences.]]\n\n" +
              "Worth a 15 minute look at where the gaps are?\n\n{{sender_name}}",
            max_words: 90,
          },
        },
        { type: "wait", delay_days: 3, config: {} },
        {
          type: "linkedin_invite",
          config: {
            note: "guided",
            text: "[[ai: Short, friendly connection note referencing their operations role, under 200 characters.]]",
          },
        },
        { type: "wait", delay_days: 2, config: {} },
        {
          type: "email",
          config: {
            mode: "reply",
            style: "free",
            instruction:
              "Short bump on the first email. Ask if forecast accuracy is a priority this quarter.",
            max_words: 60,
          },
        },
      ],
    },
    {
      name: "Re-engage cold list",
      description:
        "Simple two-touch re-engagement for leads that never replied to an earlier sequence.",
      goal: "reply",
      offer_index: 1,
      icp_index: 0,
      steps: [
        {
          type: "email",
          config: {
            mode: "new_thread",
            style: "free",
            instruction:
              "Reference peak season approaching and offer the free stockout risk audit as a low-commitment next step.",
            max_words: 80,
          },
        },
        { type: "wait", delay_days: 5, config: {} },
        {
          type: "email",
          config: {
            mode: "reply",
            style: "free",
            instruction: "One-line bump asking if now is a bad time.",
            max_words: 40,
          },
        },
      ],
    },
  ],
  senders: [
    { first_name: "Dana", last_name: "Voss", title: "SDR" },
    { first_name: "Priya", last_name: "Kade", title: "Account Executive" },
    { first_name: "Marco", last_name: "Feld", title: "Founder" },
  ],
  quick_start_prompts: [
    "Search Northwind Analytics' sandbox for VP Operations leads at 50-250 person DTC brands and show me the top 5 by fit score.",
    "Pull the latest buying signals for Northwind Analytics and tell me which company to reach out to first, and why.",
    'Draft the next email step of the "Signal-triggered ops outreach" campaign for one lead and show me the draft before sending anything.',
  ],
};

const brightsmile: WorkspaceBlueprint = {
  slug: "brightsmile",
  name: "Brightsmile Dental Supply (sandbox)",
  timezone: "America/Chicago",
  segment: "dental",
  company_domain: "brightsmilesupply.example.com",
  company_website: "https://brightsmilesupply.example.com",
  company_line: "Helix Outbound on behalf of Brightsmile Dental Supply",
  knowledge: [
    {
      kind: "about",
      title: "About Brightsmile Dental Supply",
      body: "Brightsmile Dental Supply sells hygiene, sterilization and chairside supplies to independently owned dental practices, with next-day delivery and no minimum order.",
    },
    {
      kind: "product",
      title: "Supply catalog",
      body: "Gloves, masks, sterilization pouches, impression material and chairside consumables. Orders placed by 5pm ship the same day; most practices in the service area receive supplies the next morning.",
    },
    {
      kind: "proof",
      title: "Case study: a family dental practice",
      body: "A four-chair family practice switched from a regional distributor and cut its supply ordering time from an hour a week to about ten minutes, with fewer emergency runs to the pharmacy for missing items.",
    },
    {
      kind: "objection",
      title: "We already have a supplier",
      body: "Most practices do. The usual reason to look at a second option is next-day delivery on the items that run out unexpectedly, or a fixed monthly price instead of a fluctuating invoice. Never disparage the existing supplier by name.",
    },
    {
      kind: "faq",
      title: "Do you offer next-day delivery?",
      body: "Yes, for practices in the service area, on orders placed by 5pm local time. Outside the service area, standard delivery is two to three business days.",
    },
    {
      kind: "voice_sample",
      title: "Tone sample",
      body: 'Warm and practical, one clear ask. Example: "Most practices your size keep running out of the same two or three items. Want us to send a starter box so you can compare?"',
    },
    {
      kind: "rule",
      title: "Never quote or describe a patient review",
      body: 'When referencing reviews, describe the operational pattern only (for example, "a few recent reviews mention trouble getting through by phone"), never quote or describe a specific patient\'s treatment.',
    },
    {
      kind: "competitor",
      title: "Competitors",
      body: "Most prospects already buy from a regional or national distributor. We win on next-day delivery and a fixed monthly price, not on being the cheapest line item.",
    },
  ],
  offers: [
    {
      name: "Practice Starter Bundle",
      summary:
        "Core hygiene and sterilization supplies at a fixed monthly price, delivered on your schedule.",
      details:
        "A starter box sized to the practice's chair count, with a fixed monthly price and no long-term contract.",
      value_props: [
        "Fixed monthly price",
        "Next-day delivery in the service area",
        "No minimum order",
      ],
      cta: "See the starter bundle",
      booking_url: "https://cal.example.com/brightsmile/intro",
      is_default: true,
    },
    {
      name: "Supply Subscription Plan",
      summary: "Never run out: usage-based auto-replenishment before the practice runs low.",
      details:
        "Tracks typical usage per practice size and ships refills automatically, with volume pricing at higher tiers.",
      value_props: ["Auto-replenishment", "Volume pricing", "Cancel anytime"],
      cta: "Start a subscription",
      booking_url: "https://cal.example.com/brightsmile/subscribe",
      is_default: false,
    },
  ],
  icps: [
    {
      name: "Independent dental practice",
      description:
        "Owner-operated general dentistry practices with 2-10 practitioners inside the service area.",
      criteria: {
        industries: ["general dentistry", "dental practice"],
        industries_adjacent: ["orthodontics", "pediatric dentistry"],
        keywords: ["independently owned"],
        titles: ["owner", "practice manager"],
        seniorities: ["owner", "manager"],
        // 2-10 practitioners at about four staff each.
        employee_range: { min: 8, max: 40 },
        // The service area: in-area practices earn full points, the rest none.
        regions: ["TX", "CO", "AZ", "FL", "OH", "OR", "NC", "CA", "MO"],
        exclude: {
          keywords: ["multi-location", "dso"],
          company_statuses: ["customer", "competitor", "do_not_contact"],
        },
      },
      // Nearly every practice in the area fits; what decides is the person: the owner or the
      // practice manager orders supplies, an associate dentist does not. Weights add up to 100.
      scoring: {
        weights: {
          industry: 15,
          employees: 10,
          geography: 5,
          keywords: 5,
          title: 45,
          seniority: 20,
        },
      },
      signal_keys: ["expansion_new_location", "review_activity", "hiring_relevant_roles"],
      is_default: true,
    },
  ],
  lists: [
    {
      name: "All active leads",
      description: "Every new or active clinic in the sandbox.",
      kind: "smart",
      filter: { status: ["new", "active"] },
    },
    {
      name: "Needs email",
      description: "Clinics with no email on file yet.",
      kind: "smart",
      filter: { has_email: false },
    },
    {
      name: "Imported this week",
      description: "A static list, as if imported from a saved search.",
      kind: "static",
      static_member_count: 10,
    },
  ],
  campaigns: [
    {
      name: "Local practice intro",
      description:
        "Draft sequence introducing next-day delivery and a fixed monthly price to owner-operators.",
      goal: "meeting",
      offer_index: 0,
      icp_index: 0,
      steps: [
        {
          type: "email",
          config: {
            mode: "new_thread",
            style: "guided",
            subject: "Next-day delivery for {{company}}",
            body:
              "Hi {{first_name|there}},\n\n" +
              "[[ai: Introduce next-day delivery and a fixed monthly price. Offer a free starter box to compare, no commitment, in two short sentences.]]\n\n" +
              "Want us to send one over?\n\n{{sender_name}}",
            max_words: 80,
          },
        },
        { type: "wait", delay_days: 3, config: {} },
        { type: "linkedin_visit", config: {} },
        { type: "wait", delay_days: 2, config: {} },
        {
          type: "email",
          config: {
            mode: "reply",
            style: "free",
            instruction: "Short bump offering the free starter box again.",
            max_words: 50,
          },
        },
      ],
    },
    {
      name: "Referral follow-up",
      description: "Two-touch sequence for practices referred by an existing customer.",
      goal: "reply",
      offer_index: 1,
      icp_index: 0,
      steps: [
        {
          type: "email",
          config: {
            mode: "new_thread",
            style: "free",
            instruction:
              "Mention the referral by role only (not the referring practice's name) and offer the subscription plan.",
            max_words: 70,
          },
        },
        { type: "wait", delay_days: 4, config: {} },
        {
          type: "email",
          config: { mode: "reply", style: "free", instruction: "One-line bump.", max_words: 30 },
        },
      ],
    },
  ],
  senders: [
    { first_name: "Reese", last_name: "Colton", title: "Account Manager" },
    { first_name: "Nadia", last_name: "Brooks", title: "Sales Lead" },
    { first_name: "Owen", last_name: "Tate", title: "Founder" },
  ],
  quick_start_prompts: [
    "Find dental clinics near Austin, TX with 2-10 practitioners and a rating above 4, and show me the top 5.",
    "Check the attention queue for Brightsmile Dental Supply and summarize what needs a reply.",
    "Draft a follow-up email for a Brightsmile lead who has not replied to the local practice intro campaign yet.",
  ],
};

export const WORKSPACE_BLUEPRINTS: readonly WorkspaceBlueprint[] = [northwind, brightsmile];
