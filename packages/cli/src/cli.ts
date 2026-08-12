/**
 * Argument parsing + command dispatch — deliberately separate from output
 * rendering (`render.ts`) and from the commands themselves
 * (`commands/*.ts`), so each is independently testable (the task's SOLID
 * requirement). No business logic lives here: every command's actual work
 * happens in `commands/*.ts`, orchestrating `@shadow/indexing` and
 * `@shadow/core`. `parseArgs` from `node:util` is all the argument parsing
 * this needs — no third-party dependency (the task's "no dependencies for
 * arg parsing" constraint).
 */

import { parseArgs } from "node:util";
import type { VolumeStore } from "@shadow/core";
import { runChapters } from "./commands/chapters.ts";
import { runFind } from "./commands/find.ts";
import { runGrep } from "./commands/grep.ts";
import { runInstall } from "./commands/install.ts";
import { runLintCommand } from "./commands/lint.ts";
import { runMisses } from "./commands/misses.ts";
import { runRead } from "./commands/read.ts";
import { runIndexCommand } from "./commands/reindex.ts";
import { runVolumes } from "./commands/volumes.ts";
import { ShadowCliError, UnexpectedCliError, UsageError } from "./errors.ts";
import { renderError, renderSuccess } from "./render.ts";

export interface RunDeps {
  readonly store: VolumeStore;
  readonly root: string;
  readonly write: (chunk: string) => void;
  readonly writeErr: (chunk: string) => void;
}

const USAGE = {
  shadow: "the agent-facing contract over a Shadow corpus",
  commands: {
    volumes: "shadow volumes                              # the volume manifest",
    chapters: 'shadow chapters <volume> [--rank "<task>"]  # a volume\'s chapter rows',
    find: 'shadow find "<task>" [--json] [--volumes ids] [--visited ids] [--round n] [--none]',
    read: "shadow read <node_id> [--with-parents]      # body + heading path + hash",
    grep: 'shadow grep "<terms>"                        # raw BM25 escape hatch',
    index: "shadow index [--check]                       # rebuild; --check fails if stale",
    lint: "shadow lint [--offline]                      # index self-critique (D14); --offline skips model-backed checks",
    misses: "shadow misses                                # the operator's authoring backlog (D14)",
    install:
      "shadow install [--target dir] [--force]     # install the shadow-find skill into a repo",
  },
  next_steps: [
    'Start with `shadow volumes` or `shadow find "<task>"` to discover what exists.',
    "Every result and every error carries its own next_steps — follow those from here.",
  ],
} as const;

function splitList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : undefined;
}

function parseRound(value: string | undefined, command: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const round = Number.parseInt(value, 10);
  if (Number.isNaN(round) || round < 1) {
    throw new UsageError(command, `--round must be a positive integer, got "${value}"`);
  }
  return round;
}

async function dispatch(argv: readonly string[], deps: RunDeps): Promise<unknown> {
  const [command, ...rest] = argv;

  switch (command) {
    case "volumes": {
      parseArgs({ args: [...rest], options: { json: { type: "boolean" } }, strict: true });
      return runVolumes(deps.store);
    }

    case "chapters": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { rank: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      });
      const volume = positionals[0];
      if (!volume) {
        throw new UsageError(
          "chapters",
          "missing <volume> argument",
          'shadow chapters <volume> [--rank "<task>"]',
        );
      }
      return runChapters(deps.store, volume, { rank: values.rank });
    }

    case "find": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: {
          volumes: { type: "string" },
          visited: { type: "string" },
          round: { type: "string" },
          none: { type: "boolean" },
          json: { type: "boolean" },
        },
        allowPositionals: true,
        strict: true,
      });
      const task = positionals[0];
      if (!task) {
        throw new UsageError(
          "find",
          "missing <task> argument",
          'shadow find "<task>" [--json] [--volumes ids] [--visited ids] [--round n] [--none]',
        );
      }
      return runFind(deps.store, deps.root, task, {
        volumes: splitList(values.volumes),
        visited: splitList(values.visited),
        round: parseRound(values.round, "find"),
        none: values.none,
      });
    }

    case "read": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { "with-parents": { type: "boolean" }, json: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      });
      const nodeId = positionals[0];
      if (!nodeId) {
        throw new UsageError(
          "read",
          "missing <node_id> argument",
          "shadow read <node_id> [--with-parents]",
        );
      }
      return runRead(deps.store, nodeId, { withParents: values["with-parents"] ?? false });
    }

    case "grep": {
      const { positionals } = parseArgs({
        args: [...rest],
        options: { json: { type: "boolean" } },
        allowPositionals: true,
        strict: true,
      });
      const terms = positionals[0];
      if (!terms) {
        throw new UsageError("grep", "missing <terms> argument", 'shadow grep "<terms>"');
      }
      return runGrep(deps.store, terms);
    }

    case "index": {
      const { values } = parseArgs({
        args: [...rest],
        options: { check: { type: "boolean" }, json: { type: "boolean" } },
        strict: true,
      });
      return runIndexCommand(deps.store, { check: values.check ?? false });
    }

    case "lint": {
      const { values } = parseArgs({
        args: [...rest],
        options: { offline: { type: "boolean" }, json: { type: "boolean" } },
        strict: true,
      });
      return runLintCommand(deps.store, deps.root, { offline: values.offline ?? false });
    }

    case "misses": {
      parseArgs({ args: [...rest], options: { json: { type: "boolean" } }, strict: true });
      return runMisses(deps.root);
    }

    case "install": {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          target: { type: "string" },
          force: { type: "boolean" },
          json: { type: "boolean" },
        },
        strict: true,
      });
      return runInstall({ target: values.target, force: values.force ?? false });
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      return USAGE;

    default:
      throw new UsageError(
        "",
        `unknown command "${command}"`,
        "shadow <volumes|chapters|find|read|grep|index|lint|misses|install>",
      );
  }
}

function wantsPretty(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

/** Parse, dispatch, render, and return the process exit code. Never throws — every failure is caught and rendered as a `ShadowCliError` envelope. */
export async function run(argv: readonly string[], deps: RunDeps): Promise<number> {
  const pretty = wantsPretty(argv);
  try {
    const result = await dispatch(argv, deps);
    deps.write(renderSuccess(result, { pretty }));
    return 0;
  } catch (error) {
    const cliError =
      error instanceof ShadowCliError ? error : new UnexpectedCliError(toError(error));
    deps.writeErr(renderError(cliError, { pretty }));
    return cliError.exitCode;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
