import type { UploadArtifactOptions, UploadArtifactResponse } from "@actions/artifact";
import {
  file,
  settled,
  type BaseParams,
  type FileInput,
  type Graph,
  type NodeRef,
  type Outputs,
  type SettledRef,
} from "@mrmeku/dagraph";
import { basename, dirname } from "node:path";
import { defineStep } from "./define-step.ts";
import type { Ports } from "./ports.ts";
import { logPath, type CommandCause } from "./step-records.ts";

export { logPath, type CommandCause } from "./step-records.ts";

/**
 * `w.glob` and `w.hash`, which load `@actions/glob` on first use: it brings half the toolkit and
 * filters stdout (ports/glob.ts), which importing the package must not.
 */
export const glob = async (patterns: string[]): Promise<string[]> =>
  (await import("./ports/glob.ts")).glob(patterns);
export const hashFiles = async (patterns: string[]): Promise<string> =>
  (await import("./ports/glob.ts")).hashFiles(patterns);

type Deps = Record<string, NodeRef | SettledRef | undefined>;
type DepOutputs = Record<string, Outputs | undefined>;

/** The graph a workflow adds its steps to; its nodes' `meta` is the team's. */
type StepGraph = Graph<Ports>;

/* ------------------------------------------------------------------ posts */

/**
 * A post step as the facade records it beside the graph: its main, the nodes its command names,
 * its deps, and how to add it to another graph under its name with other deps, as `--only` does.
 */
export interface PostRecord {
  main: string;
  refs: string[];
  deps: Deps;
  addTo: (graph: StepGraph, name: string, deps: Deps) => void;
}

/** The post steps of each graph the facade added steps to, by node name. */
const postRecords = new WeakMap<StepGraph, Map<string, PostRecord>>();

/** The posts recorded beside `graph`, by node name. */
export const postsOf = (graph: StepGraph): ReadonlyMap<string, PostRecord> =>
  postRecords.get(graph) ?? new Map();

/** Record `name` as a post step of `graph`. */
export function recordPost(graph: StepGraph, name: string, post: PostRecord): void {
  const posts = postRecords.get(graph) ?? new Map<string, PostRecord>();
  postRecords.set(graph, posts.set(name, post));
}

/** Each post step of the graph, by name, with its main's: `dagactions post` runs the ones a cancelled run did not. */
export function postNodes(graph: StepGraph): Map<string, string> {
  return new Map([...postsOf(graph)].map(([name, post]) => [name, post.main]));
}

/* ------------------------------------------------------------------ logs */

/** The log of the step writing into `outputDir`, which the engine makes in `{cas}/{key}/`. */
const logOf = (outputDir: string): string => {
  const keyDir = dirname(outputDir);
  return logPath(dirname(keyDir), basename(keyDir));
};

/**
 * Writes the log of the step writing into `outputDir` beside it and renames it into place, so a
 * reader never sees half of one. Every attempt of a key writes the same log, so a run whose node
 * a concurrent run of the same key also runs may show that run's log: the same command on the
 * same inputs.
 */
async function writeLog(fs: Ports["fs"], outputDir: string, log: string): Promise<void> {
  const path = logOf(outputDir);
  const written = `${path}.${basename(outputDir)}`;
  await fs.writeText(written, log);
  await fs.rename(written, path);
}
/* ------------------------------------------------------------------ run */

interface RunParams extends BaseParams {
  deps?: Deps;
  inputs?: Record<string, FileInput>;
}

/** A run step's value inputs; its files are inputs too, each named by its path. */
interface RunInputs {
  version: string;
  cmd: string[];
  cwd: string;
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  config?: unknown;
}

/** A run node's outputs: `result.json`, plus each file the spec declared under `DAGACTIONS_OUT`. */
export type RunOutputs<O extends string = never> = Record<"result" | O, string>;

/**
 * One output of a step as a command refers to it: `pack.outputs.tarball`, the
 * `steps.pack.outputs.tarball` of a workflow file. Whole or inside a template string
 * (`--file=${pack.outputs.tarball}`), in a command argument, an `env` value or an artifact path,
 * it resolves to the file's path when the step runs; the step it names must be in `deps`. A
 * plain `{ node, output }` is a ref as an argument of its own; in a template string, which calls
 * `toString`, the graph build refuses it.
 */
