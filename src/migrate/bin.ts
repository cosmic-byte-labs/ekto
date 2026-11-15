#!/usr/bin/env node
/** The `ekto` executable; see `cli.ts`. */

import { main } from "./cli.ts";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
