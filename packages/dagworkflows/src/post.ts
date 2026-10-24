import {
  settled,
  type DepRecord,
  type Graph,
  type NodeRef,
  type SettledRef,
} from "@mrmeku/dagraph";
import { addCommand, type CmdWork, type CommandFields, type ShellWork } from "./commands.ts";
import { POST_RETRY_DELAYS_MS } from "./config.ts";
import type { Ports } from "./ports.ts";
import { recordPost } from "./steps.ts";
import { addTask, depRoles, type TaskFields } from "./task.ts";

/** The dep a post gets: its task, by role `main`, settled, as the post runs whatever it did. */
type MainDep<O extends string> = { main: SettledRef<Record<O, string>> };

/** What every post takes beside its work. */
interface PostFields extends Pick<TaskFields<never, Record<never, never>, never>, "timeoutMs"> {
  /** Its address in logs, check runs and the history, unique in the graph: `down:db`. */
  name: string;
  /**
   * `backoff`, the default: a failed try runs again after each of `POST_RETRY_DELAYS_MS`. `once`:
   * one try, for a slow release that a retry never helps, as `terraform destroy`.
   */
  retry?: "backoff" | "once";
}

type PostCommandFields<O extends string> = Pick<
  CommandFields<never, MainDep<O>, never>,
  "cwd" | "env"
> & { action?: never };

/**
 * What a task's `post` takes: its release, as a GitHub action's `post:` releases what its `main:`
 * set up. Its work is an `action`, a `cmd` or a `shell`, as a task's.
 *
 * - It is owed once its task started, and runs after the task, whatever the task did, and after
 *   every node of the run that depends on the task. After a cancel it still runs; a run that stops
 *   before it leaves it to the next run of the workflow, which runs it before any task.
 * - It reads its task's outputs as `main`, which a task that failed or was stopped may not have
 *   written: read them in `env`, where a missing one is unset, `env: ({ main }) => ({ ID: main.id
 *   })`, then `if [ -n "${ID:-}" ]; then docker rm -f "$(cat "$ID")"; fi`.
 * - It takes no deps: what it needs, its task depends on, so whenever it is owed it can run.
 * - A failed try runs again (`retry`). When every try failed, it stays owed, the run fails, and
 *   the next run runs it before any task. Its work must be safe to do twice, as `docker rm -f` is.
 */
export type PostSpec<O extends string = string> = PostFields &
  (
    | {
        action: TaskFields<never, MainDep<O>, never>["action"];
        cmd?: never;
        shell?: never;
        cwd?: never;
        env?: never;
      }
    | (PostCommandFields<O> & CmdWork<MainDep<O>, never>)
    | (PostCommandFields<O> & ShellWork)
  );

/**
 * A task's `post`, or none. A task with a `post` is never cached, so it takes no `inputs` or
 * `cacheable`: a cache hit starts nothing, and would leave nothing to release.
 */
export type PostField<O extends string> =
  | { post?: never }
  | { post: PostSpec<O>; inputs?: never; cacheable?: never };

/**
 * Adds `spec`, the post of `main`, to `graph`, and records it for the run to add with its waits.
 * Beside its settled main, it requires each dep `main` requires, by the role `main.<role>`: when
 * one did not succeed, the main never started, so the post is skipped too.
 */
export function addPost<O extends string>(
  graph: Graph<Ports>,
  main: NodeRef<Record<O, string>>,
  spec: PostSpec<O>,
  mainDeps: DepRecord | undefined,
): void {
  const where = `post "${spec.name}" of task "${main.name}"`;
  const retryDelaysMs = spec.retry === "once" ? [] : POST_RETRY_DELAYS_MS;
  const add = (target: Graph<Ports>, deps: DepRecord) => {
    if (spec.action !== undefined) {
      const { retry: _retry, ...task } = spec;
      addTask<MainDep<O>>(target, { ...task, cacheable: false, retryDelaysMs }, where, deps);
    } else {
      const { retry: _retry, ...command } = spec;
      addCommand<MainDep<O>>(
        target,
        { ...command, cacheable: false, retryDelaysMs },
        where,
        deps,
        "post",
      );
    }
  };
  const required = depRoles(mainDeps).filter(([, dep]) => !("settled" in dep && dep.settled));
  const deps = { main: settled(main) };
  const mainRequires = Object.fromEntries(required.map(([role, dep]) => [`main.${role}`, dep]));
  add(graph, { ...deps, ...mainRequires });
  recordPost(graph, spec.name, { main: main.name, deps, mainRequires, addTo: add });
}
