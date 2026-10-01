/**
 * Tiny row factories for tests. Every factory inserts a real row with invented, unique
 * defaults (example.com / example.org domains) and returns it. Pass overrides for what matters.
 *
 *   const person = await seedPerson(ctx, { title: "Practice Manager" });
 *   const { campaign, steps } = await seedCampaign(ctx, { steps: [{ type: "email" }, { type: "wait", delay_days: 2 }] });
 */
import type { StepType } from "../core/enums.js";
import type { StepConfigInput } from "../core/settings.js";
import type { Db } from "../db/client.js";
import {
  type ApiKey,
  api_keys,
  type Campaign,
  type CampaignStep,
  type Company,
  campaign_steps,
  campaigns,
  companies,
  type Enrollment,
  enrollments,
  type LinkedInAccount,
  linkedin_accounts,
  type Mailbox,
  type Message,
  mailboxes,
  messages,
  type NewApiKey,
  type NewCampaign,
  type NewCompany,
  type NewEnrollment,
  type NewLinkedInAccount,
  type NewMailbox,
  type NewMessage,
  type NewPerson,
  type NewThread,
  type NewWorkspace,
  type Person,
  people,
  type Thread,
  threads,
  type Workspace,
  workspaces,
} from "../db/schema/index.js";

/** Anything with a db and a workspace: a TestContext works. */
export interface SeedTarget {
  db: Db;
  workspace: { id: string } | null;
}

let counter = 0;
const next = () => ++counter;

const FIRST_NAMES = ["Dana", "Omar", "Priya", "Lukas", "Mei", "Tomas", "Aisha", "Jonas"];
const LAST_NAMES = ["Reyes", "Haddad", "Nair", "Becker", "Chen", "Novak", "Bello", "Larsen"];
const COMPANY_WORDS = [
  "Harbor",
  "Northwind",
  "Bluefield",
  "Summit",
  "Cedar",
  "Brightline",
  "Oakridge",
  "Lumen",
];

function workspaceOf(target: SeedTarget): string {
  if (!target.workspace) throw new Error("seed: the target has no workspace");
  return target.workspace.id;
}

async function insertOne<T>(promise: Promise<T[]>): Promise<T> {
  const [row] = await promise;
  if (!row) throw new Error("seed: insert returned no row");
  return row;
}

/** An API key row; the plain key is not kept (tests that log in create keys with keys.create). */
export async function seedApiKey(db: Db, overrides: Partial<NewApiKey> = {}): Promise<ApiKey> {
  const n = next();
  const hash = `${n.toString(16).padStart(8, "0")}${"0".repeat(56)}`;
  return insertOne(
    db
      .insert(api_keys)
      .values({
        name: `Test key ${n}`,
        kind: "agent",
        prefix: `oo_test${n}`,
        hash,
        scopes: ["read", "write"],
        ...overrides,
      })
      .returning(),
  );
}

export async function seedWorkspace(
  db: Db,
  overrides: Partial<NewWorkspace> = {},
): Promise<Workspace> {
  const n = next();
  return insertOne(
    db
      .insert(workspaces)
      .values({ slug: `test-${n}`, name: `Test Workspace ${n}`, ...overrides })
      .returning(),
  );
}

export async function seedCompany(
  target: SeedTarget,
  overrides: Partial<NewCompany> = {},
): Promise<Company> {
  const n = next();
  const word = COMPANY_WORDS[n % COMPANY_WORDS.length];
  const domain = `${word?.toLowerCase()}-${n}.example.com`;
  return insertOne(
    target.db
      .insert(companies)
      .values({
        workspace_id: workspaceOf(target),
        name: `${word} Dental Group ${n}`,
        domain,
        website: `https://${domain}`,
        industry: "Dental practices",
        employee_count: 25,
        country: "US",
        city: "Austin",
        source: "test",
        ...overrides,
      })
      .returning(),
  );
}

export async function seedPerson(
  target: SeedTarget,
  overrides: Partial<NewPerson> = {},
): Promise<Person> {
  const n = next();
  const first = FIRST_NAMES[n % FIRST_NAMES.length] ?? "Dana";
  const last = LAST_NAMES[(n * 3) % LAST_NAMES.length] ?? "Reyes";
  return insertOne(
    target.db
      .insert(people)
      .values({
        workspace_id: workspaceOf(target),
        first_name: first,
        last_name: last,
        full_name: `${first} ${last}`,
        title: "Practice Manager",
        email: `${first}.${last}.${n}@example.com`.toLowerCase(),
        email_status: "valid",
        country: "US",
        timezone: "America/Chicago",
        language: "en",
        source: "test",
        ...overrides,
      })
      .returning(),
  );
}

