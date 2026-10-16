# Design

The engine stays small by one rule: **if a node can do it, add a node.** A node has a name, a config, dependencies, an action and outputs. A behavior that these five can express does not need a new concept in the engine.

## Checks are nodes

A check is the standard example. A check is a node that depends on another node, reads its outputs and writes a list of defects. Its properties come from the node that it is:

- **It runs once for each version of its subject.** Its key includes its subject's content hash.
- **A new type of defect does not run the subject again.** The check has its own config. A change to that config runs the check again on the cached files of its subject.
- **Nothing depends on it.** So its result changes no other node.

The engine does not know that the node is a check. To get a report, a caller runs the graph with `cacheOnly` on each node except the checks, and reads their files.

A `check` role in the engine would give it the same information. But it would also need a field on nodes, a format for verdicts and a shape for results. The node already expresses all three.

## When a primitive is necessary

A new primitive is necessary only when a node cannot express a behavior without breaking the engine's one contract: **a node's action key covers everything that decides its output.**

Each primitive in the engine is a statement about the key or about the executor:

| Primitive          | Why a node cannot do it                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optional()`       | It changes what the scheduler does when a dependency fails.                                                                                                                      |
| `cacheable: false` | It changes what the cache does.                                                                                                                                                  |
| `force`            | It is a decision for one run. A node cannot make it about itself.                                                                                                                |
| `cacheOnly`        | It is a decision for one run. A node cannot make it about itself.                                                                                                                |
| `inputs`           | It covers files outside the graph. A node can read them, but it cannot put them in its key.                                                                                      |
| `normalize`        | It keys a node on part of a dependency. A projection node can do this for an exact fingerprint. It cannot do it honestly for a fingerprint that leaves something out on purpose. |

None of these is something that a node could be.

## The test

When you are not sure, build the behavior as a node first. If it works, it was never a primitive.
