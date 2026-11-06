#!/usr/bin/env node
import { OUTPUT_STYLE_ENV, program } from "./program.ts";

// Node 24.0 and 24.1 have no import.meta.main and would exit 0 here having run nothing.
if (!("main" in import.meta) || Number(process.versions.node.split(".")[0]) < 24) {
  console.error("dag needs Node 24.2 or later");
  process.exit(1);
}
// The shell's way to clear a variable, which commander would refuse as an unknown style.
if (process.env[OUTPUT_STYLE_ENV] === "") delete process.env[OUTPUT_STYLE_ENV];
if (import.meta.main) await program.parseAsync();
