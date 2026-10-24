import {
  isFileHandle,
  settled,
  type DepRecord,
  type FileHandle,
  type Graph,
  type NodeRef,
} from "@mrmeku/dagraph";
import type { ArtifactUploadOptions, Ports } from "./ports.ts";
import { addTask, type TaskContext } from "./task.ts";

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

/* ------------------------------------------------------------------ posts and saves */

const WAIT_ROLE = "wait:";

/** The role of a post's or a save's wait on `node`, a node it runs after whatever it did. */
export const waitRole = (node: string) => `${WAIT_ROLE}${node}`;

/**
 * A post as the facade records it beside the graph: its main and its dep on it, the deps its main
 * requires, and how to add it to another graph with other deps, as a run adds it with its waits.
 */
export interface PostRecord {
  main: string;
  deps: DepRecord;
  mainRequires: DepRecord;
  addTo: (graph: StepGraph, deps: DepRecord) => void;
}

/** A cache's save as the facade records it: its restore, and how a run adds it with its waits. */
export interface SaveRecord {
  restore: string;
  addTo: (graph: StepGraph, waits: DepRecord) => void;
}

/** The posts of each graph the facade added nodes to, by node name. */
const postRecords = new WeakMap<StepGraph, Map<string, PostRecord>>();
/** The saves of each graph the facade added nodes to, by node name. */
const saveRecords = new WeakMap<StepGraph, Map<string, SaveRecord>>();

/** The posts recorded beside `graph`, by node name, in the order they were added. */
export const postsOf = (graph: StepGraph): ReadonlyMap<string, PostRecord> =>
  postRecords.get(graph) ?? new Map();

/** Record `name` as a post of `graph`. */
export function recordPost(graph: StepGraph, name: string, post: PostRecord): void {
  const posts = postRecords.get(graph) ?? new Map<string, PostRecord>();
  postRecords.set(graph, posts.set(name, post));
}

/** The saves recorded beside `graph`, by node name, in the order they were added. */
export const savesOf = (graph: StepGraph): ReadonlyMap<string, SaveRecord> =>
  saveRecords.get(graph) ?? new Map();

/** Record `name` as a save of `graph`. */
export function recordSave(graph: StepGraph, name: string, save: SaveRecord): void {
  const saves = saveRecords.get(graph) ?? new Map<string, SaveRecord>();
  saveRecords.set(graph, saves.set(name, save));
}

/** Each post of the graph, by name, with its main's: `dag post` runs the ones a run still owes. */
export function postNodes(graph: StepGraph): Map<string, string> {
  return new Map([...postsOf(graph)].map(([name, post]) => [name, post.main]));
}

/* ------------------------------------------------------------------ requireAll */

/**
 * The required-check: an `action` task with a settled dep on every node in `deps`, so it runs
 * even when some fail (GitHub's `if: always()`), and fails itself if any of them did not produce
 * a result. `deps` is a record like every other node's, keyed by the role each check plays.
 * Its `outcome`, `require-all.json`, lists the roles `present` and `missing`.
 */
export function requireAll(
  graph: StepGraph,
  opts: { name?: string; deps: Record<string, NodeRef> },
): NodeRef<Record<"outcome", string>> {
  const roles = Object.keys(opts.deps).sort();
  return addTask(graph, {
    name: opts.name ?? "require-all",
    deps: Object.fromEntries(Object.entries(opts.deps).map(([role, ref]) => [role, settled(ref)])),
    inputs: { version: "require-all:v1" },
    outputs: { outcome: "require-all.json" },
    action: async ({ depOutputs, out, ports }) => {
      const present = roles.filter((role) => depOutputs[role] !== undefined);
      const missing = roles.filter((role) => depOutputs[role] === undefined);
      await ports.fs.writeText(out.outcome, JSON.stringify({ present, missing }, null, 2));
      if (missing.length > 0) throw new Error(`failed: ${missing.join(", ")}`);
    },
  });
}

/* ------------------------------------------------- actions/upload-artifact */

/**
 * An item of what an artifact's `path` function returns: a glob, a dep's output as its handle or
 * its list of handles, or `undefined`, as a `settled` dep that failed gives, which is left out.
 */
