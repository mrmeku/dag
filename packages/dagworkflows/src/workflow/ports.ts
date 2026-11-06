import type * as dagraph from "@mrmeku/dagraph";
import type { CacheStore } from "../actions-cache/index.ts";
import type { Host } from "../host/index.ts";
import type { Lockfile } from "../lock/index.ts";
import type { Clock, Exec } from "../tasks/index.ts";
import type { ArtifactStore, FileMatcher } from "../upload-artifact/index.ts";

/** dagraph's `FileSystem`, which the cache reads and writes, and whether something is at a path. */
export interface WorkflowFileSystem extends dagraph.FileSystem {
  exists: (path: string) => Promise<boolean>;
}

/** The context every task is bound to. */
export interface Ports {
  exec: Exec;
  fs: WorkflowFileSystem;
  clock: Clock;
  /** Starts a node's timeout: the run puts it in dagraph's execution context. */
  startTimer: dagraph.StartTimer;
  host: Host;
  cacheStore: CacheStore;
  artifactStore: ArtifactStore;
  lockfile: Lockfile;
  /** What `workflow.glob`, `workflow.hash` and an upload's globs match through. */
  fileMatcher: FileMatcher;
  /** The runtime's environment: `process.env` under `nodejsRuntime`. */
  env: Readonly<NodeJS.ProcessEnv>;
}

/**
 * The ports a workflow and its tasks read, `workflow.ports` and an action's `ports`: every port
 * but `exec`. A command runs only inside a node, through its shell (`run` and `runShell`, or a
 * `cmd` or `shell` task), where its log, timeout and cancel apply.
 */
export type WorkflowPorts = Omit<Ports, "exec">;
