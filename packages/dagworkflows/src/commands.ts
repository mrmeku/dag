import {
  notAString,
  type DepRecord,
  type DepRefs,
  type FileHandle,
  type Graph,
  type InputRecord,
  type NodeRef,
  type NotAString,
  type OutputRef,
  type SettledOutputRef,
} from "@mrmeku/dagraph";
import type { Ports } from "./ports.ts";
import { recordPost } from "./steps.ts";
import {
  addTask,
  byRole,
  outputPath,
  type OutputsField,
  type TaskContext,
  type TaskFields,
} from "./task.ts";

const COMMAND_INPUT = "command";
const OWN_REF = Symbol("own ref");

/** How a command keys its own out.<role>, by the file's name, and its outputDir. */
type OwnKey = { out: string } | { outputDir: true };

/**
 * A command's own `out.<role>` or `outputDir`, a path only once the command runs. `S` scopes it to
 * the call that received it, so another command's does not compile.
 */
type OwnRef<S> = { readonly [OWN_REF]: OwnKey; readonly _scope?: S } & NotAString;

/** What a command's functions receive: each dep's outputs by role, `out` and `outputDir`. */
type CommandRefs<D, O extends string, S> = DepRefs<D, S> & {
  readonly out: { readonly [K in O]: OwnRef<S> };
  readonly outputDir: OwnRef<S>;
};

type OwnRoles = { out?: never; outputDir?: never };

/** A ref to a dep's output, which a command reads as its path or paths. */
type Ref<S> = OutputRef<string | string[], S>;
type MaybeRef<S> = SettledOutputRef<string | string[], S>;

/**
 * What `workflow.run` and `workflow.runShell` take beside `cmd`.
 *
 * - Read a dep's output from the function's argument: `deps: { pack }, env: ({ pack }) => ({
 *   TARBALL: pack.tarball })`. A ref goes only in what that call returns.
 * - Write each output at `out.<role>`, in `outputDir`: `env: ({ out }) => ({ OUT: out.tarball })`.
 * - Pass a `settled` dep's output in `env`, where it is unset when the dep did not succeed:
 *   `env: ({ tests }) => ({ REPORT: tests.report })`, then `[ -n "$REPORT" ]`.
 * - A failed node's outputs reach no one, so write a report wanted after a failure to the
 *   working tree and upload it by glob: `path: ["reports/**"]`.
 * - A command that writes the working tree for another node, as `bun install` does, must run
 *   each time: it declares no inputs, or sets `cacheable: false` beside them.
 */
interface CommandSpec<G extends string, D extends DepRecord, O extends string> extends Omit<
  TaskFields<G, D, O>,
  "deps" | "action" | "inputs"
> {
  deps?: D & OwnRoles;
  /** As a task's, and `command` is the command's own: it keys `cmd`, `cwd` and `env`. */
  inputs?: InputRecord & { declaredOutputs?: never; [COMMAND_INPUT]?: never };
  /** Where it runs, relative to the repository root. */
  cwd?: string;
  /** Set over the environment it inherits. */
  env?:
    | Record<string, string>
    | (<S>(
        refs: CommandRefs<D, O, S>,
      ) => Record<string, string | Ref<S> | MaybeRef<S> | OwnRef<S>>);
}

/** A program and its arguments, or a function of the command's refs that returns them. */
type Argv<D, O extends string> =
  | readonly string[]
  | (<S>(refs: CommandRefs<D, O, S>) => readonly (string | Ref<S> | OwnRef<S>)[]);

/**
 * What `workflow.run` takes: one program and its arguments, run with no shell.
 *
 * - A ref is its own argument:
 *   `cmd: ({ outputDir }) => ["npm", "pack", "--pack-destination", outputDir]`.
 * - For `--file=` and a path, use `workflow.runShell`:
 *   `env: ({ pack }) => ({ FILE: pack.tarball }), cmd: 'tool --file="$FILE"'`.
 */
export type RunSpec<G extends string, D extends DepRecord, O extends string> = CommandSpec<
  G,
  D,
  O
> &
  OutputsField<O> & { cmd: Argv<D, O> };

