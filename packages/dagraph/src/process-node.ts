import { join, normalize } from "pathe";
import type { Cache, CacheEntry, DagFs } from "./cache.ts";
import {
  collectPaths,
  computeActionKey,
  hashBytes,
  hashOutputFiles,
  mapPaths,
  verifyOutputs,
  type HashFileFn,
  type KeyedDep,
  type KeyedInput,
} from "./content-addressing.ts";
import { fileHandle } from "./file-handle.ts";
import { graphNodes, type Graph, type GraphNode } from "./graph/graph.ts";
import { canonical, resolveValue } from "./graph/inputs.ts";
import { FILE_INPUT, isFileInput, requiredDeps, type Outputs } from "./graph/types.ts";
import type { ExecListener, FailedError, Result } from "./types.ts";
import { errorOf } from "./utils.ts";

/**
 * What an executor hands the engine. It outlives any one execution. `ports` are the actions'
 * tools, which the engine passes through; a graph whose actions need none takes no `ports`.
 */
export type ExecutionContext<Ports = unknown> = {
  cache: Cache;
  fs: DagFs;
  casBaseDir: string;
} & (unknown extends Ports ? { ports?: Ports } : { ports: Ports });

export interface ProcessNodeOptions<Meta> {
  /** Skip the entry read: run the node, then write its new entry. */
  force?: boolean;
  /**
   * Look the node up without running it: without a verified entry it fails with `NOT_CACHED` as
   * its error's message. With `force`, there is no lookup, so it fails so at once.
   */
  cacheOnly?: boolean;
  /** The execution's cancel. A node it stops settles `cancelled`, whatever its action returns. */
  signal?: AbortSignal;
  /**
   * The gate of the node's concurrency group, awaited on a miss before the action runs: the
   * `acquire` its `RunNode` gets, or `ungated` outside an orchestrator. It rejects only once the
   * execution is cancelled, so a rejection settles the node `cancelled`.
   */
  acquire: () => Promise<void>;
  /** Receives the node's `start` and `output`, before its result returns. */
  onEvent?: ExecListener<Meta>;
}

/**
 * The gate of a node that waits for no slot, for `processNode` outside an orchestrator: a test, a
 * script, or a worker whose orchestrator took the node's slot already.
 */
export const ungated = (): Promise<void> => Promise.resolve();

/** A listener's promise that nothing awaits: its rejection is dropped, not left unhandled. */
const ignoreRejection = (returned: unknown) => {
  if (returned instanceof Promise) returned.catch(() => {});
};

/** The message of the error of a node that `cacheOnly` found no verified entry for. */
export const NOT_CACHED = "not cached";

/** Removes an attempt's directory, best effort: whether it is gone never changes a result. */
const discard = (fs: DagFs, dir: string) => fs.remove(dir).catch(() => {});

/**
 * Move an attempt's directory to `published`, the key's directory for its content, which
 * nothing writes again, and return the outputs at their new paths. When a concurrent attempt
 * published the same content first, its copy is used and this one dropped. When that copy no
 * longer hashes to the content, the attempt's directory stays where it is and keeps the outputs.
 */
async function publish(
  fs: DagFs,
  keyDir: string,
  staging: string,
  outputs: Outputs,
  contentHash: string,
): Promise<Outputs> {
  const published = `${keyDir}/out-${contentHash}`;
  const moved = mapPaths(outputs, (path) => published + normalize(path).slice(staging.length));
  try {
    await fs.rename(staging, published);
  } catch {
    if (!(await verifyOutputs({ outputs: moved, contentHash }, fs.hashFile, keyDir)))
      return outputs;
    await discard(fs, staging);
  }
  return moved;
}

/** What the `invalidateOn` fingerprint of `role` returned, refused where it is not a string. */
function fingerprintString(role: string, value: unknown): string {
  if (typeof value === "string") return value;
  throw new Error(
    `invalidateOn.${role} returned ${value === null ? "null" : typeof value}, not a string. ` +
      "JSON.stringify returns undefined for undefined: give it the value ?? null.",
  );
}

