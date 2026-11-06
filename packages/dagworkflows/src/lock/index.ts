import type * as properLockfile from "proper-lockfile";
import { LOCK_STALE_MS } from "../config/index.ts";

/** proper-lockfile's `lock` and `check`: a lock says its holder still runs. */
export type Lockfile = Pick<typeof properLockfile, "lock" | "check">;

/**
 * The options every lock in the package is taken and checked with: the lock beside the path, a
 * staleness after which a killed holder's lock is free, and a lost lock as a process warning, its
 * holder going on.
 */
export const lockOptions = (path: string) => ({
  lockfilePath: `${path}.lock`,
  realpath: false,
  stale: LOCK_STALE_MS,
  onCompromised: (e: Error) => process.emitWarning(`the lock on ${path} was lost: ${e.message}`),
});
