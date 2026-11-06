import type { Clock } from "@mrmeku/dagraph";
import type { LockOptions } from "proper-lockfile";
import type { Lockfile } from "../../lock/index.ts";

interface Holder {
  onCompromised: (error: Error) => void;
  /** When its holder stopped refreshing it, as a kill does; a live holder refreshes it. */
  abandonedAt?: number;
}

/** A `Lockfile` in memory, with the paths a test holds and what a kill or a lost refresh does. */
export interface MemoryLockfile extends Lockfile {
  held: Set<string>;
  /** Stops refreshing the lock on `file`, as a kill does. */
  abandon: (file: string) => void;
  /** Frees the lock on `file` and tells its holder, as a refresh that finds it taken does. */
  compromise: (file: string) => void;
}

const lockPathOf = (file: string, opts?: LockOptions) => opts?.lockfilePath ?? `${file}.lock`;
const DEFAULT_STALE_MS = 10_000;

/**
 * Locks held in memory by lock path, by proper-lockfile's rules. A held path is refreshed while
 * its holder lives, so it never goes stale on its own; `abandon` stops that, as a kill does, and
 * the lock goes stale once `stale` ms have passed on `clock`. `lock` then takes it over, calling
 * the old holder's `onCompromised`; `compromise` frees a path as a lost refresh does. Without
 * `retries` a held path rejects with `ELOCKED`; with them `lock` tries again until it is free. A path a
 * test adds to `held` is held until it removes it.
 */
export function createMemoryLockfile(clock: Pick<Clock, "epochMilliseconds">): MemoryLockfile {
  const holders = new Map<string, Holder>();
  const held = new Set<string>();
  const isStale = (path: string, opts?: LockOptions) => {
    const abandonedAt = holders.get(path)?.abandonedAt;
    return (
      abandonedAt !== undefined &&
      clock.epochMilliseconds() - abandonedAt > (opts?.stale ?? DEFAULT_STALE_MS)
    );
  };
  const free = (path: string) => {
    held.delete(path);
    holders.delete(path);
  };
  const lock: Lockfile["lock"] = async (file, opts) => {
    const path = lockPathOf(file, opts);
    while (held.has(path)) {
      if (isStale(path, opts)) {
        holders
          .get(path)
          ?.onCompromised(new Error("Unable to update lock within the stale threshold"));
        break;
      }
      if (!opts?.retries)
        throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
      // Tries again until the holder releases it or the clock makes it stale.
      await new Promise((retry) => setTimeout(retry, 1));
    }
    held.add(path);
    const holder: Holder = { onCompromised: opts?.onCompromised ?? (() => {}) };
    holders.set(path, holder);
    // As proper-lockfile's, a release of a lock its holder lost rejects with ERELEASED.
    return async () => {
      if (holders.get(path) !== holder)
        throw Object.assign(new Error("Lock is already released"), { code: "ERELEASED" });
      free(path);
    };
  };
  return {
    held,
    lock,
    check: async (file, opts) => {
      const path = lockPathOf(file, opts);
      return held.has(path) && !isStale(path, opts);
    },
    abandon: (file) => {
      const holder = holders.get(lockPathOf(file));
      if (holder) holder.abandonedAt = clock.epochMilliseconds();
    },
    compromise: (file) => {
      const path = lockPathOf(file);
      const holder = holders.get(path);
      free(path);
      holder?.onCompromised(new Error("Lock is compromised"));
    },
  };
}