/** The node's action key, from its kind, its inputs by name and its deps by role. */
async function actionKeyOf(
  { spec, roles, inputs }: GraphNode,
  entryOf: (dep: string) => CacheEntry | undefined,
  ports: unknown,
  hashFile: HashFileFn,
  handle: (path: string) => unknown,
): Promise<string> {
  const rolesOf = (dep: string) =>
    Object.keys(roles)
      .filter((role) => roles[role] === dep)
      .sort();
  const refKey = (ref: { node: string; output: string }) =>
    JSON.stringify([rolesOf(ref.node), ref.output]);
  const keyedInputs: Record<string, KeyedInput> = {};
  for (const [name, value] of Object.entries(inputs)) {
    keyedInputs[name] = isFileInput(value)
      ? ["file", value[FILE_INPUT], await hashFile(value[FILE_INPUT])]
      : ["value", canonical(value, refKey)];
  }
  const keyedDeps: Record<string, KeyedDep> = {};
  for (const [role, dep] of Object.entries(roles)) {
    const entry = entryOf(dep);
    const fingerprint = spec.invalidateOn?.[role];
    keyedDeps[role] = !entry
      ? ["missing"]
      : fingerprint
        ? [
            "fingerprint",
            hashBytes(
              fingerprintString(role, await fingerprint(mapPaths(entry.outputs, handle), ports)),
            ),
          ]
        : ["content", entry.contentHash];
  }
  return computeActionKey(spec.kind, keyedInputs, keyedDeps);
}

/**
 * Process the node `name` of `graph`: compute its key, read and verify its entry, and run its
 * action on a miss. `depEntries`, by dep node name, holds the entry of each dep that succeeded.
 */
