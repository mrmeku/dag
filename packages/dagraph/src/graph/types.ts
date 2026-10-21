/** What an action returns: a path, a list of paths, or a record of either, all under its outputDir. */
export type Outputs = string | string[] | Record<string, string | string[]>;

const isPaths = (value: unknown): value is string | string[] =>
  typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));

/** Whether a value read back, such as a cache entry's, is outputs. */
export const isOutputs = (value: unknown): value is Outputs =>
  isPaths(value) ||
  (typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isPaths));

/** A node's outputs when they are one path, as its result holds them; refused otherwise. */
export function soleOutput(outputs: Outputs): string {
  if (typeof outputs !== "string") throw new Error("the node's outputs are not one path");
  return outputs;
}

/** The path a node's record of outputs holds as `name`; refused when it holds none. */
export function namedOutput(outputs: Outputs, name: string): string {
  const path = typeof outputs === "object" && !Array.isArray(outputs) ? outputs[name] : undefined;
  if (typeof path !== "string") throw new Error(`the node's outputs hold no path "${name}"`);
  return path;
}

export const OUTPUT_REF: unique symbol = Symbol.for("@mrmeku/dagraph/OutputRef");
export const FILE_INPUT: unique symbol = Symbol.for("@mrmeku/dagraph/file");
export const FILE_HANDLE: unique symbol = Symbol.for("@mrmeku/dagraph/FileHandle");

/** Handle to a node, returned by `addNode`. `T` is its action's output type. */
export interface NodeRef<T extends Outputs = Outputs> {
  readonly name: string;
  readonly settled?: false;
  readonly _T?: T;
}

/** A dep its node runs without when it does not succeed, as `Promise.allSettled` waits. */
export interface SettledRef<T extends Outputs = Outputs> {
  readonly name: string;
  readonly settled: true;
  readonly _T?: T;
}

/**
 * A ref to one output of a required dep, which a node's `inputs` function receives by the dep's
 * role: `inputs: ({ pack }) => ({ argv: ["npm", "publish", pack.tarball] })`. In a value input it
 * resolves to a handle on that output's published file, or a list of handles, and keys as the
 * role it points through and the output's name. `S` is the scope of the call that received it:
 * the ref goes only in what that call returns, so another node's ref does not compile.
 */
export interface OutputRef<T extends string | string[] = string | string[], S = unknown> {
  readonly [OUTPUT_REF]: true;
  readonly node: string;
  readonly output: string;
  readonly settled: false;
  readonly _T?: T;
  readonly _scope?: S;
}

/**
 * A ref to one output of a `settled` dep, which resolves to `undefined` when the dep did not
 * succeed. It never stands where an `OutputRef` is declared.
 */
export interface SettledOutputRef<T extends string | string[] = string | string[], S = unknown> {
  readonly [OUTPUT_REF]: true;
  readonly node: string;
  readonly output: string;
  readonly settled: true;
  readonly _T?: T;
  readonly _scope?: S;
}

type OutputRefs<T, S, Settled extends boolean> = [T] extends [Record<string, string | string[]>]
  ? {
      readonly [K in keyof T]: Settled extends true
        ? SettledOutputRef<T[K], S>
        : OutputRef<T[K], S>;
    }
  : Record<never, never>;

/**
 * What a node's `inputs` function receives: each dep it declares, by role, as a ref to each of
 * the dep's outputs, an `OutputRef` for a required dep and a `SettledOutputRef` for a `settled`
 * one. A dep whose outputs are not a record has no refs. The refs of a dep cannot be listed, as
 * by a spread, since its outputs' names exist only in the types: name each one, `pack.tarball`.
 */
export type DepRefs<D, S> = { readonly [K in keyof D]: RefsOf<D[K], S> };

type RefsOf<R, S> =
  R extends SettledRef<infer T>
    ? OutputRefs<T, S, true>
    : R extends NodeRef<infer T>
      ? OutputRefs<T, S, false>
      : R;

/** A file input: its path, as given, and its content's hash join the key. */
export interface FileInput {
  readonly [FILE_INPUT]: string;
}

/**
 * A value input: a string, a finite number, a boolean, `null`, or an array or a plain record of
 * these. A node's `inputs` function may also put in it the refs it received, of scope `S`. The key
 * holds the value as JSON with sorted keys, and each ref as the role it points through and its
 * output's name. A property that is `undefined` is dropped.
 *
 * These do not compile. Each has a right form:
 *
 * - A `Map` or a `Set`: `Object.fromEntries(map)`, `[...set]`.
 * - A `Date`: `date.toISOString()`.
 * - A `bigint`: `String(n)`.
 * - A function or a class instance: the data it holds, as a record.
 * - `undefined` as an array item: `null`, or no item.
 * - A `file()` in a value: a file is an input of its own, `inputs: { lock: file("bun.lock") }`.
 * - A node: a dep, declared in `deps`, whose output the `inputs` function names:
 *   `deps: { pack }, inputs: ({ pack }) => ({ argv: ["npm", "publish", pack.tarball] })`.
 * - A ref that the function did not receive, such as one kept from another node's function: a
 *   ref goes only in what the call that received it returns.
 *
 * No type sees these, so `defineAction` and `addNode` refuse them by their path, as
 * `inputs.ratio is NaN`: `NaN`, `Infinity`, and an object that is not plain, such as a class
 * instance typed as a record.
 */
