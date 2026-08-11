/**
 * Typed error hierarchy for `@shadow/cli`, matching the pattern established
 * by `@shadow/core` and `@shadow/indexing` (`instanceof` checks, structured
 * fields, never string-matching `error.message`) — with one addition that
 * is this package's whole point (D12): every error carries `next_steps`.
 * The consuming agent's system prompt is not ours to shape, but our output
 * is, and a wrong turn on a *failure* wastes more of an agent's budget than
 * one on a success, so errors get the same in-band steering successes do.
 */

/** JSON envelope every error renders to on stderr — see `render.ts`. */
export interface CliErrorEnvelope {
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly [field: string]: unknown;
  };
  readonly next_steps: readonly string[];
}

/** Base class for every error `shadow` can exit non-zero with. */
export abstract class ShadowCliError extends Error {
  abstract override readonly name: string;
  /** Process exit code — distinct per error kind so a scripted caller can branch on it without parsing stderr. */
  abstract readonly exitCode: number;
  /** D12's mechanism: what the calling agent should do next, given this specific failure. Always non-empty. */
  abstract readonly nextSteps: readonly string[];

  /** Extra structured fields to merge into the envelope's `error` object, beyond `name`/`message`. Override to add them. */
  protected extraFields(): Record<string, unknown> {
    return {};
  }

  toEnvelope(): CliErrorEnvelope {
    return {
      error: { name: this.name, message: this.message, ...this.extraFields() },
      next_steps: this.nextSteps,
    };
  }
}

/** Bad or missing CLI arguments — a usage mistake, not a data problem. */
export class UsageError extends ShadowCliError {
  override readonly name = "UsageError";
  override readonly exitCode = 2;
  override readonly nextSteps: readonly string[];

  constructor(
    public readonly command: string,
    reason: string,
    usage?: string,
  ) {
    super(command ? `shadow ${command}: ${reason}` : `shadow: ${reason}`);
    this.nextSteps = [
      usage
        ? `Correct usage: ${usage}`
        : command
          ? `Run \`shadow ${command}\` with the required arguments.`
          : "Run `shadow` with a recognized command.",
      "Run `shadow` with no arguments to see the full command surface.",
    ];
  }
}

/** No corpus index has ever been built (or persisted) — every read-side command needs one. */
export class IndexMissingError extends ShadowCliError {
  override readonly name = "IndexMissingError";
  override readonly exitCode = 4;
  override readonly nextSteps: readonly string[] = [
    "Run `shadow index` to build the corpus index before using volumes/chapters/find/read/grep.",
  ];

  constructor() {
    super("No corpus index has been built yet");
  }
}

/** `shadow index --check` found the on-disk index does not match a fresh build. */
export class StaleIndexError extends ShadowCliError {
  override readonly name = "StaleIndexError";
  override readonly exitCode = 5;
  override readonly nextSteps: readonly string[] = [
    "Run `shadow index` (without --check) to rebuild the corpus index.",
  ];

  constructor(
    public readonly storedHash: string | undefined,
    public readonly freshHash: string,
  ) {
    super(
      storedHash
        ? `Index is stale: stored corpus_hash ${storedHash} does not match a fresh build's ${freshHash}`
        : `No corpus index has been persisted yet (a fresh build would produce ${freshHash})`,
    );
  }

  protected override extraFields(): Record<string, unknown> {
    return { stored_hash: this.storedHash, fresh_hash: this.freshHash };
  }
}

/** `shadow chapters <volume>` (or any command resolving a volume_id) targeted a volume the index has no record of. */
export class VolumeLookupError extends ShadowCliError {
  override readonly name = "VolumeLookupError";
  override readonly exitCode = 3;
  override readonly nextSteps: readonly string[] = [
    "Run `shadow volumes` to see the volume_ids that actually exist.",
  ];

  constructor(public override readonly cause: Error) {
    super(cause.message);
  }
}

/** `shadow read <node_id>` (or `--with-parents`) targeted a `node_id` the index has no record of — stale citation, typo, or a node from a different corpus build. */
export class NodeLookupError extends ShadowCliError {
  override readonly name = "NodeLookupError";
  override readonly exitCode = 3;
  override readonly nextSteps: readonly string[] = [
    'Run `shadow find "<task>"` to get a current node_id.',
    "Or `shadow chapters <volume>` to browse a volume's chapters directly.",
  ];

  constructor(public override readonly cause: Error) {
    super(cause.message);
  }
}

/** `shadow install` found an existing skill file at the destination and `--force` was not given. */
export class SkillAlreadyInstalledError extends ShadowCliError {
  override readonly name = "SkillAlreadyInstalledError";
  override readonly exitCode = 6;
  override readonly nextSteps: readonly string[];

  constructor(public readonly path: string) {
    super(`A skill is already installed at ${path}`);
    this.nextSteps = [
      "Run `shadow install --force` to overwrite the existing file.",
      `Or inspect ${path} yourself to see whether it differs from the shipped skill.`,
    ];
  }

  protected override extraFields(): Record<string, unknown> {
    return { path: this.path };
  }
}

/** Anything not already one of the above — still exits non-zero with `next_steps`, never a bare stack trace. */
export class UnexpectedCliError extends ShadowCliError {
  override readonly name = "UnexpectedCliError";
  override readonly exitCode = 1;
  override readonly nextSteps: readonly string[] = [
    "This is an unexpected failure, not a known usage or data problem.",
    "Report the error message below; do not retry the same command in a loop.",
  ];

  constructor(public override readonly cause: Error) {
    super(cause.message);
  }
}
