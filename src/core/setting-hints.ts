/**
 * Hint wording for workspace settings. Changing a setting (`workspaces.update`) needs the admin
 * scope, which agents lack by default, so a hint never tells its reader to change one: the
 * human changes it (`openoutbound workspaces update`), and an agent may suggest the change with
 * a proposal the owner judges. Budgets are never proposed: an agent does not raise its own.
 */

/** Setting paths below `settings` (for example `company.postal_address`) with a sample value. */
export type SettingChanges = Record<string, unknown>;

const CLI = "openoutbound workspaces update";

/** `company.name` or `settings.company.name` as `settings.company.name`. */
function settingName(path: string): string {
  return path.startsWith("settings.") ? path : `settings.${path}`;
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** `{ "company.name": "x" }` as the `workspaces.update` input `{ settings: { company: { name: "x" } } }`. */
function updateInput(changes: SettingChanges): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(changes)) {
    const keys = settingName(path).split(".").slice(1);
    let node = settings;
    for (const key of keys.slice(0, -1)) {
      const child = node[key];
      node[key] = child && typeof child === "object" ? child : {};
      node = node[key] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    if (last) node[last] = value;
  }
  return { settings };
}

/**
 * "Ask the human to change settings.company.postal_address (openoutbound workspaces update); to
 * suggest it, use manage_strategy action propose (operation workspaces.update, input
 * {"settings":{"company":{"postal_address":"<postal address>"}}})."
 */
export function askToChangeSetting(changes: SettingChanges): string {
  const names = listWords(Object.keys(changes).map(settingName));
  return `Ask the human to change ${names} (${CLI}); to suggest it, use manage_strategy action propose (operation workspaces.update, input ${JSON.stringify(updateInput(changes))}).`;
}

/** The same sentence starting in lower case, to follow other words ("If reps agree: ask ..."). */
export function askToChangeSettingAfter(words: string, changes: SettingChanges): string {
  const hint = askToChangeSetting(changes);
  return `${words}: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`;
}

/**
 * "ask the human to raise settings.ai.monthly_budget_usd (openoutbound workspaces update)": the
 * only way a hint mentions a bigger budget, so an agent never raises (or proposes) its own.
 */
export function askToRaiseBudget(setting: string): string {
  return `ask the human to raise ${settingName(setting)} (${CLI})`;
}