export type InputValue<S = never> =
  | string
  | number
  | boolean
  | null
  | readonly InputValue<S>[]
  | { readonly [key: string]: InputValue<S> | undefined }
  | OutputRef<string | string[], S>
  | SettledOutputRef<string | string[], S>;

/**
 * Inputs by name, as an action and a node declare them: each a `file(path)`, only ever a whole
 * input, or an `InputValue`. `S` is the scope of the `inputs` function whose refs it holds. The
 * default, `never`, holds no refs: an action's inputs and a node's record of inputs name no output.
 */
export type InputRecord<S = never> = {
  readonly [name: string]: InputValue<S> | FileInput | undefined;
};

// TypeScript refuses a symbol in a template string, with +, or where a string goes.
type StandsWhole = { toString: never; valueOf: never } & symbol;

/**
 * A file an action reads: a `file()` input, or an output of a dep. Where it lives is the engine's.
 *
 * - Hand a tool its path: `ports.images.resize(depOutputs.source.path, out)`.
 * - Read it with `text()`, or with `json(isMeta)`, where `isMeta` is a type guard.
 * - It stands whole: TypeScript refuses it in a template string or with `+`, and `String` and
 *   `JSON.stringify` throw. A string takes its `path`: `` `--input=${source.path}` ``.
 * - Tell a handle apart with `isFileHandle`, never with `typeof`: its type is a symbol's, but it
 *   is an object.
 */
export type FileHandle = {
  readonly [FILE_HANDLE]: true;
  /**
   * Its absolute path while the action runs, for a command or a library that takes a path. It
   * differs by machine and working directory, so never key on it: build no fingerprint and no
   * output's content from it.
   */
  readonly path: string;
  /** Its contents. */
  text(): Promise<string>;
  /** Its contents as JSON, checked by `is`; a file `is` refuses throws, naming the file. */
  json<T>(is: (value: unknown) => value is T): Promise<T>;
} & StandsWhole;

/**
 * Outputs as an action reads them: each path a `FileHandle`, a list or a record as such, and a
 * failed settled dep's `undefined` as is.
 */
export type Handles<T> = T extends string
  ? FileHandle
  : T extends string[]
    ? FileHandle[]
    : T extends Record<string, string | string[]>
      ? { [K in keyof T]: Handles<T[K]> }
      : T extends undefined
        ? undefined
        : never;

export function nodeRef<T extends Outputs>(name: string): NodeRef<T> {
  return { name };
}

/** Mark a dep its node runs without: when it does not succeed, its role is `undefined`. */
export function settled<T extends Outputs>(ref: NodeRef<T>): SettledRef<T> {
  return { name: ref.name, settled: true };
}

/** The deps a node may declare, by role. */
export type DepRecord = Record<string, NodeRef | SettledRef | undefined>;

/**
 * The argument of a node's `inputs` function: each dep in `deps`, by role, as refs to its outputs.
 * `D` is the type of `deps` as the node declared them.
 */