/**
 * What `workflow.runShell` takes: one string, run under `bash --noprofile --norc -eo pipefail -c`
 * (GitHub's `shell: bash`), so a failing command or pipe stage fails the node.
 *
 * - Every ref, `outputDir` too, reaches the string only through `env`, read quoted:
 *   `env: ({ assets }) => ({ BUNDLE: assets.bundle }), cmd: 'gzip -c "$BUNDLE" | wc -c'`.
 * - A `settled` dep's output in `env` is unset when the dep did not succeed, so test it:
 *   `env: ({ tests }) => ({ REPORT: tests.report }), cmd: 'if [ -n "$REPORT" ]; then cat "$REPORT"; fi'`.
 */
export type RunShellSpec<G extends string, D extends DepRecord, O extends string> = CommandSpec<
  G,
  D,
  O
> &
  OutputsField<O> & { cmd: string };

/**
 * What `workflow.post` takes: a command that runs after `main` succeeds, even after a cancel, as
 * a GitHub action's `post:` does. It is never cached.
 *
 * - It waits only for the `deps` it names, `{}` for none; to wait for `tests` whatever its
 *   outcome, `deps: { tests: settled(tests) }`.
 * - Its functions get `main`'s outputs as `main`: `cmd: ({ main }) => ["db", "stop", main.pid]`.
 */
export type PostSpec<
  G extends string,
  D extends DepRecord,
  O extends string,
  M extends NodeRef,
> = PostFields<G, D, O, M> & OutputsField<O>;

interface PostFields<
  G extends string,
  D extends DepRecord,
  O extends string,
  M extends NodeRef,
> extends Omit<CommandSpec<G, D & { main: M }, O>, "cacheable" | "deps" | "invalidateOn"> {
  cmd: Argv<D & { main: M }, O>;
  main: M;
  deps: D & OwnRoles & { main?: never };
}

/** An argument as the command's key holds it: a dep's output by its ref, its own by file. */
type Argument<S> = string | OwnKey | { dep: Ref<S> };

type Command<S> = {
  version: string;
  cmd: string | Argument<S>[];
  cwd: string;
  env: Record<string, string | OwnKey | { dep: Ref<S> | MaybeRef<S> }>;
};

type CommandInputs = { [COMMAND_INPUT]: Command<unknown> };
type CommandContext<D extends DepRecord, O extends string> = TaskContext<D, O, CommandInputs>;

/** A command as its action reads it: each dep's output as handles. */
type ResolvedCommand = CommandContext<DepRecord, string>["inputs"][typeof COMMAND_INPUT];
type ResolvedArgument = Exclude<ResolvedCommand["cmd"], string>[number];

/** Where a command's function got its refs: `run`'s `cmd`, its `env`, or `runShell`'s `env`. */
type Place = "cmd" | "env" | "shell env";

/**
 * A command's `out.<role>` or `outputDir`, whose refusal shows the fix for where it was got. The
 * engine names the node in it, since a command's functions run when the node is added.
 */
function ownRef<S>(shown: string, key: OwnKey, place: Place): OwnRef<S> {
  const param = "out" in key ? "out" : "outputDir";
  const env = `env: ({ ${param} }) => ({ OUT: ${shown} })`;
  const fix = {
    cmd: `its own argument: cmd: ({ ${param} }) => [..., ${shown}]`,
    env: `its own env value: ${env}`,
    "shell env": `its own env value, read quoted: ${env}, then "$OUT"`,
  }[place];
  return notAString({ [OWN_REF]: key }, `${shown} can't be part of a string. Make it ${fix}.`);
}

/** An argument or env value as its command keys it, naming each dep it reads in `named`. */
function keyed<R extends Ref<unknown> | MaybeRef<unknown>, S>(
  value: string | OwnRef<S> | R,
  named: Set<string>,
): string | OwnKey | { dep: R } {
  if (typeof value === "string") return value;
  if (OWN_REF in value) return value[OWN_REF];
  named.add(value.node);
  return { dep: value };
}

const joined = (files: FileHandle | FileHandle[]) =>
  [files]
    .flat()
    .map((file) => file.path)
    .join(":");

function filled(argument: ResolvedArgument, outputDir: string) {
  if (typeof argument === "string") return argument;
  if ("dep" in argument) return joined(argument.dep);
  return "out" in argument ? outputPath(outputDir, argument.out) : outputDir;
}

function filledEnv(value: ResolvedCommand["env"][string], outputDir: string) {
  if (typeof value !== "object" || !("dep" in value)) return filled(value, outputDir);
  // A settled dep that did not succeed leaves its variable unset.
  return value.dep === undefined ? undefined : joined(value.dep);
}

