/**
 * Eval harness entry point: `pnpm tsx evals/run.ts --runner scripted --scenario all`.
 * Flags and how to add a scenario: evals/README.md.
 */
import { main } from "./harness/cli.js";

process.exitCode = await main(process.argv.slice(2));
