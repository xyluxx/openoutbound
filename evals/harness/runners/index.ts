import { anthropicApiRunner } from "./anthropic-api.js";
import { claudeCliRunner } from "./claude-cli.js";
import { codexCliRunner } from "./codex-cli.js";
import { scriptedRunner } from "./scripted.js";
import type { Runner, RunnerName } from "./types.js";

const RUNNERS: Record<RunnerName, Runner> = {
  scripted: scriptedRunner,
  "claude-cli": claudeCliRunner,
  "codex-cli": codexCliRunner,
  "anthropic-api": anthropicApiRunner,
};

export function createRunner(name: RunnerName): Runner {
  return RUNNERS[name];
}
