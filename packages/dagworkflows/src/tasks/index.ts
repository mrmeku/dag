import type { DepRecord, Graph, InputRecord, NodeRef } from "@mrmeku/dagraph";
import { addCommand, type CmdTaskSpec, type ShellTaskSpec } from "./commands.ts";
import type { TaskPorts } from "./ports.ts";
import { addPost, type PostField } from "./post.ts";
import { addActionTask, type ActionTaskSpec } from "./task.ts";

export type { CmdTaskSpec, ShellTaskSpec } from "./commands.ts";
export type { Clock, CommandCause, Exec, ExecOptions, ExecResult, TaskPorts } from "./ports.ts";
export {
  postsOf,
  recordPost,
  waitRole,
  type PostField,
  type PostRecord,
  type PostSpec,
} from "./post.ts";
export { depRoles, type ActionTaskSpec, type TaskContext } from "./task.ts";

/**
 * What `addTask` takes: a node whose work is exactly one of `action`, a TypeScript function
 * (`ActionTaskSpec`); `cmd`, an argv run with no shell (`CmdTaskSpec`); or `shell`, a string
 * run under bash (`ShellTaskSpec`). Giving two does not compile. A task that sets something up
 * that must be undone, as a database container, gives its release as `post` (`PostSpec`), and is
 * then never cached.
 */
export type TaskSpec<
  G extends string,
  D extends DepRecord,
  O extends string,
  I extends InputRecord = Record<never, never>,
  P extends TaskPorts = TaskPorts,
> = (ActionTaskSpec<G, D, O, I, P> | CmdTaskSpec<G, D, O> | ShellTaskSpec<G, D, O>) &
  PostField<O, P>;

/** Adds a task to `graph`, and its `post` when it gives one: see `TaskSpec`. */
export function addTask<
  P extends TaskPorts,
  D extends DepRecord = Record<never, never>,
  O extends string = never,
  I extends InputRecord = Record<never, never>,
>(graph: Graph<P>, spec: TaskSpec<string, D, O, I, P>): NodeRef<Record<O, string>> {
  if (spec.post && "outputs" in spec.post)
    throw new Error(
      `post "${spec.post.name}" of task "${spec.name}": a post step has no outputs. Write what ` +
        `it leaves to the working tree.`,
    );
  const ref = spec.action === undefined ? addCommand(graph, spec) : addActionTask(graph, spec);
  if (spec.post) addPost(graph, ref, spec.post, spec.deps);
  return ref;
}
