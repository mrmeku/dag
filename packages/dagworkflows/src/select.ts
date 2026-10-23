import { closure, nodeRefNamed, settled, type Graph, type SettledRef } from "@mrmeku/dagraph";
import type { Ports } from "./ports.ts";
import { postsOf, recordPost, waitRole, type PostRecord } from "./steps.ts";
import { depRoles } from "./task.ts";

const nodeNames = (graph: Graph<Ports>) => new Set(graph.describe().map((node) => node.name));

/**
 * Two or more posts that would wait for each other, which cannot run. The fix converts one whose
 * main is not a post into a task of the same form, naming its deps.
 */
function cycleError(cycle: string[], posts: ReadonlyMap<string, PostRecord>): Error {
  const named = cycle.map((name) => `"${name}"`);
  const listed = `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
  const rule =
    `posts ${listed} wait for each other: a post waits for every node downstream of its main, ` +
    `and each is downstream of another's main, neither main upstream of the other.`;
  const convertible = cycle.find((name) => {
    const main = posts.get(name)?.deps.main;
    return main !== undefined && !posts.has(main.name);
  });
  const post = convertible === undefined ? undefined : posts.get(convertible);
  const main = post?.deps.main;
  if (convertible === undefined || post === undefined || main === undefined) return new Error(rule);
  const ref = /^[A-Za-z_$][\w$]*$/.test(main.name) ? main.name : "main";
  const given = "settled" in main ? `settled(${ref})` : ref;
  return new Error(
    `${rule} Make one a task, which waits only for the deps it names: ` +
      `workflow.task({ name: "${convertible}", deps: { main: ${given}, ...deps }, ${post.work} }).`,
  );
}

/** The posts in an order they can be added: each after the posts it waits for and its main. */
function postOrder(posts: ReadonlyMap<string, PostRecord>, waits: Map<string, string[]>) {
  const order: string[] = [];
  const path: string[] = [];
  const visit = (name: string) => {
    if (order.includes(name)) return;
    if (path.includes(name)) throw cycleError(path.slice(path.indexOf(name)), posts);
    path.push(name);
    for (const before of [...(waits.get(name) ?? []), posts.get(name)?.main ?? ""])
      if (posts.has(before)) visit(before);
    path.pop();
    order.push(name);
  };
  for (const name of posts.keys()) visit(name);
  return order;
}

/**
 * The graph a run executes, of `names` (every node unless given): the engine's `closure` of them,
 * with the posts of every main in it and their deps' closure, until nothing more joins. Each post
 * then waits, by a settled dep, for every node of the run downstream of its main, posts of other
 * mains included, but not for the other posts of its own main or for what follows it. Nothing but
 * a post depends on a post, so the posts go last, each after the posts it waits for.
 */
export function selectNodes(graph: Graph<Ports>, names?: Iterable<string>): Graph<Ports> {
  const posts = postsOf(graph);
  let held = nodeNames(closure(graph, names ?? nodeNames(graph)));
  for (;;) {
    const joining = [...posts].filter(([name, post]) => held.has(post.main) && !held.has(name));
    if (joining.length === 0) break;
    held = nodeNames(closure(graph, [...held, ...joining.map(([name]) => name)]));
  }
  const run = closure(
    graph,
    [...held].filter((name) => !posts.has(name)),
  );
  const heldPosts = new Map([...posts].filter(([name]) => held.has(name)));
  // Every node of the run with what it depends on, each after its deps: a post after its main.
  const depsOf = new Map([
    ...run.describe().map((node): [string, string[]] => [node.name, node.deps]),
    ...[...heldPosts].map(([name, post]): [string, string[]] => [
      name,
      depRoles(post.deps).map(([, ref]) => ref.name),
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
  // A post waits for what its main's run reaches, but not for the posts of its own main and what
  // follows them, nor for a post of a main upstream of its own, which waits for it instead: posts
  // run in the reverse order of their mains, as GitHub's do.
  const waits = new Map(
    [...heldPosts].map(([name, post]): [string, string[]] => {
      const ownPosts = [...heldPosts].filter(([, other]) => other.main === post.main);
      const afterOwn = new Set(ownPosts.flatMap(([own]) => [own, ...downstreamOf(own)]));
      const isOuter = (node: string) => {
        const other = heldPosts.get(node);
        return other !== undefined && downstreamOf(other.main).has(post.main);
      };
      const waited = [...depsOf.keys()].filter(
        (node) => downstreamOf(post.main).has(node) && !afterOwn.has(node) && !isOuter(node),
      );
      return [name, waited];
    }),
  );
  for (const name of postOrder(heldPosts, waits)) {
    const post = heldPosts.get(name);
    if (!post) continue;
    const settledWaits = (waits.get(name) ?? []).map((node): [string, SettledRef] => [
      waitRole(node),
      settled(nodeRefNamed(node)),
    ]);
    post.addTo(run, { ...post.deps, ...Object.fromEntries(settledWaits) });
    recordPost(run, name, post);
  }
  return run;
}
