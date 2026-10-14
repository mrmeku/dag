import type { Graph } from "./graph.ts";
import type { ActionFunc, BaseParams, InputsFor, NodeRef, Normalizers, Outputs } from "./types.ts";

/** Map raw executor outputs (keyed by node name) to typed InputsFor<P> (keyed by dep role). */
function resolveInputs<P>(params: BaseParams, rawInputs: Record<string, Outputs>): InputsFor<P> {
  return Object.fromEntries(
    Object.entries(params.deps || [])
      .map(([role, ref]) => [role, ref && rawInputs[ref.name]])
      .filter((entry): entry is [string, Outputs] => entry[1] != null),
  ) as InputsFor<P>;
}

/** Re-key role-based normalizers by dep node name, as the executor sees deps. */
function normalizeByDepName(
  params: BaseParams,
  normalize: Record<string, ((outputs: never) => Promise<string> | string) | undefined>,
): Record<string, (outputs: Outputs) => Promise<string>> {
  return Object.fromEntries(
    Object.entries(normalize).flatMap(([role, fingerprint]) => {
      const ref = params.deps?.[role];
      if (!ref || !fingerprint) return [];
      return [[ref.name, async (outputs: Outputs) => fingerprint(outputs as never)]];
    }),
  );
}

/**
 * Wire a typed action into a graph. Wraps the user's ActionFunc to resolve typed dep inputs
 * from raw executor-level outputs, then registers the resulting RunnableNode.
 */
export function addNode<P extends BaseParams, R extends Outputs>({
  action,
  cacheable,
  concurrencyGroup,
  config,
  graph,
  name,
  normalize,
  params,
  timeoutMs,
}: {
  graph: Graph;
  name: string;
  config: string;
  concurrencyGroup?: string;
  cacheable?: boolean;
  timeoutMs?: number;
  params: P;
  action: ActionFunc<P, R>;
  normalize?: Normalizers<P>;
}): NodeRef<R> {
  const refs = Object.values(params.deps ?? {}).filter((r) => r != null);
  const optionalDeps = refs.filter((r) => r.optional).map((r) => r.name);
  const registeredName = graph.add({
    name,
    kind: params.kind,
    deps: refs.map((r) => r.name),
    ...(optionalDeps.length > 0 && { optionalDeps }),
    config,
    ...(concurrencyGroup && { concurrencyGroup }),
    ...(cacheable === false && { cacheable }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(params.inputs && params.inputs.length > 0 && { inputs: params.inputs }),
    params,
    action: (rawInputs, outputDir, ctx) =>
      action(params, resolveInputs<P>(params, rawInputs), outputDir, ctx),
    ...(normalize && { normalize: normalizeByDepName(params, normalize) }),
  });
  return { name: registeredName };
}
