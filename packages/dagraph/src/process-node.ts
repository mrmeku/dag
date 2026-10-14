import type { Cache, DagFs } from "./cache.ts";
import {
  computeActionKey,
  hashBytes,
  hashInputs,
  hashOutputFiles,
  verifyOutputs,
  type InputHashMemo,
} from "./content-addressing.ts";
import { requiredDeps, type Outputs, type RunnableNode } from "./graph/index.ts";
import type { ProcessNodeResult } from "./types.ts";

/**
 * Stable execution infrastructure shared across invocations. The scheduler on
 * ExecuteOptions is separate because it varies per run while this context is long-lived.
 * `inputHashes` is an optional per-execution memo; execute() supplies one so nodes that share
 * input files hash them once.
 */
export interface ExecutionContext {
  cache: Cache;
  fs: DagFs;
  casBaseDir: string;
  inputHashes?: InputHashMemo;
}

export interface ProcessNodeOptions {
  /** Skip the cache read: run the node even when a cached result exists, then store the new one. */
  force?: boolean;
  /** Never run the node: without a verified cache entry it fails with NOT_CACHED as its error. */
  cacheOnly?: boolean;
  /**
   * Cancels the node: handed to the action, which may stop early when it fires. A node it
   * interrupts settles as `cancelled` whatever the action returns; one not yet started never starts.
   */
  signal?: AbortSignal;
  /** Called on a cache miss, just before the action runs. */
  onStart?: () => void;
}

/** Error of a node that `cacheOnly` kept from running. */
export const NOT_CACHED = "not cached";

/**
 * Where a node's action writes its outputs: a subdirectory of the key's CAS dir, so output
 * names can never collide with the cache's own `{key}/manifest.json`. Use this instead of
 * rebuilding the path from the key.
 */
export function outputDirFor(casBaseDir: string, actionKey: string): string {
  return `${casBaseDir}/${actionKey}/out`;
}

/** Replace the content hash of each normalized dep with the hash of the node's fingerprint of it. */
async function keyDepHashes(
  node: RunnableNode,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
): Promise<Map<string, string>> {
  if (!node.normalize) return depContentHashes;
  const hashes = new Map(depContentHashes);
  for (const [dep, fingerprint] of Object.entries(node.normalize)) {
    if (hashes.has(dep)) hashes.set(dep, hashBytes(await fingerprint(depOutputs[dep]!)));
  }
  return hashes;
}

/**
 * Process a single DAG node: check deps, check cache, run action, cache result.
 * Can be called independently (e.g. as a Temporal activity) or wired into execute().
 */
export async function processNode(
  node: RunnableNode,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
  ctx: ExecutionContext,
  opts?: ProcessNodeOptions,
): Promise<ProcessNodeResult> {
  const force = opts?.force ?? false;

  for (const dep of requiredDeps(node)) {
    if (!depContentHashes.has(dep)) {
      return {
        name: node.name,
        actionKey: "",
        status: "dep-failed",
        error: `dependency ${dep} failed`,
      };
    }
  }

  const inputHashes = await hashInputs(node, ctx.fs.hashFile, ctx.inputHashes);
  const depHashes = await keyDepHashes(node, depContentHashes, depOutputs);
  const actionKey = computeActionKey(node, depHashes, inputHashes);
  const casDir = outputDirFor(ctx.casBaseDir, actionKey);
  const useCache = !force && node.cacheable !== false;

  const cached = useCache ? await ctx.cache.get(actionKey) : undefined;
  if (cached && (await verifyOutputs(cached, ctx.fs.hashFile))) {
    return {
      name: node.name,
      actionKey,
      status: "cached",
      outputs: cached.outputs,
      contentHash: cached.contentHash,
    };
  }
  if (opts?.cacheOnly) {
    return { name: node.name, actionKey, status: "fail", error: NOT_CACHED, elapsed: 0 };
  }

  await ctx.fs.ensureDir(casDir);
  // Checked after the last await before the action starts: a cancel during the mkdir still holds it back.
  const cancel = opts?.signal;
  if (cancel?.aborted) return { name: node.name, actionKey: "", status: "cancelled" };
  opts?.onStart?.();
  const startTime = Date.now();
  const elapsed = () => Date.now() - startTime;
  const fail = (e: unknown): Extract<ProcessNodeResult, { status: "fail" }> => ({
    name: node.name,
    actionKey,
    status: "fail",
    error: e instanceof Error ? e.message : String(e),
    elapsed: elapsed(),
  });
  const { signal, dispose } = actionSignal(node.timeoutMs, cancel);
  let settled: { outputs: Outputs } | { error: unknown };
  try {
    settled = { outputs: await node.action(depOutputs, casDir, { signal }) };
  } catch (error) {
    settled = { error };
  } finally {
    dispose();
  }
  // As GitHub's runner does: once the signal fired, the exit status no longer decides. A cancel
  // wins over the node's own timeout; neither result is ever cached.
  if (cancel?.aborted) return { name: node.name, actionKey, status: "cancelled" };
  if (signal.aborted) return { ...fail(`timed out after ${node.timeoutMs} ms`), timedOut: true };
  if ("error" in settled) return fail(settled.error);
  try {
    const { outputs } = settled;
    const contentHash = await hashOutputFiles(outputs, ctx.fs.hashFile);
    if (node.cacheable !== false) await ctx.cache.put(actionKey, { outputs, contentHash });
    return {
      name: node.name,
      actionKey,
      status: "done",
      outputs,
      contentHash,
      elapsed: elapsed(),
    };
  } catch (e) {
    return fail(e);
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
