import type { UploadArtifactOptions, UploadArtifactResponse } from "@actions/artifact";
import { type Graph, type NodeRef, type OptionalRef, type Outputs } from "@mrmeku/dagraph";
import { defineStep } from "./define-step.ts";
import type { Ports } from "./ports.ts";
import { glob } from "./ports/glob.ts";

export { glob, hashFiles } from "./ports/glob.ts";

type Deps = Record<string, NodeRef | OptionalRef | undefined>;
type Inputs = Record<string, Outputs | undefined>;

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

/** The dep role of each node the output refs in `args` name; a ref to a node outside `deps` is refused. */
function outputRefRoles(name: string, args: Arg[], deps: Deps): Record<string, string> {
  const roleOf = Object.fromEntries(
    Object.entries(deps).flatMap(([role, ref]) => (ref ? [[ref.name, role]] : [])),
  );
  for (const arg of args)
    if (typeof arg !== "string" && !(arg.node in roleOf))
      throw new Error(
        `${name} uses ${arg.node}.outputs.${arg.output}, but ${arg.node} is not in its deps`,
      );
  return roleOf;
}

/** The paths an output ref names at run time: none when it names an optional dep that failed. */
function outputPaths(ref: OutputRef, roleOf: Record<string, string>, inputs: Inputs): string[] {
  const out = inputs[roleOf[ref.node]!];
  if (out === undefined) return [];
  const path = typeof out === "object" && !Array.isArray(out) ? out[ref.output] : undefined;
  if (path === undefined) throw new Error(`${ref.node} has no output ${ref.output}`);
  return [path].flat();
}

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
  const roleOf = outputRefRoles(
    opts.name,
    [...opts.cmd, ...Object.values(opts.env ?? {})],
    opts.deps ?? {},
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
      const resolve = (arg: Arg): string =>
        typeof arg === "string"
          ? arg.replace(/\$DAGACTIONS_OUT\b/g, outputDir)
          : outputPaths(arg, roleOf, inputs).join(":");
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

/** What `restoreCache` returns: the node, and the spec `saveCache` saves by. */
export type RestoreCacheRef = NodeRef<string> & { spec: RestoreCacheSpec };

/**
 * `actions/cache/restore` as a node. It runs every time and writes what `@actions/cache` returned
 * to `cache.json`: the key it restored, or null on a miss. A cached node that depends on it but
 * reads nothing from it declares `normalize` for the dep, so the matched key does not re-key it.
 */
export function restoreCache(graph: Graph, ports: Ports, spec: RestoreCacheSpec): RestoreCacheRef {
  const restoreKeys = spec.restoreKeys ?? [];
  const step = defineStep<{ kind: string }, string, Omit<RestoreCacheSpec, "name"> & { v: number }>(
    {
      config: { v: 1, path: spec.path, key: spec.key, restoreKeys },
      cacheable: false,
      action: (p) => async (_params, _inputs, outputDir) => {
        const matched = await p.actionsCache.restoreCache(spec.path, spec.key, restoreKeys);
        const out = `${outputDir}/cache.json`;
        await p.fs.writeText(out, JSON.stringify(matched ?? null));
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
  return { ...step.addNode(graph, ports, { kind: spec.name }), spec };
}

interface SaveCacheParams {
  kind: string;
  deps: Deps;
}

/**
 * `actions/cache/save` as the post step of a restore, with the `if: cache-hit != 'true'` every
 * example writes by hand. When else it runs is its deps: a required dep saves only when that
 * node succeeded, an optional one saves regardless (`if: always()`). `save.json` holds what
 * `@actions/cache` returned, the entry's id or -1 when it did not save, or null when it was not
 * asked: a hit on the primary key, or a save the service refused, which is a warning, not a
 * failure. An invalid key is a workflow bug and fails the node.
 */
export function saveCache(
  graph: Graph,
  ports: Ports,
  opts: { name: string; cache: RestoreCacheRef; deps: Deps },
): NodeRef<string> {
  const { path, key } = opts.cache.spec;
  const step = defineStep<SaveCacheParams, string, string>({
    config: "save-cache:v2",
    cacheable: false,
    action: (p) => async (_params, inputs, outputDir) => {
      const matched = JSON.parse(await p.fs.readText(inputs["cache"] as string)) as string | null;
      const out = `${outputDir}/save.json`;
      const done = async (id: number | null, line: string) => {
        await p.fs.writeText(out, JSON.stringify(id));
        await p.fs.writeText(`${outputDir}/stdout.log`, line);
        return out;
      };
      if (matched === key) {
        return done(null, `Cache hit occurred on the primary key ${key}, not saving cache.`);
      }
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
  const ref = step.addNode(graph, ports, {
    kind: opts.name,
    deps: { cache: opts.cache, ...opts.deps },
  });
  markPost(graph, ref);
  return ref;
}

/* ------------------------------------------------- actions/upload-artifact */

/** The inputs of `actions/upload-artifact`: `name`, `path`, `if-no-files-found`, `overwrite`, and the client's own options. */
export interface UploadArtifactSpec {
  /** The node's name; `artifact` is the artifact's. */
  name: string;
  /** The artifact's name on the run page: no `"`, `:`, `<`, `>`, `|`, `*`, `?`, `\\` or `/`. */
  artifact: string;
  /** What goes in: globs over the working tree, as `w.glob` takes them, and outputs of nodes in `deps`. */
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
export function uploadArtifact(
  graph: Graph,
  ports: Ports,
  spec: UploadArtifactSpec,
): NodeRef<string> {
  const ifNoFilesFound = spec.ifNoFilesFound ?? "warn";
  const roleOf = outputRefRoles(spec.name, spec.path, spec.deps ?? {});
  const step = defineStep<
    { kind: string; deps?: Deps },
    string,
    Omit<UploadArtifactSpec, "name" | "deps"> & { v: number }
  >({
    config: {
      v: 1,
      artifact: spec.artifact,
      path: spec.path,
      ifNoFilesFound,
      ...(spec.overwrite !== undefined && { overwrite: spec.overwrite }),
      ...(spec.options && { options: spec.options }),
    },
    cacheable: false,
    action: (p) => async (_params, inputs, outputDir) => {
      const patterns = spec.path.filter((a) => typeof a === "string");
      const files = [
        ...(patterns.length ? await glob(patterns) : []),
        ...spec.path.flatMap((a) => (typeof a === "string" ? [] : outputPaths(a, roleOf, inputs))),
      ];
      const out = `${outputDir}/artifact.json`;
      const done = async (uploaded: UploadArtifactResponse, line: string) => {
        await p.fs.writeText(out, JSON.stringify(uploaded, null, 2));
        await p.fs.writeText(`${outputDir}/stdout.log`, line);
        return out;
      };
      if (files.length === 0) {
        const shown = spec.path.map((a) =>
          typeof a === "string" ? a : `${a.node}.outputs.${a.output}`,
        );
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
  return step.addNode(graph, ports, { kind: spec.name, ...(spec.deps && { deps: spec.deps }) });
}
