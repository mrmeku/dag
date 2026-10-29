import {
  nodeInputs,
  type ActionContext,
  type ActionSpec,
  type AnyNodeRef,
  type DepRecord,
  type DepRefs,
  type DepSpecsOf,
  type Graph,
  type InputRecord,
  type NodeParams,
  type NodeRef,
} from "@mrmeku/dagraph";
import { isAbsolute } from "node:path";
import { defineStep } from "./define-step.ts";
import { errorMessage } from "./kernel/format.ts";
import type { ExecOptions, ExecResult, Ports, WorkflowPorts } from "./ports.ts";
import { warningLine, writeLog, type CommandCause } from "./step-records.ts";

/** Each role of `deps` with its dep, leaving out a role whose dep is `undefined`. */
export const depRoles = (deps: DepRecord | undefined) =>
  Object.entries(deps ?? {}).flatMap(([role, dep]): [string, AnyNodeRef][] =>
    dep === undefined ? [] : [[role, dep]],
  );

const BASH = ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c"];

const DECLARED_OUTPUTS = "declaredOutputs";

/** The input that keys a task's declared outputs; the author's `inputs` leave it out. */
type DeclaredOutputs = { [DECLARED_OUTPUTS]: Record<string, string> };

type EngineContext<D extends DepRecord, I extends InputRecord<unknown>> = ActionContext<
  Ports,
  DepSpecsOf<D>,
  DeclaredOutputs & I
>;

type CommandOptions = Pick<ExecOptions, "cwd" | "env">;

export type TaskContext<
  D extends DepRecord,
  O extends string,
  I extends InputRecord<unknown>,
> = Omit<EngineContext<D, I>, "inputs" | "output" | "ports"> & {
  /** The run's ports, as `workflow.ports`: a command runs through `run` and `runShell`. */
  ports: WorkflowPorts;
  /** Its `inputs`: a file as a handle, a value as written. */
  inputs: Omit<EngineContext<D, I>["inputs"], typeof DECLARED_OUTPUTS>;
  /** Its declared outputs by role, as absolute paths in `outputDir`: write each before returning. */
  out: Record<O, string>;
  /** Runs a program with no shell, logged. Resolves with its stdout; throws on a nonzero exit. */
  run: (argv: readonly string[], options?: CommandOptions) => Promise<string>;
  /**
   * Runs a string under `bash --noprofile --norc -eo pipefail -c`, as `run` runs a program. Pass a
   * path in `env`, quoted: `runShell('tar -tzf "$TARBALL"', { env: { TARBALL } })`.
   */
  runShell: (command: string, options?: CommandOptions) => Promise<string>;
  log: (line: string) => void;
  /** Writes a GitHub warning to the node's log, titled with the node's name. */
  warn: (message: string) => void;
};

/** A task's fields; `ActionTaskSpec` adds that `outputs` is required once `O` names an output. */
export interface TaskFields<
  G extends string,
  D extends DepRecord,
  O extends string,
  I extends InputRecord<unknown> = Record<never, never>,
> extends Pick<
  ActionSpec<Ports, Record<O, string>, DepSpecsOf<D>, I, DeclaredOutputs>,
  "cacheable" | "timeoutMs"
> {
  /** Its address in logs, check runs and `--only`, unique in the graph. */
  name: string;
  /** The nodes it depends on, by role: `deps: { pack }`, or `settled(test)` to run after a failure. */
  deps?: D;
  /**
   * What else decides its output, by name: each `file(path)` or a JSON value. A variable is a value
   * read while the graph is built: `inputs: { mixEnv: workflow.ports.env.MIX_ENV ?? null }`.
   * `declaredOutputs` is the task's own: it keys `outputs`. A command gives a function of its
   * deps' refs instead, as the engine takes it.
   */
  inputs?: (I & { [DECLARED_OUTPUTS]?: never }) | (<S>(deps: DepRefs<D, S>) => I);
  /** The files its action writes, by role, as names in its output directory: `{ notes: "notes.md" }`. */
  outputs?: Record<O, string>;
  action: (context: TaskContext<D, O, I>) => Promise<void> | void;
  concurrencyGroup?: G;
}

