#!/usr/bin/env node
import { runCli } from "./program.js";

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
// Safety net: never hang after the command finished if a library left a handle open.
setTimeout(() => process.exit(code), 1500).unref();
