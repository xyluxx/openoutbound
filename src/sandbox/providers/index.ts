/**
 * Every sandbox provider (provider id "sandbox"), one per slot the sandbox brief covers. Each is
 * `sandbox: true`: only sandbox workspaces resolve to these, and vice versa (spec section 4).
 * Registered through the sandbox module's `EngineModule.providers` (see modules/sandbox/index.ts).
 */
import { defineProvider, type ProviderDefinition } from "../../providers/types.js";
import { createSandboxCrm } from "./crm.js";
import { createSandboxEmailFinder } from "./email-finder.js";
import { createSandboxEmailVerifier } from "./email-verifier.js";
import { createSandboxLeadSource } from "./lead-source.js";
import { createSandboxLinkedIn } from "./linkedin.js";
import { createSandboxResearch } from "./research.js";
import { createSandboxSignals } from "./signals.js";
import { createSandboxSocial } from "./social.js";

const leadSource = defineProvider({
  slot: "lead_source",
  id: "sandbox",
  name: "Sandbox lead source",
  description:
    "Apollo-like people search and Google-Maps-like company search over the sandbox's invented world of companies and people. Zero credits, zero keys, fully deterministic.",
  secrets: [],
  sandbox: true,
  create: ({ ctx }) => createSandboxLeadSource(ctx),
});

const emailFinder = defineProvider({
  slot: "email_finder",
  id: "sandbox",
  name: "Sandbox email finder",
  description:
    "Deterministic email guesses for sandbox leads: found for about 80% of people, not found for the rest, always the same answer for the same input.",
  secrets: [],
  sandbox: true,
  create: () => createSandboxEmailFinder(),
});

const emailVerifier = defineProvider({
  slot: "email_verifier",
  id: "sandbox",
  name: "Sandbox email verifier",
  description:
    "Deterministic verification for sandbox addresses: a mix of valid, invalid, catch_all and risky, hashed from the address so results never change between calls.",
  secrets: [],
  sandbox: true,
  create: () => createSandboxEmailVerifier(),
});

const research = defineProvider({
  slot: "research",
  id: "sandbox",
  name: "Sandbox research",
  description:
    "Search and fetch over the sandbox world's canned company and news pages, each with a title, dated content and a stable example.com URL.",
  secrets: [],
  sandbox: true,
  create: ({ ctx }) => createSandboxResearch(ctx),
});

const signals = defineProvider({
  slot: "signals",
  id: "sandbox",
  name: "Sandbox signals",
  description:
    "Returns the sandbox world's pre-built buying signals for a company (hiring, funding, new executives, website changes, tech adoption), each with an example.com evidence URL.",
  secrets: [],
  sandbox: true,
  create: () => createSandboxSignals(),
});

const linkedin = defineProvider({
  slot: "linkedin",
  id: "sandbox",
  name: "Sandbox LinkedIn",
  description:
    "Fake LinkedIn accounts acting on the sandbox world's fake profiles: invites are accepted for about 35% of people after a short simulated delay, and about half of people have a recent post.",
  secrets: [],
  sandbox: true,
  create: ({ ctx }) => createSandboxLinkedIn(ctx),
});

const social = defineProvider({
  slot: "social",
  id: "sandbox",
  name: "Sandbox social publisher",
  description:
    "Fake post publishing: every publish call mints a stable example.com URL. Nothing is sent anywhere.",
  secrets: [],
  sandbox: true,
  create: ({ ctx }) => createSandboxSocial(ctx),
});

const crm = defineProvider({
  slot: "crm",
  id: "sandbox",
  name: "Sandbox CRM",
  description:
    "Records contact, deal and note calls in memory for the life of the provider instance. No real CRM involved.",
  secrets: [],
  sandbox: true,
  create: ({ ctx }) => createSandboxCrm(ctx),
});

/** Every sandbox provider, across every slot the sandbox brief owns. */
export const providers: ProviderDefinition[] = [
  leadSource,
  emailFinder,
  emailVerifier,
  research,
  signals,
  linkedin,
  social,
  crm,
];
