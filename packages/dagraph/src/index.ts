// The API reference's name for this entry point: TypeDoc names the "." export "".
/** @module index */
export { pruneCache, type CacheEntry, type DagFs, type PruneOptions } from "./cache.ts";
export {
  actionsFor,
  defineAction,
  type Action,
  type ActionSpec,
  type NodeRefOf,
  type OutputOf,
} from "./define-action.ts";
export {
  execute,
  runNode,
  type ExecuteOptions,
  type ExecutionEvent,
  type ExecutionListener,
} from "./execute.ts";
export {
  Graph,
  closure,
  dep,
  file,
  isFileHandle,
  maybe,
  namedOutput,
  nodeInputs,
  nodeRefNamed,
  notAString,
  pick,
  settled,
} from "./graph/index.ts";
export type {
  ActionContext,
  AnyNodeRef,
  AnyOutputRef,
  Dep,
  DepRecord,
  DepRefs,
  DepSpecs,
  DepSpecsOf,
  FileHandle,
  FileInput,
  Handles,
  InputRecord,
  InputValue,
  Node,
  NodeInputsSpec,
  NodeParams,
  NodeRef,
  NotAString,
  OutputRef,
  Outputs,
  Resolved,
  SettledDep,
  SettledOutputRef,
  SettledRef,
} from "./graph/index.ts";
export {
  orchestrate,
  type Ready,
  type RunNode,
  type Scheduler,
  type SchedulerContext,
} from "./orchestrate.ts";
export { createMemoryDagFs, type MemoryDagFs } from "./ports/memory-fs.ts";
export {
  isNodeResult,
  lookupNode,
  processNode,
  resultActionKey,
  runAction,
  type ActionEvent,
  type ActionListener,
  type CancelledNodeDetails,
  type ExecutionContext,
  type FailedNodeDetails,
  type HitDetails,
  type Lookup,
  type Miss,
  type NodeResult,
  type RunActionOptions,
  type SucceededNodeDetails,
} from "./process-node.ts";
export {
  throttledScheduler,
  unboundedScheduler,
  type ThrottledSchedulerOptions,
} from "./schedulers.ts";
export {
  countResultsByStatus,
  isResult,
  isSucceeded,
  requiredDeps,
  type Clock,
  type FailureError,
  type JsonValue,
  type OrchestrationEvent,
  type OrchestrationListener,
  type Result,
  type ScheduledNode,
  type Tally,
} from "./types.ts";