export interface OutputRef {
  readonly node: string;
  readonly output: string;
  /**
   * The token a string holds in the ref's place: the node and output names. The step that takes
   * it keys it by the roles that node has in its deps and the output's name, never a path or the
   * node's name. Its NUL bytes keep it apart from any text, and make a token that nothing
   * resolved fail at spawn.
   */
  toString(): string;
}

const REF_TAG = "dagactions-ref";
const REF = new RegExp(`\\0${REF_TAG}:([^\\0]*)\\0`, "g");
const DEP_TAG = "dagactions-dep";
const DEP = new RegExp(`\\0${DEP_TAG}:([^\\0]*)\\0`, "g");

/** The token a string holds in place of `node.outputs.output`. */
export const refToken = (node: string, output: string): string =>
  `\0${REF_TAG}:${JSON.stringify([node, output])}\0`;

function outputRef(node: string, output: string): OutputRef {
  const token = refToken(node, output);
  return { node, output, toString: () => token };
}

/** `text` with each ref's token replaced by what `fill` makes of its node and output. */
const fillRefs = (text: string, fill: (node: string, output: string) => string): string =>
  text.replace(REF, (_, ref: string) => fill(...(JSON.parse(ref) as [string, string])));

/**
 * The token a step's own command, `env` or artifact path holds for a ref, as its key holds it:
 * the roles the ref's node has in the step's deps and the output's name, as the engine keys an
 * output ref in a value input. So renaming the dep re-keys neither the step nor its dependents.
 */
const depToken = (roles: string[], output: string): string =>
  `\0${DEP_TAG}:${JSON.stringify([roles, output])}\0`;

/** `text` with each dep token replaced by what `fill` makes of its first role and output. */
const fillDeps = (
  text: string,
  fill: (role: string, output: string, token: string) => string,
): string =>
  text.replace(DEP, (token, ref: string) => {
    const [roles, output] = JSON.parse(ref) as [string[], string];
    return fill(roles[0]!, output, token);
  });

/** What `run` returns: the engine's ref, and `outputs` with an `OutputRef` per output. */
export type RunRef<O extends string = never> = NodeRef<RunOutputs<O>> & {
  outputs: Record<"result" | O, OutputRef>;
};

type Arg = string | OutputRef;

/**
 * An argument as the command and the key hold it. A ref's token comes from its fields, not its
 * `toString`, so a plain `{ node, output }` is a ref too; only a template string calls `toString`.
 */
const text = (arg: Arg): string => (typeof arg === "string" ? arg : refToken(arg.node, arg.output));

/**
 * `texts` with each ref, which names a node, as the dep token of the roles that node has in
 * `deps`, and the nodes the refs name. A ref to a node outside `deps` is refused.
 */
function byRole(name: string, texts: string[], deps: Deps): { texts: string[]; refs: string[] } {
  const refs = new Set<string>();
  const rolesOf = (node: string) =>
    Object.keys(deps)
      .filter((role) => deps[role]?.name === node)
      .sort();
  const keyed = texts.map((value) => {
    if (value.includes("[object Object]"))
      throw new Error(
        `${name}: an object in a template string; a ref there must come from a step's outputs`,
      );
    return fillRefs(value, (node, output) => {
      const roles = rolesOf(node);
      if (roles.length === 0)
        throw new Error(`${name} uses ${node}.outputs.${output}, but ${node} is not in its deps`);
      refs.add(node);
      return depToken(roles, output);
    });
  });
  return { texts: keyed, refs: [...refs] };
}

/** `text` with each ref as the step names it: `node.outputs.output`. */
const described = (text: string, deps: Deps): string =>
  fillDeps(text, (role, output) => `${deps[role]!.name}.outputs.${output}`);

/**
 * `text` with each ref replaced by its output's path. A settled dep that failed has no path: a
 * ref to it that is the whole of `text` makes it undefined, and one inside a longer string, which
 * would build some other path, fails the step.
 */
