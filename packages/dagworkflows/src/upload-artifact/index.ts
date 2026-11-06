import {
  isFileHandle,
  type AnyOutputRef,
  type DepRecord,
  type Graph,
  type NodeRef,
  type Resolved,
} from "@mrmeku/dagraph";
import { DEFAULT_EXCLUDES } from "../config/index.ts";
import { addTask, type TaskContext, type TaskPorts } from "../tasks/index.ts";

/** What an upload takes beside its files: the inputs of `actions/upload-artifact` the service reads. */
export interface ArtifactUploadOptions {
  /** Delete an artifact of the same name first: a re-run of a failed job shares its run's artifacts. */
  overwrite?: boolean;
  retentionDays?: number;
  compressionLevel?: number;
}

/**
 * Where `workflow.uploadArtifact` puts an artifact of the run. `upload` sends `files` as the
 * artifact `name`, each by its path from `rootDirectory`, and resolves to the artifact's id and
 * size, or undefined when there is no store to take it. It rejects a name the run has used
 * already, unless `overwrite` replaces that artifact.
 */
export interface ArtifactStore {
  upload: (
    name: string,
    files: string[],
    rootDirectory: string,
    options: ArtifactUploadOptions,
  ) => Promise<{ id: number; size: number } | undefined>;
}

/** No artifact store: every upload is a no-op. */
export const nullArtifactStore: ArtifactStore = { upload: async () => undefined };

/**
 * Matches files by `@actions/glob`'s patterns, the ones `actions/cache`, `actions/upload-artifact`
 * and `hashFiles()` use. `match` resolves to the files the patterns match, sorted and deduplicated,
 * relative to the working directory; `hash` to GitHub's `hashFiles()` of them, `""` for none.
 */
export interface FileMatcher {
  match: (patterns: string[]) => Promise<string[]>;
  hash: (patterns: string[]) => Promise<string>;
}

/** The patterns with each of `DEFAULT_EXCLUDES` negated after them, as an upload's globs and `workflow.glob` match. */
export const withDefaultExcludes = (patterns: string[]): string[] => [
  ...patterns,
  ...DEFAULT_EXCLUDES.map((dir) => `!**/${dir}/**`),
];

/** The ports an upload reads when it runs. */
export type UploadPorts = TaskPorts & { artifactStore: ArtifactStore; fileMatcher: FileMatcher };

/**
 * An item of what an artifact's `path` function returns: a glob, a dep's output as its handle or
 * its list of handles, or `undefined`, as a `settled` dep that failed gives, which is left out.
 */
type PathItem = string | Resolved<AnyOutputRef>;

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
  /**
   * What a `path` that finds no files does beside uploading nothing: a warning (the default), a
   * failure, or a plain line.
   */
  ifNoFilesFound?: "warn" | "error" | "ignore";
}

/** The deepest directory every file is under, the archive's root: `a/b/x` and `a/c/y` give `a`. */
function rootDirectoryOf(files: string[]): string {
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
 * => [pack.tarball]` uploads a tarball straight from the cache dir. The archive is rooted at the
 * deepest directory holding every file, as the action roots it, so one node's outputs sit at the
 * top. An upload the service refuses fails the node, as the action fails its step; without a
 * service, locally or in a `run:` step, nothing is uploaded and the log says so.
 */
export function addUpload<P extends UploadPorts, D extends DepRecord>(
  graph: Graph<P>,
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
      const matched = patterns.length
        ? await ports.fileMatcher.match(withDefaultExcludes(patterns))
        : [];
      const files = [...matched, ...named];
      const writeResponse = (uploaded: { id: number; size: number } | undefined) =>
        ports.fs.writeText(out.response, JSON.stringify(uploaded ?? null, null, 2));
      if (files.length === 0) {
        const searched = patterns.length ? `: ${patterns.join(", ")}` : "";
        const line = `No files were found with the provided path${searched}. No artifacts will be uploaded.`;
        if (ifNoFilesFound === "error") throw new Error(line);
        if (ifNoFilesFound === "warn") warn(line);
        else log(line);
        return writeResponse(undefined);
      }
      const uploaded = await ports.artifactStore.upload(
        spec.artifact,
        files,
        rootDirectoryOf(files),
        {
          ...(spec.overwrite !== undefined && { overwrite: spec.overwrite }),
          ...(spec.retentionDays !== undefined && { retentionDays: spec.retentionDays }),
          ...(spec.compressionLevel !== undefined && { compressionLevel: spec.compressionLevel }),
        },
      );
      log(
        uploaded === undefined
          ? `Artifact ${spec.artifact} not uploaded: no artifact service`
          : `Artifact ${spec.artifact} has been successfully uploaded! Final size is ${uploaded.size} bytes. Artifact ID is ${uploaded.id}`,
      );
      return writeResponse(uploaded);
    },
  });
}
