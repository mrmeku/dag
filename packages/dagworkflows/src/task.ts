import {
  checkInputs,
  nodeInputs,
  type ActionContext,
  type ActionSpec,
  type DepRecord,
  type DepRefs,
  type DepSpecsOf,
  type Graph,
  type InputRecord,
  type NodeParams,
  type NodeRef,
  type SettledRef,
} from "@mrmeku/dagraph";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defineStep } from "./define-step.ts";
import type { Exec, ExecResult, Ports } from "./ports.ts";
import { warningLine, writeLog, type CommandCause } from "./step-records.ts";

/** Each role of `deps` with its dep, leaving out a role whose dep is `undefined`. */
export const depRoles = (deps: DepRecord | undefined) =>
  Object.entries(deps ?? {}).flatMap(([role, dep]): [string, NodeRef | SettledRef][] =>
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

type CommandOptions = Pick<NonNullable<Parameters<Exec["run"]>[1]>, "cwd" | "env">;

export type TaskContext<
  D extends DepRecord,
  O extends string,
  I extends InputRecord<unknown>,
> = Omit<EngineContext<D, I>, "inputs" | "output"> & {
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

/** A task's fields; `TaskSpec` adds that `outputs` is required once `O` names an output. */
export interface TaskFields<
  G extends string,
  D extends DepRecord,
  O extends string,
  I extends InputRecord<unknown> = Record<never, never>,
> extends Pick<
  ActionSpec<Ports, Record<O, string>, DepSpecsOf<D>, I, DeclaredOutputs>,
  "invalidateOn" | "cacheable" | "timeoutMs"
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
 * What `workflow.task` takes: a node whose work is a TypeScript function.
 * - Its key is its `inputs`, its deps by role and its `outputs`, never its `action`. A value the
 *   action reads goes in `inputs`: `inputs: { version: "manifest-v1", os }`, then `inputs.os`.
 *   Bump the version when the action changes.
 * - Two cached tasks with the same inputs, deps, outputs and `invalidateOn` roles must share one
 *   `action` function, or they are refused: give a loop's tasks what differs as an input, as `os`
 *   above.
 * - It is cached only when it declares inputs, unless it sets `cacheable`.
 */
export type TaskSpec<
  G extends string,
  D extends DepRecord,
  O extends string,
  I extends InputRecord = Record<never, never>,
> = Omit<TaskFields<G, D, O, I>, "inputs"> & {
  inputs?: I & { [DECLARED_OUTPUTS]?: never };
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

const cachedTasks = new WeakMap<
  Graph<Ports>,
  { name: string; declared: unknown; action: unknown }[]
>();

/**
 * Refuses a cached task that declares what an earlier one did, as the engine keys it, with
 * another action function: the engine would give it the earlier one's result. A fingerprinted
 * role counts as one whatever its function, which may return what the other's does.
 */
function refuseDuplicate<D extends DepRecord, O extends string, I extends InputRecord<unknown>>(
  graph: Graph<Ports>,
  where: string,
  task: Pick<TaskFields<string, D, O, I>, "name" | "outputs" | "invalidateOn" | "action">,
  deps: DepRecord | undefined,
  inputs: I | undefined,
) {
  const declared = {
    inputs: checkInputs(inputs, where),
    deps: Object.fromEntries(depRoles(deps).map(([role, dep]) => [role, dep.name])),
    outputs: task.outputs ?? {},
    invalidateOn: depRoles(deps)
      .map(([role]) => role)
      .filter((role) => task.invalidateOn?.[role] !== undefined)
      .sort(),
  };
  const earlier = cachedTasks.get(graph) ?? [];
  const same = earlier.find(
    (other) => other.action !== task.action && isDeepStrictEqual(other.declared, declared),
  );
  if (same)
    throw new Error(
      `${where} has the same inputs, deps, outputs and invalidateOn as task "${same.name}", so ` +
        `the two could share a cached result. Put a value its action reads in inputs: ` +
        `inputs: { version: "test-v1", os }, read as inputs.os.`,
    );
  cachedTasks.set(graph, [...earlier, { name: task.name, declared, action: task.action }]);
}

/** Runs `spec.action` with what a task gets, logging beside `outputDir`, then checks its outputs. */
async function runTask<D extends DepRecord, O extends string, I extends InputRecord<unknown>>(
  spec: TaskFields<string, D, O, I>,
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
    lastCommand = { argv, cwd: options.cwd || ".", code: result.code };
    return result;
  };
  const stdoutOf = (shown: string, program: string, result: ExecResult) => {
    if (result.code === -1 && result.stderr === `spawn ${program} ENOENT`)
      throw failure(
        `could not start ${program}. Check that it is on the command's PATH and that its cwd exists.`,
      );
    if (!result.ok) throw failure(`${shown} exited ${result.code}`);
    // A command that traps the stop signal and exits 0 was still stopped.
    if (signal.aborted) throw failure(`${shown} was stopped`);
    return result.stdout;
  };
  const out = byRole(spec.outputs, (file) => outputPath(outputDir, file));
  try {
    await spec.action({
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
 * as the method that added it: `run "lint"`. `deps`, when given, replaces the spec's: a post that
 * `--only` adds again gives the roles it keeps.
 */
export function addTask<
  D extends DepRecord,
  O extends string = never,
  I extends InputRecord<unknown> = Record<never, never>,
>(
  graph: Graph<Ports>,
  spec: TaskFields<string, D, O, I>,
  where = `task "${spec.name}"`,
  deps: DepRecord | undefined = spec.deps,
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
    kind: spec.name,
    nodeInputs: nodeInputs<I>,
    inputs: { declaredOutputs },
    cacheable,
    ...(spec.invalidateOn && { invalidateOn: spec.invalidateOn }),
    ...(spec.timeoutMs !== undefined && { timeoutMs: spec.timeoutMs }),
    ...(spec.concurrencyGroup !== undefined && { concurrencyGroup: spec.concurrencyGroup }),
    action: (context) => runTask(spec, context),
  });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the action is this node's alone, so it declares the deps and inputs the node gives: NodeDeps<DepSpecsOf<D>> is D, and the inputs are I, whose refs a command scopes by its own S; TypeScript sees neither for a generic D and I. A post that --only adds again keeps the roles its command reads and adds settled ones, which its action never reads.
  const params = {
    name: spec.name,
    ...(deps && { deps }),
    ...(spec.inputs && { inputs: spec.inputs }),
  } as unknown as NodeParams<DepSpecsOf<D>, I, DeclaredOutputs, undefined>;
  const ref = action.addNode(graph, params);
  // A command's inputs are a function, and its one action function is shared.
  if (cacheable && typeof spec.inputs !== "function")
    refuseDuplicate(graph, where, spec, deps, record);
  return ref;
}