export async function processNode<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  name: string,
  depEntries: Record<string, CacheEntry>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
  options: ProcessNodeOptions<Meta>,
): Promise<Result> {
  const found = graphNodes(graph).get(name);
  if (!found)
    throw new Error(
      `processNode: the graph holds no node "${name}". Pass a graph that holds it: the whole ` +
        `graph, a closure of it, or any graph that declares the node the same way. A key is ` +
        `local to its node, so each gives it the same key.`,
    );
  const { cache, fs, casBaseDir, ports }: ExecutionContext = executionContext;
  const { node, spec, roles } = found;
  const meta = node.meta === undefined ? {} : { meta: node.meta };
  const entryOf = (dep: string) => (Object.hasOwn(depEntries, dep) ? depEntries[dep] : undefined);
  const handle = (path: string) => fileHandle(fs, path);
  const missing = requiredDeps(node).find((dep) => !entryOf(dep));
  if (missing !== undefined) return { name, actionKey: "", status: "dep-failed", dep: missing };

  let actionKey: string;
  try {
    actionKey = await actionKeyOf(found, entryOf, ports, fs.hashFile, handle);
  } catch (e) {
    return { name, actionKey: "", status: "failed", error: errorOf(e), elapsed: 0 };
  }
  const keyDir = join(casBaseDir, actionKey);
  if (!options.force && node.cacheable !== false) {
    // An entry that cannot be read, the cache's own failure included, is a miss.
    const cached = await Promise.resolve()
      .then(() => cache.get(actionKey))
      .catch(() => undefined);
    if (cached && (await verifyOutputs(cached, fs.hashFile, keyDir))) {
      const { outputs, contentHash } = cached;
      return { name, actionKey, status: "cached", outputs, contentHash };
    }
  }
  const notRun = (e: unknown): Result => ({
    name,
    actionKey,
    status: "failed",
    error: errorOf(e),
    elapsed: 0,
  });
  if (options.cacheOnly) return notRun(new Error(NOT_CACHED));

  const cancel = options.signal;
  const cancelled: Result = { name, actionKey, status: "cancelled" };
  try {
    await options.acquire();
  } catch {
    return cancelled;
  }
  if (cancel?.aborted) return cancelled;
  const staging = `${keyDir}/tmp-${crypto.randomUUID()}`;
  const outputDir = fs.resolve(staging);
  const dropped = async (result: Result) => {
    await discard(fs, staging);
    return result;
  };
  try {
    await fs.ensureDir(staging);
  } catch (e) {
    return dropped(notRun(e));
  }
  // A cancel during the mkdir holds the node back before it starts.
  if (cancel?.aborted) return dropped(cancelled);
  let open = true;
  const output = (chunk: string) => {
    if (open) ignoreRejection(options.onEvent?.({ type: "output", node: name, ...meta, chunk }));
  };
  try {
    await options.onEvent?.({ type: "start", node: name, ...meta });
  } catch (e) {
    return dropped(notRun(e));
  }
  // Checked after the last await before the action starts: a cancel during the start's record
  // holds it back, though the record says it started.
  if (cancel?.aborted) return dropped(cancelled);
  const startTime = Date.now();
  const failed = (error: FailedError): Result => ({
    name,
    actionKey,
    status: "failed",
    error,
    elapsed: Date.now() - startTime,
  });
  const { signal, dispose } = actionSignal(node.timeoutMs, cancel);
  let settled: { outputs: Outputs } | { error: unknown };
  try {
    const inputs = Object.fromEntries(
      Object.entries(found.inputs).map(([k, v]) => [
        k,
        isFileInput(v) ? handle(v[FILE_INPUT]) : resolveValue(v, depEntries, handle),
      ]),
    );
    const depOutputs = Object.fromEntries(
      Object.entries(roles).flatMap(([role, dep]) => {
        const entry = entryOf(dep);
        return entry ? [[role, mapPaths(entry.outputs, handle)]] : [];
      }),
    );
    const context = { inputs, depOutputs, ports, outputDir, signal, output };
    settled = { outputs: await spec.action(context) };
  } catch (error) {
    settled = { error };
  } finally {
    dispose();
  }

  try {
    // As GitHub's runner does: once the signal fired, the exit status no longer decides. A cancel
    // wins over the node's own timeout; neither result is ever cached.
    if (cancel?.aborted) return await dropped(cancelled);
    // A timeout keeps what the action threw as it stopped: its cause says what it was running.
    const thrown = "error" in settled ? settled.error : undefined;
    if (signal.aborted) {
      const message = `timed out after ${node.timeoutMs} ms`;
      return await dropped(failed({ ...errorOf(thrown, message), name: "TimeoutError" }));
    }
    if ("error" in settled) return await dropped(failed(errorOf(thrown)));
    // A returned path, absolute or not, is stored under the staging dir as casBaseDir gives it.
    const under = `${normalize(outputDir)}/`;
    const outside = collectPaths(settled.outputs).find(
      (p) => !normalize(fs.resolve(p)).startsWith(under),
    );
    if (outside !== undefined)
      throw new Error(`output not under the output dir: ${outside} is not under ${outputDir}`);
    const returned = mapPaths(
      settled.outputs,
      (p) => `${staging}/${normalize(fs.resolve(p)).slice(under.length)}`,
    );
    const contentHash = await hashOutputFiles(returned, fs.hashFile, keyDir);
    const outputs = await publish(fs, keyDir, staging, returned, contentHash);
    if (node.cacheable !== false) await cache.put(actionKey, { outputs, contentHash });
    return {
      name,
      actionKey,
      status: "done",
      outputs,
      contentHash,
      elapsed: Date.now() - startTime,
    };
  } catch (e) {
    return await dropped(failed(errorOf(e)));
  } finally {
    // What the action prints after its result returns is dropped.
    open = false;
  }
}

/**
 * The signal an action runs under: the execution's cancel, or the node's own deadline. A timer
 * cleared by `dispose` rather than `AbortSignal.timeout`, so a long-lived worker keeps no timer
 * per finished node.
 */
function actionSignal(timeoutMs: number | undefined, cancel: AbortSignal | undefined) {
  const controller = new AbortController();
  const onCancel = () => controller.abort(cancel?.reason);
  cancel?.addEventListener("abort", onCancel, { once: true });
  if (cancel?.aborted) onCancel();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
          timeoutMs,
        );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      cancel?.removeEventListener("abort", onCancel);
    },
  };
}