export function depRefs<D, S>(deps: DepRecord | undefined): DepRefs<D, S> {
  const refs = Object.fromEntries(
    Object.entries(deps ?? {}).flatMap(([role, dep]) => {
      if (!dep) return [];
      const ref = (output: string) => ({
        [OUTPUT_REF]: true,
        node: dep.name,
        output,
        settled: dep.settled === true,
      });
      const get = (_: object, output: string | symbol) =>
        typeof output === "string" ? ref(output) : undefined;
      // A spread or a value that holds the record would list no outputs, so it fails instead.
      const ownKeys = () => {
        throw new TypeError(
          `the refs of ${role} cannot be listed: name each output, as ${role}.<output>`,
        );
      };
      return [[role, new Proxy({}, { get, ownKeys })]];
    }),
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- each Proxy answers every name; the deps' types and their output names exist only in the types
  return refs as DepRefs<D, S>;
}

/** A file input, read by the action as a handle on the file. */
export function file(path: string): FileInput {
  return { [FILE_INPUT]: path };
}

const branded = (value: unknown, brand: symbol) =>
  typeof value === "object" && value !== null && brand in value;
export const isOutputRef = (value: unknown): value is OutputRef | SettledOutputRef =>
  branded(value, OUTPUT_REF);
export const isFileInput = (value: unknown): value is FileInput => branded(value, FILE_INPUT);
/** Whether a value is a handle: a list or a record of handles is not. */
export const isFileHandle = (value: unknown): value is FileHandle => branded(value, FILE_HANDLE);

/** What a node may declare: deps by role and inputs by name. An action's `P` narrows both. */
export interface BaseParams {
  deps?: DepRecord;
  inputs?: InputRecord<unknown>;
}

/** Each dep's outputs by role, as handles: a `settled` dep's are `Handles<T> | undefined`. */
export type DepOutputsOf<P> = P extends { deps?: infer D }
  ? {
      [K in keyof NonNullable<D>]: NonNullable<D>[K] extends NodeRef<infer T>
        ? Handles<T>
        : NonNullable<D>[K] extends NodeRef<infer T> | SettledRef<infer T> | undefined
          ? Handles<T> | undefined
          : unknown;
    }
  : never;

/** An input as the action reads it: a file as a handle, an output ref as that output's handles. */
export type Resolved<V> = V extends FileInput
  ? FileHandle
  : V extends SettledOutputRef<infer T, unknown>
    ? Handles<T> | undefined
    : V extends OutputRef<infer T, unknown>
      ? Handles<T>
      : V extends readonly (infer U)[]
        ? Resolved<U>[]
        : V extends object
          ? { [K in keyof V]: Resolved<V[K]> }
          : V;

type NodeInputsOf<P> = P extends { inputs?: infer I } ? NonNullable<I> : unknown;

/**
 * Everything one call of an action gets. What is keyed: `inputs` and `depOutputs`, each file in
 * them a `FileHandle`. Its tools: `ports`. What the attempt gives: `outputDir`, the absolute path
 * of a new, empty directory only this attempt writes; `signal`, which fires on the node's timeout
 * or the execution's cancel; and `output`, for what the action prints, in chunks as printed.
 */
export interface ActionContext<
  Ports = unknown,
  P extends BaseParams = BaseParams,
  I = Record<string, unknown>,
> {
  inputs: Resolved<I & NodeInputsOf<P>>;
  depOutputs: DepOutputsOf<P>;
  ports: Ports;
  outputDir: string;
  signal: AbortSignal;
  output: (chunk: string) => void;
}

/**
 * For a dep its nodes read only in part, that part as a fingerprint by role. The string's hash
 * stands in for the dep's content hash in the key. Build it from the files' contents, never from a
 * handle's `path`, which differs by machine and working directory.
 */
export type InvalidateOn<Ports, P extends BaseParams> = {
  [K in keyof DepOutputsOf<P>]?: (
    outputs: NonNullable<DepOutputsOf<P>[K]>,
    ports: Ports,
  ) => Promise<string> | string;
};

/**
 * A node's own inputs, added to its action's: a record, or a function of the deps the node
 * declares that returns one. The function is the one way to put a ref in a value input, and it
 * runs once, when the node is added: `inputs: ({ pack }) => ({ argv: ["publish", pack.tarball] })`.
 * `PI` is what the action's `P` says each node adds, and `D` the node's deps.
 */
export type NodeInputs<PI, D> =
  | (PI & InputRecord)
  | (<S>(deps: DepRefs<D, S>) => PI & InputRecord<S>);

/** Whether `P` takes a dep in any role, as `BaseParams` does, rather than in roles it names. */
type TakesAnyRole<P> = P extends { deps?: infer PD }
  ? string extends keyof NonNullable<PD>
    ? true
    : false
  : false;

/** The deps a node's `inputs` function gets the refs of: the roles `P` names, or else the node's `D`. */
export type NodeDeps<P, D> = P extends { deps?: infer PD }
  ? TakesAnyRole<P> extends true
    ? D
    : NonNullable<PD>
  : Record<never, never>;

/**
 * What `addNode` takes: a name, deps, inputs and meta, and nothing else. A node's deps are the
 * roles its action's `P` names; `D`, inferred from the node, stands for them only where `P` takes
 * any role.
 */
export type NodeParams<P extends BaseParams, Meta, D> = {
  name?: string;
  meta?: Meta;
} & Pick<P, "deps" & keyof P> &
  (TakesAnyRole<P> extends true ? { deps?: D } : unknown) &
  (P extends { inputs: infer PI }
    ? { inputs: NodeInputs<PI, NodeDeps<P, D>> }
    : { inputs?: NodeInputs<unknown, NodeDeps<P, D>> });

/**
 * A node as data, from `graph.describe()`: no action, inputs or fingerprints, so it can cross
 * into orchestration and into another process when its `meta` can.
 */
export interface Node<Meta = unknown> {
  name: string;
  kind: string;
  meta?: Meta;
  /** The names of the nodes it depends on, once each. */
  deps: string[];
  /** The deps it runs without when they do not succeed. */
  settledDeps?: string[];
  concurrencyGroup?: string;
  /** `false`: the node's entry is never read or written, so it runs in every execution. */
  cacheable?: boolean;
  /** How long the action may run, in ms, before its signal fires with a "TimeoutError". */
  timeoutMs?: number;
}

export function requiredDeps(node: Node): string[] {
  return node.deps.filter((d) => !node.settledDeps?.includes(d));
}
