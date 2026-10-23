import type { DepRecord, Graph } from "@mrmeku/dagraph";
import {
  addCommand,
  type CmdWork,
  type CommandFields,
  type OwnRoles,
  type ShellWork,
  type Work,
} from "./commands.ts";
import type { Ports } from "./ports.ts";
import {
  mainNode,
  postRef,
  recordPost,
  type Main,
  type MainDep,
  type PostRef,
  type WaitRoles,
} from "./steps.ts";
import { addTask, type OutputsField, type TaskFields } from "./task.ts";

/** What every post takes beside its work. */
interface PostFields<
  G extends string,
  D extends DepRecord,
  O extends string,
  M extends Main,
> extends Pick<TaskFields<G, D, O>, "name" | "outputs" | "concurrencyGroup" | "timeoutMs"> {
  /**
   * The node it runs after: `main: db` once `db` succeeded, `main: settled(db)` whatever came of
   * it, or another post. Its work reads the main's outputs as `main`, possibly `undefined` under
   * `settled`, so a command reads them through `env`.
   */
  main: M;
  /** Ordinary deps, required unless `settled`: `deps: { install }` runs it only after an install. */
  deps?: D & { main?: never } & WaitRoles;
}

interface ActionPostFields<
  G extends string,
  D extends DepRecord,
  O extends string,
  M extends Main,
> extends PostFields<G, D, O, M> {
  action: TaskFields<G, D & MainDep<M>, O>["action"];
  cmd?: never;
  shell?: never;
}

interface CommandPostFields<G extends string, D extends DepRecord, O extends string, M extends Main>
  extends PostFields<G, D, O, M>, Pick<CommandFields<G, D & MainDep<M>, O>, "cwd" | "env"> {
  deps?: D & OwnRoles & { main?: never } & WaitRoles;
  action?: never;
}

/**
 * What `workflow.post` takes: a task, in any of its three forms, that runs after its `main`, as a
 * GitHub action's `post:` runs after its `main:`, and is still owed after a cancel.
 *
 * - It waits for its main and for every node of the run downstream of the main, whatever they
 *   did, so it never lists them: `down:db` runs after each node that uses `db`, and after their
 *   posts. It never waits for the other posts of its main, and runs after the posts of a main
 *   downstream of its own, as GitHub runs posts in the reverse order of their mains; posts of
 *   unrelated mains that would wait for each other are refused.
 * - It is never cached, so it takes no `inputs`, `cacheable` or `invalidateOn`; its work must be
 *   safe to do twice, as `docker rm -f` is.
 * - Under `main: settled(db)`, the main's outputs may be missing: read them in `env`,
 *   `env: ({ main }) => ({ ID: main.id })`, then `if [ -f "$ID" ]; then docker rm -f "$(cat "$ID")"; fi`.
 * - What it returns is a post's handle, which only another post's `main` takes.
 */
export type PostSpec<G extends string, D extends DepRecord, O extends string, M extends Main> =
  | (ActionPostFields<G, D, O, M> & OutputsField<O>)
  | (CommandPostFields<G, D, O, M> & OutputsField<O> & CmdWork<D & MainDep<M>, O>)
  | (CommandPostFields<G, D, O, M> & OutputsField<O> & ShellWork);

export function post<D extends DepRecord, O extends string = never, M extends Main = Main>(
  graph: Graph<Ports>,
  spec: PostSpec<string, D, O, M>,
): PostRef<Record<O, string>> {
  const where = `post "${spec.name}"`;
  const main = mainNode(spec.main);
  const add = (target: Graph<Ports>, deps: DepRecord) => {
    if (spec.action !== undefined) {
      const { main: _main, deps: _deps, ...task }: ActionPostFields<string, D, O, M> = spec;
      return addTask<D & MainDep<M>, O>(target, { ...task, cacheable: false }, where, deps);
    }
    const fields: CommandPostFields<string, D, O, M> & Work<D & MainDep<M>, O> = spec;
    const { main: _main, deps: _deps, ...command } = fields;
    return addCommand<D & MainDep<M>, O>(
      target,
      { ...command, cacheable: false },
      where,
      deps,
      "post",
    );
  };
  const deps = { main, ...spec.deps };
  const ref = add(graph, deps);
  const work = spec.action !== undefined ? "action" : spec.shell !== undefined ? "shell" : "cmd";
  recordPost(graph, ref.name, { main: main.name, deps, work, addTo: add });
  return postRef(ref);
}