function fillPaths(text: string, deps: Deps, depOutputs: DepOutputs): string | undefined {
  let missing = false;
  const filled = fillDeps(text, (role, output, token) => {
    const node = deps[role]!.name;
    const out = depOutputs[role];
    if (out === undefined) {
      if (text !== token)
        throw new Error(`"${described(text, deps)}" has no path: ${node}, a settled dep, failed`);
      missing = true;
      return "";
    }
    const path = typeof out === "object" && !Array.isArray(out) ? out[output] : undefined;
    if (path === undefined) throw new Error(`${node} has no output ${output}`);
    return [path].flat().join(":");
  });
  return missing ? undefined : filled;
}

/** The longest timeout setTimeout can keep: 2^31 - 1 ms. */
const MAX_TIMEOUT_MINUTES = 35_791;

/**
 * Everything a run node needs except its name. `G` is the set of concurrency groups the
 * workflow's limits declare; the facade from defineWorkflow narrows it so a misspelled group,
 * which the scheduler would silently leave unlimited, is a type error instead.
 */
export interface RunSpec<G extends string = never, O extends string = never> {
  /** The command and its arguments, no shell. `$DAGACTIONS_OUT` is the output directory; an `OutputRef`, whole or in a template string, is the path it names. */
  cmd: Arg[];
  cwd?: string;
  /**
   * Variables for the command, in the cache key like the command itself, merged over what it
   * inherits: the step's whole environment. Secrets stay in the inherited environment, out of the
   * key.
   */
  env?: Record<string, Arg>;
  /**
   * Files the command writes under `$DAGACTIONS_OUT`, by role: `{ tarball: "pkg-1.0.0.tgz" }`. Each
   * becomes an output, content-addressed like any other, and a missing one fails the node.
   */
  outputs?: Record<O, string>;
  /** Files outside the graph the command reads; each is a `file()` input, named by its path, and joins the cache key. */
  inputs?: string[];
  /** Upstream nodes the command needs. Ordering lives here, nowhere else. */
  deps?: Deps;
  group?: G;
  /**
   * GitHub's `timeout-minutes` for the step. When it elapses the command is interrupted as a
   * cancel interrupts it, and the step fails ("The action 'test' has timed out after 15 minutes.")
   * whatever the command exits with. Fractions are allowed. Unset is no limit. Not in the cache key.
   */
  timeoutMinutes?: number;
  /** `false` for nondeterministic commands (integration tests): run every time, never cache. */
  cacheable?: boolean;
  /** Anything else the result depends on that no file captures, such as the tool's version: a JSON value. */
  config?: unknown;
  /**
   * Fingerprints for deps the command reads only part of, keyed by role: the engine's
   * `invalidateOn`. A constant fingerprint orders the node after a dep it reads nothing from, such
   * as a cache restore: `deps: { cas }, invalidateOn: { cas: () => "" }`.
   */
  invalidateOn?: Record<string, (outputs: Outputs) => string | Promise<string>>;
}

/**
 * The generic step: run a command; a non-zero exit fails the node. Its outputs are `result.json`
 * (command, cwd, exit code) and the files it declared under `$DAGACTIONS_OUT`. The log is written
 * beside them for the reporter but is not an output, so a timing line never re-keys a consumer.
 * The command, `cwd` and `env` are value inputs, in the cache key; the files it reads come in
 * through `inputs`, upstream results through `deps`. A dep's output is named where the command
 * takes it, `["npm", "publish", pack.outputs.tarball]` or `env: { TARBALL: pack.outputs.tarball }`,
 * and resolves to its path at run time. For a settled dep that failed, a whole argument is the
 * empty string, as `${{ steps.pack.outputs.tarball }}` would be, and a template string fails the
 * step.
 */
