import type { UploadArtifactOptions, UploadArtifactResponse } from "@actions/artifact";
import {
  dep,
  isFileHandle,
  nodeInputs,
  settled,
  type Dep,
  type DepRecord,
  type DepRefs,
  type DepSpecs,
  type Graph,
  type NodeRef,
  type OutputRef,
  type SettledDep,
  type SettledOutputRef,
} from "@mrmeku/dagraph";
import { defineStep } from "./define-step.ts";
import { errorMessage } from "./kernel/format.ts";
import type { Ports } from "./ports.ts";
import { logOf, writeLog } from "./step-records.ts";
import { depRoles } from "./task.ts";

export { logPath, type CommandCause } from "./step-records.ts";

/**
 * `workflow.glob` and `workflow.hash`, which load `@actions/glob` on first use: it brings half the
 * toolkit and filters stdout (ports/glob.ts), which importing the package must not.
 */
export const glob = async (patterns: string[]): Promise<string[]> =>
  (await import("./ports/glob.ts")).glob(patterns);
export const hashFiles = async (patterns: string[]): Promise<string> =>
  (await import("./ports/glob.ts")).hashFiles(patterns);

/** The graph a workflow adds its steps to; its nodes' `meta` is the team's. */
type StepGraph = Graph<Ports>;

/** A step's deps as its action declares them: any role, as each workflow names them. */
const anyRole: DepSpecs = {};

/* ------------------------------------------------------------------ posts */

/**
 * A post step as the facade records it beside the graph: its main, the nodes its command names,
 * its deps, and how to add it to another graph under its name with other deps, as `--only` does.
 */
