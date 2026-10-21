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

export const NODE_REF: unique symbol = Symbol.for("@mrmeku/dagraph/NodeRef");
export const OUTPUT_REF: unique symbol = Symbol.for("@mrmeku/dagraph/OutputRef");
export const FILE_INPUT: unique symbol = Symbol.for("@mrmeku/dagraph/file");
export const FILE_HANDLE: unique symbol = Symbol.for("@mrmeku/dagraph/FileHandle");

/**
 * A ref to one output of a node whose outputs are a record: `pack.outputs.tarball`. In a value
 * input it resolves to a handle on that output's published file, or a list of handles, and keys
 * as the role it points through and the output's name.
 */
export interface OutputRef<
  T extends string | string[] | undefined = string | string[] | undefined,
> {
  readonly [OUTPUT_REF]: true;
  readonly node: string;
  readonly output: string;
  readonly _T?: T;
}

type OutputRefs<T, Missing extends undefined> = [T] extends [Record<string, string | string[]>]
  ? { readonly outputs: { readonly [K in keyof T]: OutputRef<T[K] | Missing> } }
  : unknown;

/** Handle to a node, returned by `addNode`. `T` is its action's output type. */
export type NodeRef<T extends Outputs = Outputs> = {
  readonly name: string;
  readonly settled?: false;
  readonly _T?: T;
} & OutputRefs<T, never>;

/** A dep its node runs without when it does not succeed, as `Promise.allSettled` waits. */
export type SettledRef<T extends Outputs = Outputs> = {
  readonly name: string;
  readonly settled: true;
  readonly _T?: T;
} & OutputRefs<T, undefined>;

/** A file input: its path, as given, and its content's hash join the key. */
export interface FileInput {
  readonly [FILE_INPUT]: string;
}

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

function outputRefsOf<T extends Outputs, Missing extends undefined>(
  node: string,
): OutputRefs<T, Missing> {
  const outputs = new Proxy(
    {},
    {
      get: (_, output) =>
        typeof output === "string" ? { [OUTPUT_REF]: true, node, output } : undefined,
    },
  );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the Proxy answers every name; T's keys exist only in the types
  return { outputs } as OutputRefs<T, Missing>;
}

export function nodeRef<T extends Outputs>(name: string): NodeRef<T> {
  return Object.assign({ [NODE_REF]: true, name }, outputRefsOf<T, never>(name));
}

/** Mark a dep its node runs without: when it does not succeed, its role is `undefined`. */
export function settled<T extends Outputs>(ref: NodeRef<T>): SettledRef<T> {
  const own = { [NODE_REF]: true, name: ref.name, settled: true } as const;
  return Object.assign(own, outputRefsOf<T, undefined>(ref.name));
}

/** A file input, read by the action as a handle on the file. */
export function file(path: string): FileInput {
  return { [FILE_INPUT]: path };
}

const branded = (value: unknown, brand: symbol) =>
  typeof value === "object" && value !== null && brand in value;
export const isNodeRef = (value: unknown) => branded(value, NODE_REF);
export const isOutputRef = (value: unknown): value is OutputRef => branded(value, OUTPUT_REF);
export const isFileInput = (value: unknown): value is FileInput => branded(value, FILE_INPUT);
/** Whether a value is a handle: a list or a record of handles is not. */
export const isFileHandle = (value: unknown): value is FileHandle => branded(value, FILE_HANDLE);

/** What a node may declare: deps by role and inputs by name. An action's `P` narrows both. */
export interface BaseParams {
  deps?: Record<string, NodeRef | SettledRef | undefined>;
  inputs?: object;
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
  : V extends OutputRef<infer T>
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

/** What `addNode` takes: a name, deps, inputs and meta, and nothing else. */
export type NodeParams<P extends BaseParams, Meta> = {
  name?: string;
  meta?: Meta;
} & Pick<P, "deps" & keyof P> &
  (P extends { inputs: infer I }
    ? { inputs: I & Record<string, unknown> }
    : { inputs?: Record<string, unknown> });

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