export function run<O extends string = never>(
  graph: StepGraph,
  opts: RunSpec<string, O> & { name: string; postOf?: string },
): RunRef<O> {
  // As the engine refuses it: a spread that still carries it would key the node on the whole dep.
  if ("normalize" in opts)
    throw new Error(
      `${opts.name}: normalize is gone: declare invalidateOn: { [role]: (outputs) => fingerprint }`,
    );
  const minutes = opts.timeoutMinutes;
  if (minutes !== undefined && !(minutes > 0 && minutes <= MAX_TIMEOUT_MINUTES))
    throw new RangeError(
      `${opts.name}: timeoutMinutes must be more than 0 and at most ${MAX_TIMEOUT_MINUTES}, got ${minutes}`,
    );
  const invalidateOn = opts.invalidateOn;
  const declared = opts.outputs ?? ({} as Record<O, string>);
  const deps = opts.deps ?? {};
  const cmd = byRole(opts.name, opts.cmd.map(text), deps);
  const envNames = Object.keys(opts.env ?? {});
  const envValues = byRole(opts.name, Object.values(opts.env ?? {}).map(text), deps);
  const inputs: RunInputs = {
    version: "run:v6",
    cmd: cmd.texts,
    cwd: opts.cwd ?? "",
    ...(opts.env && {
      env: Object.fromEntries(envNames.map((k, i) => [k, envValues.texts[i]!])),
    }),
    ...(opts.outputs && { outputs: opts.outputs }),
    ...(opts.config !== undefined && { config: opts.config }),
  };
  const step = defineStep<RunParams, RunOutputs<O>, RunInputs>({
    kind: opts.name,
    inputs,
    ...(opts.group && { concurrencyGroup: opts.group }),
    ...(opts.cacheable === false && { cacheable: false }),
    ...(minutes !== undefined && { timeoutMs: Math.max(1, Math.round(minutes * 60_000)) }),
    ...(invalidateOn && { invalidateOn }),
    action: async ({ inputs, depOutputs, ports, outputDir, signal, output }) => {
      const resolve = (text: string): string =>
        fillPaths(text.replace(/\$DAGACTIONS_OUT\b/g, outputDir), deps, depOutputs) ?? "";
      const vars = Object.entries(inputs.env ?? {}).map(([k, v]) => [k, resolve(v)]);
      const argv = inputs.cmd.map(resolve);
      const r = await ports.sh.run(argv, {
        ...(inputs.cwd && { cwd: inputs.cwd }),
        env: { ...Object.fromEntries(vars), DAGACTIONS_OUT: outputDir },
        signal,
        onOutput: output,
      });
      await writeLog(ports.fs, outputDir, r.output);
      const result = `${outputDir}/result.json`;
      // An output whose bytes key its dependents, so it keeps the cwd as configured.
      await ports.fs.writeText(
        result,
        JSON.stringify({ cmd: inputs.cmd, cwd: inputs.cwd, code: r.code }, null, 2),
      );
      const cause: CommandCause = { argv, cwd: inputs.cwd || ".", code: r.code };
      if (!r.ok) throw new Error(`${argv.join(" ")} exited ${r.code}`, { cause });
      // One that traps its timeout's signal and exits 0 timed out all the same, as its cause says.
      if (signal.aborted) throw new Error(`${argv.join(" ")} was stopped`, { cause });
      const outputs = { result } as RunOutputs<O>;
      for (const [role, file] of Object.entries(declared) as [O, string][]) {
        const path = `${outputDir}/${file}`;
        if (!(await ports.fs.exists(path)))
          throw new Error(`declared output ${role} missing: ${file}`, { cause });
        outputs[role] = path;
      }
      return outputs;
    },
  });
  const files = opts.inputs && { inputs: Object.fromEntries(opts.inputs.map((p) => [p, file(p)])) };
  const ref = step.addNode(graph, { ...files, ...(opts.deps && { deps: opts.deps }) });
  if (opts.postOf)
    recordPost(graph, ref.name, {
      main: opts.postOf,
      refs: [...new Set([...cmd.refs, ...envValues.refs])],
      deps,
      addTo: (g, name, deps) => void step.addNode(g, { ...files, name, deps }),
    });
  const outputs = Object.fromEntries(
    ["result", ...Object.keys(declared)].map((output) => [output, outputRef(ref.name, output)]),
  ) as Record<"result" | O, OutputRef>;
  return { ...ref, outputs } as unknown as RunRef<O>;
}

