import {
  hashBytes,
  type Graph,
  type NodeRef,
  type OptionalRef,
  type Outputs,
} from "@mrmeku/dagraph";
import { defineStep } from "./define-step.ts";
import type { Ports } from "./ports.ts";

export { glob } from "./ports/glob.ts";

type Deps = Record<string, NodeRef | OptionalRef | undefined>;

/* ------------------------------------------------------------------ hash */

/** One hash over the given files' contents, for a cache key: `${prefix}-${await hashFiles(...)}`. */
export async function hashFiles(ports: Ports, paths: string[]): Promise<string> {
  const sorted = [...paths].sort();
  const lines = await Promise.all(sorted.map(async (p) => `${p}:${await ports.fs.hashFile(p)}`));
  return hashBytes(lines.join("\n"));
}

/* ------------------------------------------------------------------ run */

interface RunParams {
  kind: string;
  deps?: Deps;
  inputs?: string[];
}

interface RunConfig {
  v: number;
  cmd: Arg[];
  cwd: string;
  env?: Record<string, Arg>;
  outputs?: Record<string, string>;
  config?: unknown;
}

/** A run node's outputs: `result.json`, plus each file the spec declared under `DAGACTIONS_OUT`. */
export type RunOutputs<O extends string = never> = Record<"result" | O, string>;

/**
 * One output of a step as a command refers to it: `pack.outputs.tarball`, the
 * `steps.pack.outputs.tarball` of a workflow file. In a command argument or an `env` value it
 * resolves to the file's path when the command runs; the step it names must be in `deps`.
 */
export interface OutputRef {
  readonly node: string;
  readonly output: string;
}

/** What `run` returns: the engine's ref, and `outputs` with an `OutputRef` per output. */
export type RunRef<O extends string = never> = NodeRef<RunOutputs<O>> & {
  outputs: Record<"result" | O, OutputRef>;
};

type Arg = string | OutputRef;

/**
 * Everything a run node needs except its name. `G` is the set of concurrency groups the
 * workflow's limits declare; the facade from defineWorkflow narrows it so a misspelled group,
 * which the scheduler would silently leave unlimited, is a type error instead.
 */
export interface RunSpec<G extends string = string, O extends string = never> {
  /** The command and its arguments, no shell. `$DAGACTIONS_OUT` is the output directory; an `OutputRef` is the path it names. */
  cmd: Arg[];
  cwd?: string;
  /** Variables for the command, in the cache key like the command itself: secrets stay in the process environment. */
  env?: Record<string, Arg>;
  /**
   * Files the command writes under `$DAGACTIONS_OUT`, by role: `{ tarball: "pkg-1.0.0.tgz" }`. Each
   * becomes an output, content-addressed like any other, and a missing one fails the node.
   */
  outputs?: Record<O, string>;
  /** Files outside the graph the command reads; their hashes join the cache key. */
  inputs?: string[];
  /** Upstream nodes the command needs. Ordering lives here, nowhere else. */
  deps?: Deps;
  group?: G;
  /** `false` for nondeterministic commands (integration tests): run every time, never cache. */
  cacheable?: boolean;
  /** Anything else the result depends on that no file captures, such as the tool's version. */
  config?: unknown;
  /**
   * Fingerprints for deps the command reads only part of, keyed by role: the engine's
   * `normalize`. A constant fingerprint orders the node after a dep it reads nothing from, such
   * as a cache restore: `deps: { cas }, normalize: { cas: () => "" }`.
   */
  normalize?: Record<string, (outputs: Outputs) => string | Promise<string>>;
}

/**
 * The generic step: run a command; a non-zero exit fails the node. Its outputs are `result.json`
 * (command, cwd, exit code) and the files it declared under `$DAGACTIONS_OUT`. The logs are written
 * beside them for the reporter but are not outputs, so a timing line never re-keys a consumer.
 * The command and `env` are in the cache key; the files it reads come in through `inputs`,
 * upstream results through `deps`. A dep's output is named where the command takes it,
 * `["npm", "publish", pack.outputs.tarball]` or `env: { TARBALL: pack.outputs.tarball }`, and
 * resolves to its path at run time: the empty string when it is an optional dep that failed,
 * as `${{ steps.pack.outputs.tarball }}` would be.
 */
