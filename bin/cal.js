#!/usr/bin/env node
import { main } from "../src/cli.ts";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err?.stack || String(err));
    process.exitCode = 1;
  },
);