type PathItem = string | FileHandle | FileHandle[] | undefined;

/**
 * The inputs of `actions/upload-artifact`: `name`, `path`, `if-no-files-found`, and those the
 * store reads, `overwrite`, `retention-days` and `compression-level`.
 */
export interface UploadArtifactSpec<D extends DepRecord = DepRecord> extends ArtifactUploadOptions {
  /** The node's name; `artifact` is the artifact's. */
  name: string;
  /** The artifact's name on the run page: no `"`, `:`, `<`, `>`, `|`, `*`, `?`, `\\` or `/`. */
  artifact: string;
  /**
   * Globs as `workflow.glob` takes them, or a function of the deps' outputs, the handles the
   * upload's action reads when it runs, that names their files too: `deps: { pack }, path: ({ pack
   * }) => ["reports/**", pack.tarball]`. A `settled` dep that failed is `undefined`, and an
   * `undefined` item is left out: `({ tests }) => [tests?.report]`.
   */
  path:
    | readonly string[]
    | ((deps: TaskContext<D, never, Record<never, never>>["depOutputs"]) => readonly PathItem[]);
  deps?: D;
  /** What an empty `path` does: a warning and no artifact (the default), a failure, or nothing. */
  ifNoFilesFound?: "warn" | "error" | "ignore";
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
 * `actions/upload-artifact` as an `action` task. Artifacts belong to a run, so it runs every
 * time, never from the cache, and its `response`, `artifact.json`, holds the artifact's id and
 * size, or `null` when nothing went up. `path` names the files when it
 * runs: a glob is matched then, and a dep's handle is the file it produced, so `path: ({ pack })
 * => [pack.tarball]` uploads a tarball straight from the CAS. The archive is rooted at the
 * deepest directory holding every file, as the action roots it, so one node's outputs sit at the
 * top. An upload the service refuses fails the node, as the action fails its step; without a
 * service, locally or in a `run:` step, nothing is uploaded and the log says so.
 */
export function uploadArtifact<D extends DepRecord>(
  graph: StepGraph,
  spec: UploadArtifactSpec<D>,
): NodeRef<Record<"response", string>> {
  const ifNoFilesFound = spec.ifNoFilesFound ?? "warn";
  return addTask(graph, {
    name: spec.name,
    ...(spec.deps && { deps: spec.deps }),
    cacheable: false,
    outputs: { response: "artifact.json" },
    action: async ({ depOutputs, ports, out, log, warn }) => {
      const items: readonly PathItem[] =
        typeof spec.path === "function" ? spec.path(depOutputs) : spec.path;
      const patterns = items.filter((item) => typeof item === "string");
      const named = items.flatMap((item) =>
        isFileHandle(item) ? [item.path] : Array.isArray(item) ? item.map((file) => file.path) : [],
      );
      const files = [...(patterns.length ? await glob(patterns) : []), ...named];
      const done = (uploaded: { id: number; size: number } | undefined) =>
        ports.fs.writeText(out.response, JSON.stringify(uploaded ?? null, null, 2));
      if (files.length === 0) {
        const searched = patterns.length ? `: ${patterns.join(", ")}` : "";
        const line = `No files were found with the provided path${searched}. No artifacts will be uploaded.`;
        if (ifNoFilesFound === "error") throw new Error(line);
        if (ifNoFilesFound === "warn") warn(line);
        else log(line);
        return done(undefined);
      }
      const uploaded = await ports.artifactStore.upload(spec.artifact, files, commonDir(files), {
        ...(spec.overwrite !== undefined && { overwrite: spec.overwrite }),
        ...(spec.retentionDays !== undefined && { retentionDays: spec.retentionDays }),
        ...(spec.compressionLevel !== undefined && { compressionLevel: spec.compressionLevel }),
      });
      log(
        uploaded === undefined
          ? `Artifact ${spec.artifact} not uploaded: no artifact service`
          : `Artifact ${spec.artifact} has been successfully uploaded! Final size is ${uploaded.size} bytes. Artifact ID is ${uploaded.id}`,
      );
      return done(uploaded);
    },
  });
}
