import {
  commitEntry,
  discard,
  isCacheEntry,
  lookupEntry,
  newStagingDir,
  type CacheEntry,
  type FileSystem,
} from "../cache/index.ts";
import {
  FILE_INPUT,
  computeActionKey,
  graphNodes,
  isFileInput,
  isOutputs,
  mapPaths,
  type ErasedContext,
  type Graph,
  type GraphNode,
  type Node,
  type Outputs,
} from "../graph/index.ts";
import {
  failureErrorOf,
  isResult,
  requiredDeps,
  type Clock,
  type FailureError,
  type Result,
  type RunNode,
} from "../orchestration/index.ts";
import { fileHandle, resolveValue } from "./handles.ts";
import type { ActionListener, StartTimer } from "./ports.ts";

/**
 * What an executor hands the engine. It outlives any one execution. `ports` are the actions'
 * tools, which the engine passes through; a graph whose actions need none takes no `ports`.
 */
export type ExecutionContext<Ports = unknown> = {
  fs: FileSystem;
  /** The cache's directory, relative or absolute; results name its files by absolute path. */
  cacheDir: string;
  clock: Clock;
  /** Starts the timer of each node's `timeoutMs`. */
  startTimer: StartTimer;
  /** Action keys whose lookups miss, or `"all"`: their nodes run again and write new entries. */
  forcedKeys?: ReadonlySet<string> | "all";
} & (unknown extends Ports ? { ports?: Ports } : { ports: Ports });

/** What a hit carries: the node's key and the entry its lookup found. */
export type HitDetails = { actionKey: string; entry: CacheEntry; actionRan: false };

/**
 * What a node that succeeded made: a hit, or the entry its action committed and how long the
 * action ran. `entry` is the `CacheEntry` as the cache returned it.
 */
export type SucceededNodeDetails =
  | HitDetails
  | { actionKey: string; entry: CacheEntry; actionRan: true; elapsed: number };

/**
 * What a failure reports: its key and, once the action ran, how long. `timedOut`, with
 * `error.name` "TimeoutError", after the node's own timeout. A node whose key could not be
 * computed fails with no details.
 */
export type FailedNodeDetails =
  | { actionKey: string }
  | { actionKey: string; elapsed: number; timedOut?: true };

/** What a cancel reports: its key and, once the action ran, how long. */
export type CancelledNodeDetails = { actionKey: string; elapsed?: number };

/** How a node that lookup-or-run processed settled. */
export type NodeResult = Result<SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails>;

const hasElapsedIfAny = (value: object) =>
  !("elapsed" in value) || typeof value.elapsed === "number";

const isSucceededNodeDetails = (value: unknown): value is SucceededNodeDetails =>
  typeof value === "object" &&
  value !== null &&
  "actionKey" in value &&
  typeof value.actionKey === "string" &&
  "entry" in value &&
  isCacheEntry(value.entry) &&
  "actionRan" in value &&
  (value.actionRan === false ||
    (value.actionRan === true && "elapsed" in value && typeof value.elapsed === "number"));

const isFailedNodeDetails = (value: unknown): value is FailedNodeDetails =>
  typeof value === "object" &&
  value !== null &&
  "actionKey" in value &&
  typeof value.actionKey === "string" &&
  hasElapsedIfAny(value) &&
  (!("timedOut" in value) || (value.timedOut === true && "elapsed" in value));

const isCancelledNodeDetails = (value: unknown): value is CancelledNodeDetails =>
  typeof value === "object" &&
  value !== null &&
  "actionKey" in value &&
  typeof value.actionKey === "string" &&
  hasElapsedIfAny(value);

/** Whether `value` is a `NodeResult` in its current shape: the guard for one read back. */
export const isNodeResult = (value: unknown): value is NodeResult =>
  isResult(value, isSucceededNodeDetails, isFailedNodeDetails, isCancelledNodeDetails);

/** The action key a result carries, on any status; `undefined` when the node never got one. */
export function resultActionKey(result: NodeResult): string | undefined {
  switch (result.status) {
    case "succeeded":
      return result.details.actionKey;
    case "failed":
    case "cancelled":
      return result.details?.actionKey;
    case "dep-failed":
      return undefined;
  }
}

export interface RunActionOptions<Meta> {
  /** The execution's cancel. A node it stops settles `cancelled`, whatever its action returns. */
  signal?: AbortSignal;
  /** Receives the node's `start` and `output`, before its result returns. */
  onEvent?: ActionListener<Meta>;
}

/** A node whose key has no verified entry: what `runAction` runs. */
export type Miss = { name: string; actionKey: string; status: "missed" };

