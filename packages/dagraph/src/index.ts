// The API reference's name for this entry point: TypeDoc names the "." export "".
/** @module index */
export {
  FsCache,
  MemCache,
  forcedCache,
  type Cache,
  type CacheEntry,
  type DagFs,
} from "./cache.ts";
export {
  actionsFor,
  defineAction,
  type Action,
  type ActionSpec,
  type NodeRefOf,
  type OutputOf,
} from "./define-action.ts";
export { execute, type ExecuteOptions } from "./execute.ts";
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
  requiredDeps,
  settled,
} from "./graph/index.ts";
export type {
  ActionContext,
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
  InvalidateOn,
  Node,
  NodeInputsSpec,
  NodeParams,
  NodeRef,
  NotAString,
  OutputRef,
  Outputs,
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
  localRunNode,
  lookupNode,
  processNode,
  runAction,
  type ExecutionContext,
  type Lookup,
  type Miss,
  type RunActionOptions,
} from "./process-node.ts";
export {
  throttledScheduler,
  unboundedScheduler,
  type ThrottledSchedulerOptions,
} from "./schedulers.ts";
export {
  isResult,
  isSucceeded,
  tally,
  type ExecEvent,
  type ExecListener,
  type FailedError,
  type JsonValue,
  type Result,
  type SucceededResult,
  type Tally,
} from "./types.ts";
