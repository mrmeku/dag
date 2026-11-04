import { sha256 } from "js-sha256";
import type { GraphNode } from "./graph.ts";
import { canonical } from "./inputs.ts";
import type { HashFile } from "./ports.ts";
import { FILE_INPUT, isFileInput } from "./types.ts";

/** One input as keyed: a file's path and content hash, or a value's canonical JSON. */
export type ActionKeyInput = ["file", string, string] | ["value", string];
/**
 * One dep role as keyed: the hash of each output it reads, by name (`null` for one the dep did not
 * produce), or the mark for missing.
 */
export type ActionKeyDep = ["outputs", [string, string | null][]] | ["missing"];

/**
 * The node's action key: SHA256 of its action's kind, each input by name and each dep by role, both
 * sorted. A dep keys on the hashes of the outputs its role reads, from `depOutputHashes` by dep
 * node name, and a `file()` input on its content, hashed by `hashFile`. Nothing else joins it: not
 * the node's name or its deps' names, its meta or its how-to-run fields.
 */
export async function computeActionKey(
  { spec, roles, inputs }: GraphNode,
  depOutputHashes: Record<string, Record<string, string>>,
  hashFile: HashFile,
): Promise<string> {
  const rolesOf = (dep: string) =>
    Object.keys(roles)
      .filter((role) => roles[role] === dep)
      .sort();
  const refKey = (ref: { node: string; output: string }) =>
    JSON.stringify([rolesOf(ref.node), ref.output]);
  const actionKeyInputs: Record<string, ActionKeyInput> = {};
  for (const [name, value] of Object.entries(inputs)) {
    actionKeyInputs[name] = isFileInput(value)
      ? ["file", value[FILE_INPUT], await hashFile(value[FILE_INPUT])]
      : ["value", canonical(value, refKey)];
  }
  const actionKeyDeps: Record<string, ActionKeyDep> = {};
  for (const [role, dep] of Object.entries(roles)) {
    const hashes = Object.hasOwn(depOutputHashes, dep) ? depOutputHashes[dep] : undefined;
    if (!hashes) {
      actionKeyDeps[role] = ["missing"];
      continue;
    }
    const read = spec.pickedOutputs[role] ?? Object.keys(hashes);
    actionKeyDeps[role] = ["outputs", [...read].sort().map((o) => [o, hashes[o] ?? null])];
  }
  const sorted = <T>(record: Record<string, T>) =>
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]]);
  return sha256.hex(JSON.stringify([spec.kind, sorted(actionKeyInputs), sorted(actionKeyDeps)]));
}
