import type * as dagraph from "@mrmeku/dagraph";

export interface ExecResult {
  /**
   * How the command ended: it exited with `code`; a signal killed it (`code` is -1); or it never
   * started (`code` is -1), its program not spawned or the signal already fired.
   */
  ended: "exited" | "signalled" | "not-started";
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams as the command wrote them, in arrival order. */
  output: string;
  ok: boolean;
}

/**
 * Runs external commands, named after `@actions/exec`: an argv, with no shell unless the argv
 * starts one (`["sh", "-c", "..."]`). Never throws on a non-zero exit; the caller reads `code`.
 * `env` is merged over the inherited environment, and an `undefined` value removes a variable.
 * When `signal` fires the command is interrupted and resolves with its exit status as usual.
 * `onOutput` receives `output` as it arrives, chunk by chunk. A program that cannot start resolves
 * `not-started`, with `spawn <program> <error code>` as both `stderr` and `output`.
 */
export interface Exec {
  run: (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

/** dagraph's clock, which stamps a run's events and times its actions, and a timer. */
export interface Clock extends dagraph.Clock {
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What a node's error carries as its `cause` when a command it ran failed: the command, where, and how it ended. */
export interface CommandCause extends Pick<ExecResult, "ended" | "code"> {
  argv: string[];
  cwd: string;
}

/** The ports a task needs of its context: what runs its commands, its clock, and the files it checks. */
export interface TaskPorts {
  exec: Exec;
  clock: Clock;
  fs: dagraph.FileSystem;
}
