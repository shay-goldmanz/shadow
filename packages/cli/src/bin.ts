#!/usr/bin/env bun

/**
 * The `shadow` executable. All behavior lives in `cli.ts`/`commands/*.ts`;
 * this file only wires real `process` state (argv, env, stdout/stderr,
 * exit code) to that pure dispatch function.
 */

import { run } from "./cli.ts";
import { createContext } from "./context.ts";

const { store, root } = createContext(process.env);

const exitCode = await run(process.argv.slice(2), {
  store,
  root,
  write: (chunk) => {
    process.stdout.write(chunk);
  },
  writeErr: (chunk) => {
    process.stderr.write(chunk);
  },
});

process.exit(exitCode);
