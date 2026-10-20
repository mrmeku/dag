# Design

The engine stays small by one rule: **if a node can do it, add a node.** A node has a name, inputs, dependencies, an action and outputs. A behavior that these can express does not need a new concept in the engine.

## Checks are nodes

A check is the standard example. A check is a node that depends on another node, reads its outputs and writes a list of defects. Its properties come from the node that it is:

- **It runs once for each version of its subject.** Its key includes its subject's content hash.
- **A new type of defect does not run the subject again.** The check has its own version input. A change to it runs the check again on the cached files of its subject.
- **Nothing depends on it.** So its result changes no other node.

The engine does not know that the node is a check. The checks run in each execution, cached by the content that they inspect, so the last execution's results already tell which subjects have defects.

A `check` role in the engine would give it the same information. But it would also need a field on nodes, a format for verdicts and a shape for results. The node already expresses all three.

## When a primitive is necessary

A new primitive is necessary only when a node cannot express a behavior without breaking the engine's one contract: **a node's action key covers everything that decides its output.**

Each primitive in the engine is a statement about the key or about the executor:

| Primitive          | Why a node cannot do it                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settled()`        | It changes what orchestration does when a dependency fails.                                                                                                                      |
| `cacheable: false` | It changes what the cache does.                                                                                                                                                  |
| `force`            | It is a decision for one execution, or for one node in an executor. A node cannot make it about itself.                                                                          |
| `cacheOnly`        | It is a decision of an executor, to look a node up before it sends it to work. A node cannot make it about itself.                                                               |
| `inputs`           | They cover what is outside the graph. A node can read a file, but it cannot put it in its key.                                                                                   |
| `invalidateOn`     | It keys a node on part of a dependency. A projection node can do this for an exact fingerprint. It cannot do it honestly for a fingerprint that leaves something out on purpose. |

None of these is something that a node could be.

## What the engine does not know

- **Processes, shells and terminals.** A node is a function. That at most one node holds the terminal is a concurrency group with a limit of 1.
- **Repositories.** A path goes to `DagFs` as given. The engine knows no root.
- **The environment.** An input is a file or a value. Reading an environment variable into a value is the caller's work.
- **GitHub, Temporal or any other platform.** Retries, task queues, run histories and summaries belong to executors.
- **Secrets.** The engine keys on what it is given. Keeping a secret out of a key is the caller's work.
- **What a node is for.** An aggregate or a cleanup is a node like any other, and `meta` is the caller's to give and read.

## The test

When you are not sure, build the behavior as a node first. If it works, it was never a primitive.
