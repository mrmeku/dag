import { check, lock } from "proper-lockfile";
import type { Lockfile } from "../../lock/index.ts";

/** proper-lockfile's `lock` and `check`: every option is the caller's. */
export const lockfile: Lockfile = { lock, check };