/** How a node's lookup ended: a hit, settled without running, or a miss to run. */
export type Lookup =
  | Exclude<Result<HitDetails, FailedNodeDetails, CancelledNodeDetails>, { status: "cancelled" }>
  | Miss;

/** A listener's promise that nothing awaits: its rejection is dropped, not left unhandled. */
const ignoreRejection = (returned: void | Promise<void>) => {
  if (returned instanceof Promise) returned.catch(() => {});
};

/** The node `name` of `graph`, refused when the graph holds none. */
function nodeNamed<Ports, Meta>(graph: Graph<Ports, Meta>, name: string): GraphNode<Meta> {
  const found = graphNodes(graph).get(name);
  if (!found)
    throw new Error(
      `the graph holds no node "${name}". Pass a graph that holds it: the whole graph, a ` +
        `closure of it, or any graph that declares the node the same way. A key is local to ` +
        `its node, so each gives it the same key.`,
    );
  return found;
}

/**
 * Look the node `name` of `graph` up: compute its key, then read and verify its entry. It settles
 * `succeeded` on a hit, `dep-failed` or `failed` without running, or is a miss. `depEntries`, by dep node
 * name, holds the entry of each dep that succeeded.
 */
export async function lookupNode<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  name: string,
  depEntries: Record<string, CacheEntry>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
): Promise<Lookup> {
  const found = nodeNamed(graph, name);
  const { fs, cacheDir, clock, forcedKeys }: ExecutionContext = executionContext;
  const { node } = found;
  const entryOf = (dep: string) => (Object.hasOwn(depEntries, dep) ? depEntries[dep] : undefined);
  const missing = requiredDeps(node).find((dep) => !entryOf(dep));
  if (missing !== undefined) return { name, status: "dep-failed", dep: missing };

  const depOutputHashes = Object.fromEntries(
    Object.entries(depEntries).map(([dep, entry]) => [dep, entry.outputHashes]),
  );
  let actionKey: string;
  try {
    actionKey = await computeActionKey(found, depOutputHashes, fs.hashFile);
  } catch (e) {
    return { name, status: "failed", error: failureErrorOf(e) };
  }
  if (node.cacheable !== false && forcedKeys !== "all" && !forcedKeys?.has(actionKey)) {
    const entry = await lookupEntry(fs, cacheDir, actionKey, clock.epochMilliseconds());
    if (entry)
      return { name, status: "succeeded", details: { actionKey, entry, actionRan: false } };
  }
  return { name, actionKey, status: "missed" };
}

/**
 * Run the action of a node that missed, store what it made, and write its entry. `depEntries` are
 * the ones its lookup was given.
 */