function options({ cwd, env }: ResolvedCommand, outputDir: string) {
  return {
    ...(cwd && { cwd }),
    env: Object.fromEntries(
      Object.entries(env).map(([name, value]): [string, string | undefined] => [
        name,
        filledEnv(value, outputDir),
      ]),
    ),
  };
}

async function runCommand<D extends DepRecord, O extends string>({
  inputs: { command },
  outputDir,
  run,
  runShell,
}: CommandContext<D, O>) {
  if (typeof command.cmd === "string") await runShell(command.cmd, options(command, outputDir));
  else
    await run(
      command.cmd.map((argument) => filled(argument, outputDir)),
      options(command, outputDir),
    );
}

/**
 * A command's inputs, a function of its deps' refs as the engine gives them: its line, cwd and env
 * as its key holds them, beside the author's. It names each node its refs read in `named`.
 */
function commandInputs<D extends DepRecord, O extends string>(
  spec: CommandSpec<string, D, O> & { cmd: string | Argv<D, O> },
  named: Set<string>,
) {
  return <S>(deps: DepRefs<D, S>): CommandInputs => {
    const refs = (place: Place): CommandRefs<D, O, S> => ({
      ...deps,
      out: byRole(spec.outputs, (file, role) => ownRef<S>(`out.${role}`, { out: file }, place)),
      outputDir: ownRef<S>("outputDir", { outputDir: true }, place),
    });
    const given = typeof spec.cmd === "function" ? spec.cmd(refs("cmd")) : spec.cmd;
    const env =
      typeof spec.env === "function"
        ? spec.env(refs(typeof spec.cmd === "string" ? "shell env" : "env"))
        : (spec.env ?? {});
    return {
      ...spec.inputs,
      [COMMAND_INPUT]: {
        version: typeof given === "string" ? "run-shell:v1" : "run:v7",
        cmd: typeof given === "string" ? given : given.map((item) => keyed(item, named)),
        cwd: spec.cwd ?? "",
        env: Object.fromEntries(
          Object.entries(env).map(([name, value]): [string, Command<S>["env"][string]] => [
            name,
            keyed(value, named),
          ]),
        ),
      },
    };
  };
}

function addCommand<D extends DepRecord, O extends string>(
  graph: Graph<Ports>,
  spec: CommandSpec<string, D, O> & { cmd: string | Argv<D, O> },
  where: string,
): NodeRef<Record<O, string>> {
  const { cmd: _cmd, env: _env, cwd: _cwd, inputs: authored = {}, cacheable, ...rest } = spec;
  return addTask<D, O, CommandInputs>(
    graph,
    {
      ...rest,
      inputs: commandInputs(spec, new Set()),
      // Its own command input is always there, so only the author's make it cacheable.
      cacheable: cacheable ?? Object.values(authored).some((value) => value !== undefined),
      action: runCommand,
    },
    where,
  );
}

export function run<D extends DepRecord, O extends string = never>(
  graph: Graph<Ports>,
  spec: RunSpec<string, D, O>,
): NodeRef<Record<O, string>> {
  return addCommand(graph, spec, `run "${spec.name}"`);
}

export function runShell<D extends DepRecord, O extends string = never>(
  graph: Graph<Ports>,
  spec: RunShellSpec<string, D, O>,
): NodeRef<Record<O, string>> {
  return addCommand(graph, spec, `runShell "${spec.name}"`);
}

export function post<D extends DepRecord, O extends string = never, M extends NodeRef = NodeRef>(
  graph: Graph<Ports>,
  spec: PostSpec<string, D, O, M>,
): NodeRef<Record<O, string>> {
  const where = `post "${spec.name}"`;
  const fields: PostFields<string, D, O, M> = spec;
  const deps = { main: fields.main, ...fields.deps };
  const named = new Set<string>();
  const { main, cmd: _cmd, env: _env, cwd: _cwd, inputs: _inputs, ...rest } = fields;
  const task = {
    ...rest,
    deps,
    inputs: commandInputs({ ...fields, deps }, named),
    cacheable: false,
    action: runCommand,
  };
  const ref = addTask<D & { main: M }, O, CommandInputs>(graph, task, where);
  const addTo = (other: Graph<Ports>, name: string, deps: DepRecord) =>
    void addTask<D & { main: M }, O, CommandInputs>(other, { ...task, name }, where, deps);
  recordPost(graph, spec.name, { main: main.name, refs: [...named], deps, addTo });
  return ref;
}