/**
 * Several run nodes at once, keyed by name. The record says what it is: a set of named
 * nodes with no order among them. Any ordering is declared through each spec's `deps`. The
 * returned record has the same keys, so `checks.lint` is a typed ref for downstream nodes.
 */
export function runAll<K extends string>(
  graph: StepGraph,
  specs: Record<K, RunSpec<string>>,
): Record<K, RunRef> {
  return Object.fromEntries(
    (Object.entries(specs) as [K, RunSpec<string>][]).map(([name, spec]) => [
      name,
      run(graph, { name, ...spec }),
    ]),
  ) as Record<K, RunRef>;
}

/* ------------------------------------------------------------------ gate */

interface GateParams extends BaseParams {
  deps: Record<string, SettledRef>;
}

/**
 * The required-check: a settled dep on every node in `deps`, so it runs even when some fail
 * (GitHub's `if: always()`), and fails itself if any of them did not produce a result. `deps` is
 * a record like every other node's, keyed by the role each check plays.
 */
export function gate(
  graph: StepGraph,
  opts: { name?: string; deps: Record<string, NodeRef> },
): NodeRef<string> {
  const roles = Object.keys(opts.deps).sort();
  const step = defineStep<GateParams, string>({
    kind: opts.name ?? "gate",
    inputs: { version: "gate:v1" },
    action: async ({ depOutputs, ports, outputDir }) => {
      const present = roles.filter((r) => depOutputs[r] !== undefined);
      const missing = roles.filter((r) => depOutputs[r] === undefined);
      const out = `${outputDir}/gate.json`;
      await ports.fs.writeText(out, JSON.stringify({ present, missing }, null, 2));
      if (missing.length > 0) throw new Error(`failed: ${missing.join(", ")}`);
      return out;
    },
  });
  return step.addNode(graph, {
    deps: Object.fromEntries(Object.entries(opts.deps).map(([role, ref]) => [role, settled(ref)])),
  });
}

/* ------------------------------------------------------------------ post */

/** A post step is a run step with a `main`; it runs every time, so it is never cacheable. */
export type PostSpec<G extends string = never, O extends string = never> = Omit<
  RunSpec<G, O>,
  "cacheable" | "deps"
> & {
  /** The node this is the post of; the command names its outputs as `main.outputs.<key>`, like any dep's. */
  main: NodeRef;
  /** What the post waits for. A graph has no end of job, so this is never implied; `{}` is right after `main`. */
  deps: Deps;
};

/**
 * A command as the `post:` of another node, as a GitHub action's post runs after its main: it
 * runs every time its main succeeded, after the `deps` it names whether they succeeded or not
 * (`if: always()` is `settled`, as everywhere else), and still runs after a cancel, from the
 * run's history. A failed main has no post.
 */
export function post<O extends string = never>(
  graph: StepGraph,
  opts: PostSpec<string, O> & { name: string },
): RunRef<O> {
  const { main, ...spec } = opts;
  return run(graph, {
    ...spec,
    cacheable: false,
    deps: { main, ...spec.deps },
    postOf: main.name,
  });
}

/* ------------------------------------------------------------ actions/cache */

/** The inputs of `actions/cache/restore`: `path`, `key`, `restore-keys`. */
export interface RestoreCacheSpec {
  name: string;
  path: string[];
  key: string;
  restoreKeys?: string[];
}

/** What `restoreCache` returns: the node, and the spec `saveCache` saves by. */
export type RestoreCacheRef = NodeRef<string> & { spec: RestoreCacheSpec };

/**
 * `actions/cache/restore` as a node. It runs every time and writes what `@actions/cache` returned
 * to `cache.json`: the key it restored, or null on a miss. A cached node that depends on it but
 * reads nothing from it declares `invalidateOn` for the dep, so the matched key does not re-key it.
 */