export async function runAction<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  { name, actionKey }: Miss,
  depEntries: Record<string, CacheEntry>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
  options: RunActionOptions<Meta> = {},
): Promise<NodeResult> {
  const found = nodeNamed(graph, name);
  const { fs, cacheDir, ports, clock, startTimer }: ExecutionContext = executionContext;
  const { node, spec, roles } = found;
  const meta = node.meta === undefined ? {} : { meta: node.meta };
  const entryOf = (dep: string) => (Object.hasOwn(depEntries, dep) ? depEntries[dep] : undefined);
  const handle = (path: string) => fileHandle(fs, path);
  const notRun = (e: unknown): NodeResult => ({
    name,
    status: "failed",
    error: failureErrorOf(e),
    details: { actionKey },
  });

  const cancel = options.signal;
  const cancelled: NodeResult = { name, status: "cancelled", details: { actionKey } };
  if (cancel?.aborted) return cancelled;
  const outputDir = newStagingDir(fs, cacheDir);
  const dropped = async (result: NodeResult) => {
    await discard(fs, outputDir);
    return result;
  };
  try {
    await fs.ensureDir(outputDir);
  } catch (e) {
    return dropped(notRun(e));
  }
  // A cancel during the mkdir holds the node back before it starts.
  if (cancel?.aborted) return dropped(cancelled);
  let open = true;
  const output = (chunk: string) => {
    if (open)
      ignoreRejection(
        options.onEvent?.({
          type: "output",
          node: name,
          ...meta,
          chunk,
          occurredAt: clock.epochMilliseconds(),
        }),
      );
  };
  try {
    await options.onEvent?.({
      type: "start",
      node: name,
      ...meta,
      occurredAt: clock.epochMilliseconds(),
    });
  } catch (e) {
    return dropped(notRun(e));
  }
  // Checked after the last await before the action starts: a cancel during the start's record
  // holds it back, though the record says it started.
  if (cancel?.aborted) return dropped(cancelled);
  let inputs: ErasedContext["inputs"];
  let depOutputs: ErasedContext["depOutputs"];
  try {
    inputs = Object.fromEntries(
      Object.entries(found.inputs).map(([k, v]) => [
        k,
        isFileInput(v) ? handle(v[FILE_INPUT]) : resolveValue(v, depEntries, handle),
      ]),
    );
    depOutputs = Object.fromEntries(
      Object.entries(roles).flatMap(([role, dep]) => {
        const entry = entryOf(dep);
        if (!entry) return [];
        // A role that picks its outputs reads those alone: its key covers no other.
        const picked = spec.pickedOutputs[role];
        const read = picked
          ? Object.fromEntries(Object.entries(entry.outputs).filter(([o]) => picked.includes(o)))
          : entry.outputs;
        return [[role, mapPaths(read, handle)]];
      }),
    );
  } catch (e) {
    return dropped(notRun(e));
  }
  const { signal, dispose } = actionSignal(node.timeoutMs, cancel, startTimer);
  const startTime = clock.epochMilliseconds();
  const elapsed = () => clock.epochMilliseconds() - startTime;
  const failed = (error: FailureError, timedOut?: true): NodeResult => ({
    name,
    status: "failed",
    error,
    details: { actionKey, elapsed: elapsed(), ...(timedOut && { timedOut }) },
  });
  let settled: { outputs: Outputs } | { error: unknown };
  try {
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
    if (cancel?.aborted)
      return await dropped({
        name,
        status: "cancelled",
        details: { actionKey, elapsed: elapsed() },
      });
    // A timeout keeps what the action threw as it stopped: its cause says what it was running.
    const thrown = "error" in settled ? settled.error : undefined;
    if (signal.aborted) {
      const message = `timed out after ${node.timeoutMs} ms`;
      const error = { ...failureErrorOf(thrown, message), name: "TimeoutError" };
      return await dropped(failed(error, true));
    }
    if ("error" in settled) return await dropped(failed(failureErrorOf(thrown)));
    if (!isOutputs(settled.outputs))
      throw new Error(
        `the action returned ${JSON.stringify(settled.outputs)}, not a record of outputs: ` +
          "return { <name>: path }",
      );
    const writeManifest = node.cacheable !== false;
    const { outputs } = settled;
    const entry = await commitEntry(
      fs,
      cacheDir,
      actionKey,
      outputDir,
      outputs,
      writeManifest,
      clock.epochMilliseconds(),
    );
    return {
      name,
      status: "succeeded",
      details: { actionKey, entry, actionRan: true, elapsed: elapsed() },
    };
  } catch (e) {
    return await dropped(failed(failureErrorOf(e)));
  } finally {
    // What the action prints after its result returns is dropped.
    open = false;
  }
}

/**
 * Look the node `name` of `graph` up now, and run its action on a miss. For a test, a script, or a
 * worker.
 */
export async function lookupOrRunNode<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  name: string,
  depEntries: Record<string, CacheEntry>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
  options: RunActionOptions<Meta> = {},
): Promise<NodeResult> {
  const found = await lookupNode(graph, name, depEntries, executionContext);
  if (found.status !== "missed") return found;
  return runAction(graph, found, depEntries, executionContext, options);
}

/**
 * The `RunNode` that `execute` uses: each node of `graph` looked up and run in this process, its
 * lookup first, given its deps' entries, and, on a miss, its action once the scheduler lets it
 * run. A cancel while it waits settles it `cancelled`.
 */
export function runNode<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
  options: RunActionOptions<Meta> = {},
): RunNode<Node<Meta>, SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails> {
  return async (node, depDetails, waitForScheduler) => {
    const depEntries = Object.fromEntries(
      Object.entries(depDetails).map(([dep, details]) => [dep, details.entry]),
    );
    const found = await lookupNode(graph, node.name, depEntries, executionContext);
    if (found.status !== "missed") return found;
    try {
      await waitForScheduler();
    } catch {
      return { name: found.name, status: "cancelled", details: { actionKey: found.actionKey } };
    }
    return runAction(graph, found, depEntries, executionContext, options);
  };
}

/**
 * The signal an action runs under: the execution's cancel, or the node's own deadline, started by
 * `startTimer` and stopped by `dispose`, so a long-lived worker keeps no timer per finished node.
 */
function actionSignal(
  timeoutMs: number | undefined,
  cancel: AbortSignal | undefined,
  startTimer: StartTimer,
) {
  const controller = new AbortController();
  const onCancel = () => controller.abort(cancel?.reason);
  cancel?.addEventListener("abort", onCancel, { once: true });
  if (cancel?.aborted) onCancel();
  const stopTimer =
    timeoutMs === undefined
      ? undefined
      : startTimer(timeoutMs, () =>
          controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
        );
  return {
    signal: controller.signal,
    dispose: () => {
      stopTimer?.();
      cancel?.removeEventListener("abort", onCancel);
    },
  };
}
