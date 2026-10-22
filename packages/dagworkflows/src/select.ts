import { closure, nodeRefNamed, settled, type Graph } from "@mrmeku/dagraph";
import type { Ports } from "./ports.ts";
import { postsOf, recordPost } from "./steps.ts";
import { depRoles } from "./task.ts";

/**
 * The subgraph needed to run `names`: the engine's `closure` of those nodes, and the post steps of
 * every node among them. A post keeps its deps in that set; a dep left out is replaced by the
 * nodes in the set it reaches, as settled deps, so a post ordered after the run through a
 * `workflow.requireAll` node still waits for what runs, whether it succeeds or not. A post whose
 * command or env refers to an output of a node left out is left out too, and with it its own
 * posts, rather than run with no path where the output was. The facade adds such a post again from
 * its record, with those deps.
 */
export function selectNodes(graph: Graph<Ports>, names: string[]): Graph<Ports> {
  const nodes = new Map(graph.describe().map((node) => [node.name, node]));
  const posts = postsOf(graph);
  const keep = new Set(
    closure(graph, names)
      .describe()
      .map((node) => node.name),
  );
  const out = closure(graph, keep);
  // The kept nodes `name` is or reaches through left-out deps, each node visited once per post.
  const reach = (name: string, seen: Set<string>): string[] => {
    if (seen.has(name)) return [];
    seen.add(name);
    if (keep.has(name)) return [name];
    const node = nodes.get(name);
    if (!node) throw new Error(`selectNodes: the graph holds no node "${name}"`);
    return node.deps.flatMap((d) => reach(d, seen));
  };
  // In the order they were added, so a post comes after its main, and a post of a post after both.
  for (const [name, node] of nodes) {
    const post = posts.get(name);
    if (!post) continue;
    if (keep.has(name)) {
      recordPost(out, name, post);
      continue;
    }
    if (!keep.has(post.main) || !post.refs.every((d) => keep.has(d))) continue;
    keep.add(name);
    const directDeps = depRoles(post.deps).filter(([, ref]) => keep.has(ref.name));
    const direct = Object.fromEntries(directDeps);
    const directNames = directDeps.map(([, ref]) => ref.name);
    const seen = new Set<string>();
    const through = node.deps
      .filter((d) => !keep.has(d))
      .flatMap((d) => reach(d, seen))
      .filter((d) => !directNames.includes(d));
    const deps = {
      ...direct,
      ...Object.fromEntries(through.map((d) => [`only:${d}`, settled(nodeRefNamed(d))])),
    };
    post.addTo(out, name, deps);
    recordPost(out, name, { ...post, deps });
  }
  return out;
}