export async function seedMailbox(
  target: SeedTarget,
  overrides: Partial<NewMailbox> = {},
): Promise<Mailbox> {
  const n = next();
  return insertOne(
    target.db
      .insert(mailboxes)
      .values({
        workspace_id: workspaceOf(target),
        email: `sender${n}@example.org`,
        from_name: "Sam Sender",
        provider_label: "sandbox",
        auth_type: "sandbox",
        status: "active",
        ...overrides,
      })
      .returning(),
  );
}

export async function seedLinkedInAccount(
  target: SeedTarget,
  overrides: Partial<NewLinkedInAccount> = {},
): Promise<LinkedInAccount> {
  const n = next();
  return insertOne(
    target.db
      .insert(linkedin_accounts)
      .values({
        workspace_id: workspaceOf(target),
        provider: "sandbox",
        external_account_id: `acct_${n}`,
        name: "Sam Sender",
        profile_url: `https://www.linkedin.com/in/sam-sender-${n}`,
        status: "active",
        timezone: "America/Chicago",
        connected_at: new Date(),
        ...overrides,
      })
      .returning(),
  );
}

export interface SeedStep {
  type: StepType;
  delay_days?: number;
  delay_hours?: number;
  /** Step config without `type` (added from `type`). */
  config?: Record<string, unknown>;
}

const DEFAULT_STEP_CONFIG: Partial<Record<StepType, Record<string, unknown>>> = {
  email: { style: "free", instruction: "Introduce the offer in two sentences." },
  task: { title: "Call the lead" },
  condition: { if: "has_email" },
  webhook: { url: "https://hooks.example.com/step" },
};

/** Campaign plus steps (default: one free-style email step). */
export async function seedCampaign(
  target: SeedTarget,
  overrides: Partial<NewCampaign> & { steps?: SeedStep[] } = {},
): Promise<{ campaign: Campaign; steps: CampaignStep[] }> {
  const n = next();
  const { steps: stepSeeds = [{ type: "email" }], ...campaignOverrides } = overrides;
  const workspaceId = workspaceOf(target);
  const campaign = await insertOne(
    target.db
      .insert(campaigns)
      .values({ workspace_id: workspaceId, name: `Test Campaign ${n}`, ...campaignOverrides })
      .returning(),
  );
  const steps: CampaignStep[] = [];
  for (const [position, step] of stepSeeds.entries()) {
    const config = {
      ...DEFAULT_STEP_CONFIG[step.type],
      ...step.config,
      type: step.type,
    } as StepConfigInput;
    steps.push(
      await insertOne(
        target.db
          .insert(campaign_steps)
          .values({
            campaign_id: campaign.id,
            workspace_id: workspaceId,
            position,
            type: step.type,
            delay_days: step.delay_days ?? 0,
            delay_hours: step.delay_hours ?? 0,
            config,
          })
          .returning(),
      ),
    );
  }
  return { campaign, steps };
}

/** Enrollment of a person in a campaign (both ids required). */
export async function seedEnrollment(
  target: SeedTarget,
  values: Pick<NewEnrollment, "campaign_id" | "person_id"> & Partial<NewEnrollment>,
): Promise<Enrollment> {
  return insertOne(
    target.db
      .insert(enrollments)
      .values({ workspace_id: workspaceOf(target), status: "active", ...values })
      .returning(),
  );
}

export async function seedThread(
  target: SeedTarget,
  overrides: Partial<NewThread> = {},
): Promise<Thread> {
  return insertOne(
    target.db
      .insert(threads)
      .values({
        workspace_id: workspaceOf(target),
        channel: "email",
        subject: "Quick question",
        status: "open",
        ...overrides,
      })
      .returning(),
  );
}

/** Message (default: outbound email draft). */
export async function seedMessage(
  target: SeedTarget,
  overrides: Partial<NewMessage> = {},
): Promise<Message> {
  return insertOne(
    target.db
      .insert(messages)
      .values({
        workspace_id: workspaceOf(target),
        channel: "email",
        action: "email",
        direction: "outbound",
        status: "draft",
        subject: "Quick question",
        body_text: "Hi there, short note about scheduling.",
        ...overrides,
      })
      .returning(),
  );
}