export interface PostRecord {
  main: string;
  refs: string[];
  deps: DepRecord;
  addTo: (graph: StepGraph, name: string, deps: DepRecord) => void;
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

/** Each post step of the graph, by name, with its main's: `dag post` runs the ones a cancelled run did not. */
export function postNodes(graph: StepGraph): Map<string, string> {
  return new Map([...postsOf(graph)].map(([name, post]) => [name, post.main]));
}

/* ------------------------------------------------------------------ requireAll */

/** The required-check's deps as its action declares them: any role, each settled. */
const anySettledRole: Record<string, SettledDep> = {};

/**
 * The required-check: a settled dep on every node in `deps`, so it runs even when some fail
 * (GitHub's `if: always()`), and fails itself if any of them did not produce a result. `deps` is
 * a record like every other node's, keyed by the role each check plays.
 */
export function requireAll(
  graph: StepGraph,
  opts: { name?: string; deps: Record<string, NodeRef> },
): NodeRef<string> {
  const roles = Object.keys(opts.deps).sort();
  const step = defineStep({
    kind: opts.name ?? "require-all",
    deps: anySettledRole,
    inputs: { version: "require-all:v1" },
    action: async ({ depOutputs, ports, outputDir }) => {
      const present = roles.filter((r) => depOutputs[r] !== undefined);
      const missing = roles.filter((r) => depOutputs[r] === undefined);
      const out = `${outputDir}/require-all.json`;
      await ports.fs.writeText(out, JSON.stringify({ present, missing }, null, 2));
      if (missing.length > 0) throw new Error(`failed: ${missing.join(", ")}`);
      return out;
    },
  });
  return step.addNode(graph, {
    deps: Object.fromEntries(Object.entries(opts.deps).map(([role, ref]) => [role, settled(ref)])),
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
  const step = defineStep({
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
  return Object.assign(step.addNode(graph, {}), { spec });
}

/** A save's deps as its action declares them: the restore it saves for, and any other role. */
const cacheAndAnyRole: DepSpecs & { cache: Dep<string> } = { cache: dep<string>() };

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
  opts: { name: string; cache: RestoreCacheRef; deps: DepRecord & { cache?: never } },
): NodeRef<string> {
  const { path, key } = opts.cache.spec;
  const step = defineStep({
    kind: opts.name,
    deps: cacheAndAnyRole,
    inputs: { version: "save-cache:v2" },
    cacheable: false,
    action: async ({ depOutputs, ports: p, outputDir }) => {
      const matched: unknown = JSON.parse(await depOutputs.cache.text());
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
      const prior: unknown = (await p.fs.exists(record))
        ? JSON.parse(await p.fs.readText(record))
        : null;
      if (typeof prior === "number" && prior >= 0)
        return done(prior, `Cache saved with key: ${key}`);
      let id: number;
      try {
        id = await p.actionsCache.saveCache(path, key);
      } catch (e) {
        if (e instanceof Error && e.name === "ValidationError") throw e;
        const message = errorMessage(e);
        p.host.annotate("warning", opts.name, message);
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
    addTo: (g, name, deps) => void step.addNode(g, { name, deps: { ...deps, cache: opts.cache } }),
  });
  return ref;
}

/* ------------------------------------------------- actions/upload-artifact */

/** What an artifact's `path` names: a glob, or an output of a dep, missing when a `settled` one failed. */
type PathItem<S> =
  | string
  | OutputRef<string | string[], S>
  | SettledOutputRef<string | string[], S>;

/** The inputs of `actions/upload-artifact`: `name`, `path`, `if-no-files-found`, `overwrite`, and the client's own options. */
export interface UploadArtifactSpec<D extends DepRecord = DepRecord> {
  /** The node's name; `artifact` is the artifact's. */
  name: string;
  /** The artifact's name on the run page: no `"`, `:`, `<`, `>`, `|`, `*`, `?`, `\\` or `/`. */
  artifact: string;
  /**
   * Globs as `workflow.glob` takes them, or a function of `deps` that names their outputs too,
   * left out when a `settled` dep failed: `deps: { pack }, path: ({ pack }) => ["reports/**",
   * pack.tarball]`.
   */
  path: readonly string[] | (<S>(deps: DepRefs<D, S>) => readonly PathItem<S>[]);
  deps?: D;
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
 * node runs, an output ref resolves to the file a dep produced, so `path: ({ pack }) =>
 * [pack.tarball]` uploads a tarball straight from the CAS. The archive is rooted at the deepest
 * directory holding every file, as the action roots it, so one node's outputs sit at the top. An
 * upload the service refuses fails the node, as the action fails its step; without a service,
 * locally or in a `run:` step, nothing is uploaded and the log says so.
 */
export function uploadArtifact<D extends DepRecord>(
  graph: StepGraph,
  spec: UploadArtifactSpec<D>,
): NodeRef<string> {
  const ifNoFilesFound = spec.ifNoFilesFound ?? "warn";
  // What `path` names, as the no-files message shows it; set when the node is added.
  let shown: string[] = [];
  const step = defineStep({
    kind: spec.name,
    deps: anyRole,
    nodeInputs: nodeInputs<{ path: readonly PathItem<unknown>[] }>,
    inputs: {
      version: "upload-artifact:v4",
      artifact: spec.artifact,
      ifNoFilesFound,
      ...(spec.overwrite !== undefined && { overwrite: spec.overwrite }),
      // A copy: the toolkit's options are an interface, and an interface is never an InputValue.
      ...(spec.options && { options: { ...spec.options } }),
    },
    cacheable: false,
    action: async ({ inputs: { path }, ports: p, outputDir }) => {
      const patterns = path.filter((item) => typeof item === "string");
      const named = path.flatMap((item) =>
        isFileHandle(item) ? [item.path] : Array.isArray(item) ? item.map((file) => file.path) : [],
      );
      const files = [...(patterns.length ? await glob(patterns) : []), ...named];
      const out = `${outputDir}/artifact.json`;
      const done = async (uploaded: UploadArtifactResponse, line: string) => {
        await p.fs.writeText(out, JSON.stringify(uploaded, null, 2));
        await writeLog(p.fs, outputDir, line);
        return out;
      };
      if (files.length === 0) {
        const line = `No files were found with the provided path: ${shown.join(", ")}. No artifacts will be uploaded.`;
        if (ifNoFilesFound === "error") throw new Error(line);
        if (ifNoFilesFound === "warn") p.host.annotate("warning", spec.name, line);
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
  return step.addNode(graph, {
    ...(spec.deps && { deps: spec.deps }),
    inputs: (refs) => {
      const path = typeof spec.path === "function" ? spec.path(refs) : spec.path;
      // A ref as the function named it: its dep's role and its output.
      const roles = depRoles(spec.deps);
      shown = path.map((item) =>
        typeof item === "string"
          ? item
          : `${roles.find(([, dep]) => dep.name === item.node)?.[0] ?? item.node}.${item.output}`,
      );
      return { path };
    },
  });
}