/** A spec's `outputs`, required once `O` names an output, so `out.<role>` is always a declared file. */
export type OutputsField<O extends string> = [O] extends [never]
  ? unknown
  : { outputs: Record<O, string> };

/**
 * What `workflow.task` takes for a node whose work is `action`, a TypeScript function, and
 * neither `cmd` nor `shell`.
 * - Its key is its name, its `inputs`, its deps by role and its `outputs`, never its `action`, so
 *   a renamed task runs again. A value the action reads goes in `inputs`:
 *   `inputs: { version: "manifest-v1", os }`, then `inputs.os`. Bump the version when the action
 *   changes.
 * - It is cached only when it declares inputs, unless it sets `cacheable`.
 */
export type ActionTaskSpec<
  G extends string,
  D extends DepRecord,
  O extends string,
  I extends InputRecord = Record<never, never>,
> = Omit<TaskFields<G, D, O, I>, "inputs"> & {
  inputs?: I & { [DECLARED_OUTPUTS]?: never };
  cmd?: never;
  shell?: never;
} & OutputsField<O>;

export const outputPath = (outputDir: string, file: string): string => `${outputDir}/${file}`;

/** `outputs` by role, each made by `f` from its file's name. */
export function byRole<O extends string, V>(
  outputs: Record<O, string> | undefined,
  f: (file: string, role: string) => V,
): Record<O, V> {
  const mapped = Object.fromEntries(
    Object.entries<string>(outputs ?? {}).map(([role, file]) => [role, f(file, role)]),
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a record over the roles of O, which exist only in the types; a spec without outputs has O never, and its {} is right
  return mapped as Record<O, V>;
}

/** What a task's facade gives `addTask` beside its fields: a post's delays between its tries. */
export interface Tries {
  retryDelaysMs?: readonly number[];
}

/**
 * Runs `spec.action` with what a task gets, logging beside `outputDir`, then checks its outputs.
 * A failed try runs again after each of `retryDelaysMs` in turn, until one succeeds or a cancel.
 */
async function runTask<D extends DepRecord, O extends string, I extends InputRecord<unknown>>(
  spec: TaskFields<string, D, O, I> & Tries,
  {
    inputs: { declaredOutputs: _declaredOutputs, ...inputs },
    output,
    ...context
  }: EngineContext<D, I>,
): Promise<Record<O, string>> {
  const { ports, outputDir, signal } = context;
  let log = "";
  const logLine = (line: string) => {
    log += `${line}\n`;
    output(`${line}\n`);
  };
  let lastCommand: CommandCause | undefined;
  const failure = (message: string) => new Error(message, { cause: lastCommand });
  const exec = async (argv: string[], options: CommandOptions = {}) => {
    const result = await ports.exec.run(argv, { ...options, signal, onOutput: output });
    log += result.output;
    lastCommand = { argv, cwd: options.cwd || ".", ended: result.ended, code: result.code };
    return result;
  };
  const stdoutOf = (shown: string, program: string, result: ExecResult) => {
    switch (result.ended) {
      case "not-started":
        throw failure(
          signal.aborted
            ? `${shown} was stopped before it started`
            : `could not start ${program}. Check that it is on the command's PATH and that its cwd exists.`,
        );
      case "signalled":
        throw failure(signal.aborted ? `${shown} was stopped` : `${shown} was killed by a signal`);
      case "exited":
        if (!result.ok) throw failure(`${shown} exited ${result.code}`);
        // A command that traps the stop signal and exits 0 was still stopped.
        if (signal.aborted) throw failure(`${shown} was stopped`);
        return result.stdout;
    }
  };
  const out = byRole(spec.outputs, (file) => outputPath(outputDir, file));
  const delays = spec.retryDelaysMs ?? [];
  // A cancel or the timeout ends the tries, also during the wait between two.
  const stopped = () => signal.aborted;
  const tryAction = () =>
    spec.action({
      ...context,
      inputs,
      out,
      run: async (argv, options) => {
        const [program = ""] = argv;
        return stdoutOf(argv.join(" "), program, await exec([...argv], options));
      },
      runShell: async (command, options) =>
        stdoutOf("its shell command", "bash", await exec([...BASH, command], options)),
      log: logLine,
      warn: (message) => logLine(warningLine(spec.name, message)),
    });
  try {
    for (let tried = 0; ; tried++)
      try {
        await tryAction();
        break;
      } catch (e) {
        const delay = delays[tried];
        if (delay === undefined || stopped()) throw e;
        logLine(
          `Try ${tried + 1} of ${delays.length + 1} failed: ${errorMessage(e)}. ` +
            `Trying again in ${delay} ms.`,
        );
        await ports.clock.sleep(delay, signal);
        if (stopped()) throw e;
      }
    for (const role in out)
      if (!(await ports.fs.exists(out[role])))
        throw failure(
          `output "${role}" (${spec.outputs?.[role]}) was not written. Write it at ` +
            `out.${role} before the action returns.`,
        );
    return out;
  } finally {
    await writeLog(ports.fs, outputDir, log);
  }
}

/**
 * Adds `spec` to `graph` as a node of an action defined for it alone. `where` names it in errors
 * as the call that added it: `task "lint"`. `deps`, when given, replaces the spec's: a post gives
 * its main beside its own, and a run adds it again with its waits. `kind` names the logic the
 * engine keys: the task's name for its own `action`, which nothing else identifies.
 */
export function addTask<
  D extends DepRecord,
  O extends string = never,
  I extends InputRecord<unknown> = Record<never, never>,
>(
  graph: Graph<Ports>,
  spec: TaskFields<string, D, O, I> & Tries,
  where = `task "${spec.name}"`,
  deps: DepRecord | undefined = spec.deps,
  kind = spec.name,
): NodeRef<Record<O, string>> {
  const declaredOutputs: Record<string, string> = spec.outputs ?? {};
  for (const [role, file] of Object.entries(declaredOutputs)) {
    const parts = file.split(/[\\/]/);
    const name = parts.at(-1) ?? "";
    const named = name !== "" && name !== "." && name !== "..";
    if (isAbsolute(file) || parts.includes("..") || !named)
      throw new Error(
        `${where}: outputs.${role} is "${file}", not a file in its output directory. Name a ` +
          `file in it${named ? `, as "${name}"` : ""}.`,
      );
  }
  const record = typeof spec.inputs === "function" ? undefined : spec.inputs;
  const cacheable =
    spec.cacheable ?? Object.values(record ?? {}).some((value) => value !== undefined);
  const action = defineStep<Record<O, string>, DepSpecsOf<D>, I, DeclaredOutputs>({
    kind,
    nodeInputs: nodeInputs<I>,
    inputs: { declaredOutputs },
    cacheable,
    ...(spec.timeoutMs !== undefined && { timeoutMs: spec.timeoutMs }),
    ...(spec.concurrencyGroup !== undefined && { concurrencyGroup: spec.concurrencyGroup }),
    action: (context) => runTask(spec, context),
  });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the action is this node's alone, so it declares the deps and inputs the node gives: NodeDeps<DepSpecsOf<D>> is D, and the inputs are I, whose refs a command scopes by its own S; TypeScript sees neither for a generic D and I. A post a run adds again keeps its roles and adds settled waits, which its action never reads.
  const params = {
    name: spec.name,
    ...(deps && { deps }),
    ...(spec.inputs && { inputs: spec.inputs }),
  } as unknown as NodeParams<DepSpecsOf<D>, I, DeclaredOutputs, undefined>;
  return action.addNode(graph, params);
}