export function restoreCache(graph: StepGraph, spec: RestoreCacheSpec): RestoreCacheRef {
  const restoreKeys = spec.restoreKeys ?? [];
  const step = defineStep<BaseParams, string>({
    kind: spec.name,
    inputs: { version: "restore-cache:v1", path: spec.path, key: spec.key, restoreKeys },
    cacheable: false,
    action: async ({ ports, outputDir }) => {
      const matched = await ports.actionsCache.restoreCache(spec.path, spec.key, restoreKeys);
      const out = `${outputDir}/cache.json`;
      await ports.fs.writeText(out, JSON.stringify(matched ?? null));
      await writeLog(
        ports.fs,
        outputDir,
        matched
          ? `Cache restored from key: ${matched}`
          : `Cache not found for input keys: ${[spec.key, ...restoreKeys].join(", ")}`,
      );
      return out;
    },
  });
  return { ...step.addNode(graph, {}), spec };
}

interface SaveCacheParams extends BaseParams {
  deps: Deps;
}

/**
 * `actions/cache/save` as the post step of a restore, with the `if: cache-hit != 'true'` every
 * example writes by hand. When else it runs is its deps: a required dep saves only when that
 * node succeeded, a settled one saves regardless (`if: always()`). `save.json` holds what
 * `@actions/cache` returned, the entry's id or -1 when it did not save, or null when it was not
 * asked: a hit on the primary key, or a save the service refused, which is a warning, not a
 * failure. An invalid key is a workflow bug and fails the node.
 */
export function saveCache(
  graph: StepGraph,
  opts: { name: string; cache: RestoreCacheRef; deps: Deps },
): NodeRef<string> {
  const { path, key } = opts.cache.spec;
  const step = defineStep<SaveCacheParams, string>({
    kind: opts.name,
    inputs: { version: "save-cache:v2" },
    cacheable: false,
    action: async ({ depOutputs, ports: p, outputDir }) => {
      const matched = JSON.parse(await p.fs.readText(depOutputs["cache"] as string)) as
        | string
        | null;
      const out = `${outputDir}/save.json`;
      // The post pass reruns a save the cancel landed on in a new output dir. A copy of what it
      // returned, beside the log where every attempt of the key finds it, keeps it from saving twice.
      const record = logOf(outputDir).replace(/log$/, "save.json");
      const done = async (id: number | null, line: string) => {
        await p.fs.writeText(out, JSON.stringify(id));
        await p.fs.writeText(record, JSON.stringify(id));
        await writeLog(p.fs, outputDir, line);
        return out;
      };
      if (matched === key) {
        return done(null, `Cache hit occurred on the primary key ${key}, not saving cache.`);
      }
      const prior = (await p.fs.exists(record))
        ? (JSON.parse(await p.fs.readText(record)) as number | null)
        : null;
      if (prior !== null && prior >= 0) return done(prior, `Cache saved with key: ${key}`);
      let id: number;
      try {
        id = await p.actionsCache.saveCache(path, key);
      } catch (e) {
        if (e instanceof Error && e.name === "ValidationError") throw e;
        const message = e instanceof Error ? e.message : String(e);
        p.ci.annotate("warning", opts.name, message);
        return done(null, `Failed to save: ${message}`);
      }
      // The toolkit returns -1 when it did not save: the key exists already, or there is no service.
      if (id < 0) return done(id, `Cache not saved with key: ${key}`);
      return done(id, `Cache saved with key: ${key}`);
    },
  });
  const deps = { cache: opts.cache, ...opts.deps };
  const ref = step.addNode(graph, { deps });
  recordPost(graph, ref.name, {
    main: opts.cache.name,
    refs: [],
    deps,
    addTo: (g, name, deps) => void step.addNode(g, { name, deps }),
  });
  return ref;
}

/* ------------------------------------------------- actions/upload-artifact */

/** The inputs of `actions/upload-artifact`: `name`, `path`, `if-no-files-found`, `overwrite`, and the client's own options. */
export interface UploadArtifactSpec {
  /** The node's name; `artifact` is the artifact's. */
  name: string;
  /** The artifact's name on the run page: no `"`, `:`, `<`, `>`, `|`, `*`, `?`, `\\` or `/`. */
  artifact: string;
  /** What goes in: globs over the working tree, as `w.glob` takes them, and outputs of nodes in `deps`, whole or in a template string. */
  path: Arg[];
  deps?: Deps;
  /** What an empty `path` does: a warning and no artifact (the default), a failure, or nothing. */
  ifNoFilesFound?: "warn" | "error" | "ignore";
  /** Delete an artifact of the same name first: a re-run of a failed job shares its run's artifacts. */
  overwrite?: boolean;
  /** Handed to `@actions/artifact` as is: `retentionDays`, `compressionLevel`, `skipArchive`. */
  options?: UploadArtifactOptions;
}