export function run<O extends string = never>(
  graph: Graph,
  ports: Ports,
  opts: RunSpec<string, O> & { name: string },
): RunRef<O> {
  const normalize = opts.normalize;
  const declared = opts.outputs ?? ({} as Record<O, string>);
  const roleOf = Object.fromEntries(
    Object.entries(opts.deps ?? {}).flatMap(([role, ref]) => (ref ? [[ref.name, role]] : [])),
  );
  for (const arg of [...opts.cmd, ...Object.values(opts.env ?? {})])
    if (typeof arg !== "string" && !(arg.node in roleOf))
      throw new Error(
        `${opts.name} uses ${arg.node}.outputs.${arg.output}, but ${arg.node} is not in its deps`,
      );
  const step = defineStep<RunParams, RunOutputs<O>, RunConfig>({
    config: {
      v: 4,
      cmd: opts.cmd,
      cwd: opts.cwd ?? "",
      ...(opts.env && { env: opts.env }),
      ...(opts.outputs && { outputs: opts.outputs }),
      ...(opts.config !== undefined && { config: opts.config }),
    },
    ...(opts.group && { concurrencyGroup: opts.group }),
    ...(opts.cacheable === false && { cacheable: false }),
    ...(normalize && { normalize: () => normalize }),
    action: (p) => async (_params, inputs, outputDir, ctx) => {
      const resolve = (arg: Arg): string => {
        if (typeof arg === "string") return arg.replace(/\$DAGACTIONS_OUT\b/g, outputDir);
        const out = inputs[roleOf[arg.node]!];
        if (out === undefined) return "";
        const path = typeof out === "object" && !Array.isArray(out) ? out[arg.output] : undefined;
        if (path === undefined) throw new Error(`${arg.node} has no output ${arg.output}`);
        return [path].flat().join(":");
      };
      const env = Object.fromEntries(
        Object.entries(opts.env ?? {}).map(([k, v]) => [k, resolve(v)]),
      );
      const argv = opts.cmd.map(resolve);
      const r = await p.sh.run(argv, {
        ...(opts.cwd && { cwd: opts.cwd }),
        env: { ...env, DAGACTIONS_OUT: outputDir },
        ...(ctx?.signal && { signal: ctx.signal }),
      });
      await p.fs.writeText(`${outputDir}/stdout.log`, r.stdout);
      await p.fs.writeText(`${outputDir}/stderr.log`, r.stderr);
      const result = `${outputDir}/result.json`;
      await p.fs.writeText(
        result,
        JSON.stringify({ cmd: opts.cmd, cwd: opts.cwd ?? "", code: r.code }, null, 2),
      );
      if (!r.ok) throw new Error(`${argv.join(" ")} exited ${r.code}`);
      const outputs = { result } as RunOutputs<O>;
      for (const [role, file] of Object.entries(declared) as [O, string][]) {
        const path = `${outputDir}/${file}`;
        if (!(await p.fs.exists(path))) throw new Error(`declared output ${role} missing: ${file}`);
        outputs[role] = path;
      }
      return outputs;
    },
  });
  const ref = step.addNode(graph, ports, {
    kind: opts.name,
    ...(opts.inputs && { inputs: opts.inputs }),
    ...(opts.deps && { deps: opts.deps }),
  });
  const outputs = Object.fromEntries(
    ["result", ...Object.keys(declared)].map((output) => [output, { node: ref.name, output }]),
  ) as Record<"result" | O, OutputRef>;
  return { ...ref, outputs };
}

/**
 * Several run nodes at once, keyed by name. The record says what it is: a set of named
 * nodes with no order among them. Any ordering is declared through each spec's `deps`. The
 * returned record has the same keys, so `checks.lint` is a typed ref for downstream nodes.
 */
export function runAll<K extends string>(
  graph: Graph,
  ports: Ports,
  specs: Record<K, RunSpec>,
): Record<K, RunRef> {
  return Object.fromEntries(
    (Object.entries(specs) as [K, RunSpec][]).map(([name, spec]) => [
      name,
      run(graph, ports, { name, ...spec }),
    ]),
  ) as Record<K, RunRef>;
}

/* ------------------------------------------------------------------ gate */

interface GateParams {
  kind: string;
  deps: Record<string, OptionalRef>;
}

/**
 * The required-check: depends optionally on every node in `deps`, so it runs even when some
 * fail (GitHub's `if: always()`), and fails itself if any of them did not produce a result.
 * `deps` is a record like every other node's, keyed by the role each check plays.
 */
export function gate(
  graph: Graph,
  ports: Ports,
  opts: { name?: string; deps: Record<string, NodeRef> },
): NodeRef<string> {
  const roles = Object.keys(opts.deps).sort();
  const step = defineStep<GateParams, string, string>({
    config: "gate:v1",
    action: (p) => async (_params, inputs, outputDir) => {
      const present = roles.filter((r) => inputs[r] !== undefined);
      const missing = roles.filter((r) => inputs[r] === undefined);
      const out = `${outputDir}/gate.json`;
      await p.fs.writeText(out, JSON.stringify({ present, missing }, null, 2));
      if (missing.length > 0) throw new Error(`failed: ${missing.join(", ")}`);
      return out;
    },
  });
  return step.addNode(graph, ports, {
    kind: opts.name ?? "gate",
    deps: Object.fromEntries(
      Object.entries(opts.deps).map(([role, ref]) => [role, { name: ref.name, optional: true }]),
    ),
  });
}

/* ------------------------------------------------------------------ post */

const POSTS = new WeakMap<Graph, Set<string>>();

/** Register a node as a post step: `dagactions post` runs it when a cancelled run did not. */
export function markPost(graph: Graph, ref: NodeRef): void {
  let names = POSTS.get(graph);
  if (!names) POSTS.set(graph, (names = new Set()));
  names.add(ref.name);
}

