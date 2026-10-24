import { closure, nodeRefNamed, settled, type Graph, type SettledRef } from "@mrmeku/dagraph";
import type { Ports } from "./ports.ts";
import { postsOf, recordPost, recordSave, savesOf, waitRole, type PostRecord } from "./steps.ts";
import { depRoles } from "./task.ts";

const nodeNames = (graph: Graph<Ports>) => new Set(graph.describe().map((node) => node.name));

/** Settled waits on `nodes`, by their wait roles. */
const waitsOn = (nodes: Iterable<string>) =>
  Object.fromEntries(
    [...nodes].map((node): [string, SettledRef] => [waitRole(node), settled(nodeRefNamed(node))]),
  );

/**
 * The posts in an order they can be added: each after the posts it waits for. A post waits only
 * for posts of mains downstream of its own, so no two wait for each other.
 */
function postOrder(posts: ReadonlyMap<string, PostRecord>, waits: Map<string, string[]>) {
  const order: string[] = [];
  const visit = (name: string) => {
    if (order.includes(name)) return;
    for (const before of waits.get(name) ?? []) if (posts.has(before)) visit(before);
    order.push(name);
  };
  for (const name of posts.keys()) visit(name);
  return order;
}

/**
 * The graph a run executes, of `names` (every node unless given): the engine's `closure` of them,
 * with the posts of every main in it and the saves of every restore in it. Each post then waits,
 * by a settled dep, for every node of the run downstream of its main, posts of other mains
 * included, but not for the other posts of its own main. Each save waits for every other node of
 * the run but the posts and the saves. Nothing depends on a post or a save, so they go last.
 *
 * A post requires what its main requires, so it is skipped when its main never started. `paying`
 * builds the graph of a post pass instead: there an owed post's main started, so the post needs
 * only its main, and a dep that the workflow file has added to the main since cannot hold it back.
 */
export function selectNodes(
  graph: Graph<Ports>,
  names?: Iterable<string>,
  paying = false,
): Graph<Ports> {
  const posts = postsOf(graph);
  const saves = savesOf(graph);
  let held = nodeNames(closure(graph, names ?? nodeNames(graph)));
  for (;;) {
    const joining = [
      ...[...posts].filter(([name, post]) => held.has(post.main) && !held.has(name)),
      ...[...saves].filter(([name, save]) => held.has(save.restore) && !held.has(name)),
    ];
    if (joining.length === 0) break;
    held = nodeNames(closure(graph, [...held, ...joining.map(([name]) => name)]));
  }
  const run = closure(
    graph,
    [...held].filter((name) => !posts.has(name) && !saves.has(name)),
  );
  const tasks = nodeNames(run);
  const heldPosts = new Map([...posts].filter(([name]) => held.has(name)));
  // Every node of the run with what it depends on, each after its deps: a post after its main.
  const depsOf = new Map([
    ...run.describe().map((node): [string, string[]] => [node.name, node.deps]),
    ...[...heldPosts].map(([name, post]): [string, string[]] => [
      name,
      depRoles({ ...post.deps, ...post.mainRequires }).map(([, ref]) => ref.name),
    ]),
  ]);
  const downstream = new Map<string, Set<string>>();
  const downstreamOf = (name: string) => {
    const known = downstream.get(name);
    if (known) return known;
    const found = new Set([name]);
    for (const [node, deps] of depsOf) if (deps.some((dep) => found.has(dep))) found.add(node);
    found.delete(name);
    downstream.set(name, found);
    return found;
  };
  // A post waits for what its main's run reaches, posts of mains downstream of its own included,
  // but not for the other posts of its own main: posts run in the reverse order of their mains,
  // as GitHub's do.
  const waits = new Map(
    [...heldPosts].map(([name, post]): [string, string[]] => {
      const isOwn = (node: string) => heldPosts.get(node)?.main === post.main;
      const waited = [...depsOf.keys()].filter(
        (node) => downstreamOf(post.main).has(node) && !isOwn(node),
      );
      return [name, waited];
    }),
  );
  for (const name of postOrder(heldPosts, waits)) {
    const post = heldPosts.get(name);
    if (!post) continue;
    const requires = paying ? {} : post.mainRequires;
    post.addTo(run, { ...post.deps, ...requires, ...waitsOn(waits.get(name) ?? []) });
    recordPost(run, name, post);
  }
  for (const [name, save] of saves) {
    if (!held.has(name)) continue;
    save.addTo(run, waitsOn(tasks));
    recordSave(run, name, save);
  }
  return run;
}
