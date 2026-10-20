import { join, normalize } from "pathe";
import type { Cache, CacheEntry, DagFs } from "./cache.ts";
import {
  collectPaths,
  computeActionKey,
  hashBytes,
  hashInput,
  hashOutputFiles,
  verifyOutputs,
  type InputHashMemo,
  type KeyedDep,
  type KeyedInput,
} from "./content-addressing.ts";
import { graphNodes, type Graph, type GraphNode } from "./graph/graph.ts";
import { canonical, resolveValue } from "./graph/inputs.ts";
import { FILE_INPUT, isFileInput, requiredDeps, type Outputs } from "./graph/types.ts";
import type { ExecEvent, Result } from "./types.ts";
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
   * The gate of the node's concurrency group, awaited on a miss before the action runs. It
   * rejects only once the execution is cancelled, so a rejection settles the node `cancelled`.
   */
  acquire?: () => Promise<void>;
  /** Receives the node's `start` and `output`, before its result returns. */
  onEvent?: (event: ExecEvent<Meta>) => void;
}

/** The message of the error of a node that `cacheOnly` found no verified entry for. */
export const NOT_CACHED = "not cached";

/**
 * The input hash memo of each execution, by the execution context `execute` makes for it, so
 * the nodes of one execution that declare one file hash it once.
 */
export const inputHashMemos = new WeakMap<object, InputHashMemo>();

/** The same outputs with each path passed through `f`. */
function mapPaths(outputs: Outputs, f: (path: string) => string): Outputs {
  if (typeof outputs === "string") return f(outputs);
  if (Array.isArray(outputs)) return outputs.map(f);
  return Object.fromEntries(
    Object.entries(outputs).map(([role, v]) => [role, Array.isArray(v) ? v.map(f) : f(v)]),
  );
}

/** Removes an attempt's directory, best effort: whether it is gone never changes a result. */
const discard = (fs: DagFs, dir: string) => fs.remove(dir).catch(() => {});

/**
 * Move an attempt's directory to `published`, the key's directory for its content, which
 * nothing writes again, and return the outputs at their new paths and the directory that holds
 * them. When a concurrent attempt published the same content first, its copy is used and this
 * one dropped. When that copy no longer hashes to the content, the attempt's directory stays
 * where it is and keeps the outputs.
 */
async function publish(
  fs: DagFs,
  keyDir: string,
  staging: string,
  outputs: Outputs,
  contentHash: string,
): Promise<{ outputs: Outputs; dir: string }> {
  const published = `${keyDir}/out-${contentHash}`;
  const moved = mapPaths(outputs, (path) => published + normalize(path).slice(staging.length));
  try {
    await fs.rename(staging, published);
  } catch {
    if (!(await verifyOutputs({ outputs: moved, contentHash }, fs.hashFile, keyDir)))
      return { outputs, dir: staging };
    await discard(fs, staging);
  }
  return { outputs: moved, dir: published };
}

type Fingerprint = (outputs: Outputs, ports: unknown) => Promise<string> | string;

/** The node's action key, from its inputs by name and its deps by role. */
async function actionKeyOf(
  { spec, roles, inputs }: GraphNode,
  entryOf: (dep: string) => CacheEntry | undefined,
  ports: unknown,
  hashFile: (path: string) => Promise<string>,
  memo: InputHashMemo,
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
      ? ["file", value[FILE_INPUT], await hashInput(value[FILE_INPUT], hashFile, memo)]
      : ["value", canonical(value, refKey)];
  }
  const keyedDeps: Record<string, KeyedDep> = {};
  for (const [role, dep] of Object.entries(roles)) {
    const entry = entryOf(dep);
    const fingerprint = (spec.invalidateOn as Record<string, Fingerprint> | undefined)?.[role];
    keyedDeps[role] = !entry
      ? ["missing"]
      : fingerprint
        ? ["fingerprint", hashBytes(await fingerprint(entry.outputs, ports))]
        : ["content", entry.contentHash];
  }
  return computeActionKey(keyedInputs, keyedDeps);
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
  options: ProcessNodeOptions<Meta> = {},
): Promise<Result> {
  const found = graphNodes(graph).get(name);
  if (!found)
    throw new Error(
      `processNode: the graph holds no node "${name}". Pass a graph that holds it: the whole ` +
        `graph, a closure of it, or any graph that declares the node the same way. A key is ` +
        `local to its node, so each gives it the same key.`,
    );
  const { cache, fs, casBaseDir, ports } = executionContext as ExecutionContext;
  const { node, spec, roles } = found;
  const meta = node.meta === undefined ? {} : { meta: node.meta as Meta };
  const entryOf = (dep: string) => (Object.hasOwn(depEntries, dep) ? depEntries[dep] : undefined);
  const missing = requiredDeps(node).find((dep) => !entryOf(dep));
  if (missing !== undefined) return { name, actionKey: "", status: "dep-failed", dep: missing };

  let actionKey: string;
  try {
    const memo = inputHashMemos.get(executionContext) ?? new Map();
    actionKey = await actionKeyOf(found, entryOf, ports, fs.hashFile, memo);
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
    await options.acquire?.();
  } catch {
    return cancelled;
  }
  if (cancel?.aborted) return cancelled;
  const staging = `${keyDir}/tmp-${crypto.randomUUID()}`;
  const dropped = async (result: Result) => {
    await discard(fs, staging);
    return result;
  };
  let earlier: string[];
  try {
    await fs.ensureDir(staging);
    // The key's published directories before this attempt: once it publishes, they go. An
    // attempt that runs beside this one publishes later, so this one never removes its files.
    earlier = (await fs.readdir(keyDir)).filter((dir) => /^out(-|$)/.test(dir));
  } catch (e) {
    return dropped(notRun(e));
  }
  // Checked after the last await before the action starts: a cancel during the mkdir holds it back.
  if (cancel?.aborted) return dropped(cancelled);

  let open = true;
  const output = (chunk: string) => {
    if (open) options.onEvent?.({ type: "output", node: name, ...meta, chunk });
  };
  options.onEvent?.({ type: "start", node: name, ...meta });
  const startTime = Date.now();
  const failed = (error: { name: string; message: string; cause?: unknown }): Result => ({
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
        isFileInput(v) ? v[FILE_INPUT] : resolveValue(v, depEntries),
      ]),
    );
    const depOutputs = Object.fromEntries(
      Object.entries(roles).flatMap(([role, dep]) => {
        const entry = entryOf(dep);
        return entry ? [[role, entry.outputs]] : [];
      }),
    );
    const context = { inputs, depOutputs, ports, outputDir: staging, signal, output };
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
    const returned = settled.outputs;
    const outside = collectPaths(returned).find((p) => !normalize(p).startsWith(`${staging}/`));
    if (outside !== undefined)
      throw new Error(`output not under the output dir: ${outside} is not under ${staging}`);
    const contentHash = await hashOutputFiles(returned, fs.hashFile, keyDir);
    const { outputs, dir } = await publish(fs, keyDir, staging, returned, contentHash);
    if (node.cacheable !== false) await cache.put(actionKey, { outputs, contentHash });
    for (const old of earlier)
      if (`${keyDir}/${old}` !== dir) await discard(fs, `${keyDir}/${old}`);
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
  const onCancel = () => controller.abort(cancel!.reason);
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