/** The names of the graph's post steps. */
export function postNodes(graph: Graph): string[] {
  return [...(POSTS.get(graph) ?? [])];
}

/** A post step is a run step with a `main`; it runs every time, so it is never cacheable. */
export type PostSpec<G extends string = string, O extends string = never> = Omit<
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
 * (`if: always()` is `optional`, as everywhere else), and still runs after a cancel, from the
 * journal. A failed main has no post.
 */
export function post<O extends string = never>(
  graph: Graph,
  ports: Ports,
  opts: PostSpec<string, O> & { name: string },
): RunRef<O> {
  const { main, ...spec } = opts;
  const ref = run(graph, ports, {
    ...spec,
    cacheable: false,
    deps: { main, ...spec.deps },
  });
  markPost(graph, ref);
  return ref;
}

/* ------------------------------------------------------------ actions/cache */

/** The inputs of `actions/cache/restore`: `path`, `key`, `restore-keys`. */
export interface RestoreCacheSpec {
  name: string;
  path: string[];
  key: string;
  restoreKeys?: string[];
}

/** The outputs of `actions/cache/restore`, camel-cased, plus the paths `saveCache` needs. */
export interface RestoreCacheOutputs {
  cacheHit: boolean;
  cachePrimaryKey: string;
  /** The key restored: the primary key, a restore-key match, or "" on a miss. */
  cacheMatchedKey: string;
  path: string[];
}

/**
 * `actions/cache/restore` as a node. It runs every time and writes its outputs to `cache.json`
 * for `saveCache` and the summary. A cached node that depends on it but reads nothing from it
 * declares `normalize` for the dep, so the matched key does not re-key it.
 */
export function restoreCache(graph: Graph, ports: Ports, spec: RestoreCacheSpec): NodeRef<string> {
  const restoreKeys = spec.restoreKeys ?? [];
  const step = defineStep<{ kind: string }, string, Omit<RestoreCacheSpec, "name"> & { v: number }>(
    {
      config: { v: 1, path: spec.path, key: spec.key, restoreKeys },
      cacheable: false,
      action: (p) => async (_params, _inputs, outputDir) => {
        const matched = await p.actionsCache.restoreCache(spec.path, spec.key, restoreKeys);
        const outputs: RestoreCacheOutputs = {
          cacheHit: matched === spec.key,
          cachePrimaryKey: spec.key,
          cacheMatchedKey: matched ?? "",
          path: spec.path,
        };
        const out = `${outputDir}/cache.json`;
        await p.fs.writeText(out, JSON.stringify(outputs, null, 2));
        await p.fs.writeText(
          `${outputDir}/stdout.log`,
          matched
            ? `Cache restored from key: ${matched}`
            : `Cache not found for input keys: ${[spec.key, ...restoreKeys].join(", ")}`,
        );
        return out;
      },
    },
  );
  return step.addNode(graph, ports, { kind: spec.name });
}

interface SaveCacheParams {
  kind: string;
  deps: Deps;
}

/**
 * `actions/cache/save` as the post step of a restore, with the `if: cache-hit != 'true'` every
 * example writes by hand. When else it runs is its deps: a required dep saves only when that
 * node succeeded, an optional one saves regardless (`if: always()`). A save the service refuses
 * is a warning, not a failure; an invalid key is a workflow bug and fails the node.
 */
export function saveCache(
  graph: Graph,
  ports: Ports,
  opts: { name: string; cache: NodeRef<string>; deps: Deps },
): NodeRef<string> {
  const step = defineStep<SaveCacheParams, string, string>({
    config: "save-cache:v1",
    cacheable: false,
    action: (p) => async (_params, inputs, outputDir) => {
      const restored = JSON.parse(
        await p.fs.readText(inputs["cache"] as string),
      ) as RestoreCacheOutputs;
      const key = restored.cachePrimaryKey;
      const out = `${outputDir}/save.json`;
      const done = async (status: string, line: string) => {
        await p.fs.writeText(out, JSON.stringify({ key, status }, null, 2));
        await p.fs.writeText(`${outputDir}/stdout.log`, line);
        return out;
      };
      if (restored.cacheHit) {
        return done("skipped", `Cache hit occurred on the primary key ${key}, not saving cache.`);
      }
      let id: number;
      try {
        id = await p.actionsCache.saveCache(restored.path, key);
      } catch (e) {
        if (e instanceof Error && e.name === "ValidationError") throw e;
        const message = e instanceof Error ? e.message : String(e);
        p.ci.annotate("warning", opts.name, message);
        return done("failed", `Failed to save: ${message}`);
      }
      // The toolkit returns -1 when it did not save: the key exists already, or there is no service.
      if (id < 0) return done("not-saved", `Cache not saved with key: ${key}`);
      return done("saved", `Cache saved with key: ${key}`);
    },
  });
  const ref = step.addNode(graph, ports, {
    kind: opts.name,
    deps: { cache: opts.cache, ...opts.deps },
  });
  markPost(graph, ref);
  return ref;
}