/** The deepest directory every file is under, the archive's root: `a/b/x` and `a/c/y` give `a`. */
function commonDir(files: string[]): string {
  const dirs = files.map((f) => f.split("/").slice(0, -1));
  const first = dirs[0] ?? [];
  const depth = dirs.reduce((n, d) => {
    let i = 0;
    while (i < n && d[i] === first[i]) i++;
    return i;
  }, first.length);
  return first.slice(0, depth).join("/") || ".";
}

/**
 * `actions/upload-artifact` as a node. Artifacts belong to a run, so it runs every time, never
 * from the cache, and writes what `@actions/artifact` returned to `artifact.json`: the id, size
 * and digest, or `{}` when nothing went up. `path` names the files: a glob is matched when the
 * node runs, an output ref resolves to the file a dep produced, so `path: [pack.outputs.tarball]`
 * uploads a tarball straight from the CAS. The archive is rooted at the deepest directory holding
 * every file, as the action roots it, so one node's outputs sit at the top. An upload the service
 * refuses fails the node, as the action fails its step; without a service, locally or in a
 * `run:` step, nothing is uploaded and the log says so.
 */
export function uploadArtifact(graph: StepGraph, spec: UploadArtifactSpec): NodeRef<string> {
  const ifNoFilesFound = spec.ifNoFilesFound ?? "warn";
  const deps = spec.deps ?? {};
  const { texts: path } = byRole(spec.name, spec.path.map(text), deps);
  const step = defineStep<{ deps?: Deps }, string>({
    kind: spec.name,
    inputs: {
      version: "upload-artifact:v2",
      artifact: spec.artifact,
      path,
      ifNoFilesFound,
      ...(spec.overwrite !== undefined && { overwrite: spec.overwrite }),
      ...(spec.options && { options: spec.options }),
    },
    cacheable: false,
    action: async ({ depOutputs, ports: p, outputDir }) => {
      const patterns = path.filter((entry) => entry.search(DEP) < 0);
      // An entry naming an output is a file, left out when it is a failed settled dep's.
      const named = path.flatMap((entry) => {
        if (entry.search(DEP) < 0) return [];
        const file = fillPaths(entry, deps, depOutputs);
        return file === undefined ? [] : [file];
      });
      const files = [...(patterns.length ? await glob(patterns) : []), ...named];
      const out = `${outputDir}/artifact.json`;
      const done = async (uploaded: UploadArtifactResponse, line: string) => {
        await p.fs.writeText(out, JSON.stringify(uploaded, null, 2));
        await writeLog(p.fs, outputDir, line);
        return out;
      };
      if (files.length === 0) {
        const shown = path.map((entry) => described(entry, deps));
        const line = `No files were found with the provided path: ${shown.join(", ")}. No artifacts will be uploaded.`;
        if (ifNoFilesFound === "error") throw new Error(line);
        if (ifNoFilesFound === "warn") p.ci.annotate("warning", spec.name, line);
        return done({}, line);
      }
      if (spec.overwrite) {
        try {
          await p.actionsArtifact.deleteArtifact(spec.artifact);
        } catch (e) {
          if (!(e instanceof Error && e.name === "ArtifactNotFoundError")) throw e;
        }
      }
      const uploaded = await p.actionsArtifact.uploadArtifact(
        spec.artifact,
        files,
        commonDir(files),
        spec.options,
      );
      if (uploaded.id === undefined)
        return done(uploaded, `Artifact ${spec.artifact} not uploaded: no artifact service`);
      return done(
        uploaded,
        `Artifact ${spec.artifact} has been successfully uploaded! Final size is ${uploaded.size ?? 0} bytes. Artifact ID is ${uploaded.id}`,
      );
    },
  });
  return step.addNode(graph, spec.deps ? { deps: spec.deps } : {});
}
