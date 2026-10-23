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
export const DEP: unique symbol = Symbol.for("@mrmeku/dagraph/Dep");
export const NODE_INPUTS: unique symbol = Symbol.for("@mrmeku/dagraph/NodeInputs");

/**
 * A value that is never part of a string. It is typed as a symbol, which TypeScript refuses in a
 * template string, with `+`, and where a string goes.
 */
export type NotAString = { toString: never; valueOf: never } & symbol;

/**
 * `value` itself, made a value that is never part of a string: each conversion to a string throws
 * `refusal`, and its type is NotAString, so TypeScript refuses it in a template string or with `+`.
 */
export function notAString<T extends object>(value: T, refusal: string): T & NotAString {
  const refuse = () => {
    throw new TypeError(refusal);
  };
  for (const key of ["toString", "valueOf", "toJSON", Symbol.toPrimitive])
    Object.defineProperty(value, key, { value: refuse });
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- NotAString types an object as a symbol, which no object is
  return value as T & NotAString;
}

/** Whether `name` is a key as code writes it bare, so a fix can show `{ name }`. */
export const isIdentifier = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name);

/** Handle to a node, returned by `addNode`. `T` is its action's output type. */
export type NodeRef<T extends Outputs = Outputs> = {
  readonly name: string;
  readonly settled?: false;
  readonly _T?: T;
} & NotAString;

/** A dep its node runs without when it does not succeed, as `Promise.allSettled` waits. */
export type SettledRef<T extends Outputs = Outputs> = {
  readonly name: string;
  readonly settled: true;
  readonly _T?: T;
} & NotAString;

/**
 * A ref to one output of a required dep, which a node's `inputs` function receives by the dep's
 * role: `inputs: ({ pack }) => ({ argv: ["npm", "publish", pack.tarball] })`. In a value input it
 * resolves to a handle on that output's published file, or a list of handles, and keys as the
 * role it points through and the output's name. `S` is the scope of the call that received it:
 * the ref goes only in what that call returns, so another node's ref does not compile.
 */
export type OutputRef<T extends string | string[] = string | string[], S = unknown> = {
  readonly [OUTPUT_REF]: true;
  readonly node: string;
  readonly output: string;
  readonly settled: false;
  readonly _T?: T;
  readonly _scope?: S;
} & NotAString;

/**
 * A ref to one output of a `settled` dep, which resolves to `undefined` when the dep did not
 * succeed. It never stands where an `OutputRef` is declared.
 */
export type SettledOutputRef<T extends string | string[] = string | string[], S = unknown> = {
  readonly [OUTPUT_REF]: true;
  readonly node: string;
  readonly output: string;
  readonly settled: true;
  readonly _T?: T;
  readonly _scope?: S;
} & NotAString;

/** The output `K` where every return holds it, and an index signature does not name it. */
type RequiredOutput<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? never : K;

type OutputRefs<T, S, Settled extends boolean> = [T] extends [Record<string, string | string[]>]
  ? {
      readonly [K in keyof T as RequiredOutput<T, K>]: Settled extends true
        ? SettledOutputRef<T[K], S>
        : OutputRef<T[K], S>;
    }
  : Record<never, never>;

/**
 * What a node's `inputs` function receives: each dep it declares, by role, as a ref to each of
 * the dep's outputs, an `OutputRef` for a required dep and a `SettledOutputRef` for a `settled`
 * one. A dep whose outputs are not a record has no refs. The refs of a dep cannot be listed, as
 * by a spread, since its outputs' names exist only in the types: name each one, `pack.tarball`.
 * An output that some return of the dep leaves out, or that an index signature names, has no ref:
 * the action reads it from `depOutputs`, where it is `| undefined`.
 */
export type DepRefs<D, S> = { readonly [K in keyof D]: RefsOf<D[K], S> };

type RefsOf<R, S> =
  R extends SettledRef<infer T>
    ? OutputRefs<T, S, true>
    : R extends NodeRef<infer T>
      ? OutputRefs<T, S, false>
      : R;

/** A file input: its path, as given, and its content's hash join the key. */
export type FileInput = { readonly [FILE_INPUT]: string } & NotAString;

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
 * instance typed as a record. A narrower type can also hide a value, as a record typed
 * `{ model: string }` can hold a function. Both refuse such a value: a function, a symbol, a
 * bigint, and `undefined` in a list.
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

/**
 * A file an action reads: a `file()` input, or an output of a dep. Where it lives is the engine's.
 *
 * - Hand a tool its path: `ports.images.resize(depOutputs.source.path, out)`.
 * - Read it with `text()`, or with `json(isMeta)`, where `isMeta` is a type guard.
 * - It is never part of a string: TypeScript refuses it in a template string or with `+`, and
 *   `String` and `JSON.stringify` throw. A string takes its `path`: `` `--input=${source.path}` ``.
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
  /** The SHA256 of its bytes, as the engine hashes outputs: the fingerprint of a binary file. */
  hash(): Promise<string>;
} & NotAString;

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

const nodeRefusal = (name: string, settled = false) =>
  `node "${name}" can't be part of a string. Put it in deps` +
  (!isIdentifier(name)
    ? "."
    : settled
      ? `: deps: { ${name}: settled(${name}) }.`
      : `: deps: { ${name} }.`);

export function nodeRef<T extends Outputs>(name: string): NodeRef<T> {
  return notAString({ name }, nodeRefusal(name));
}

/** A ref to the node named `name`, its outputs untyped, for a dep on a node known by name alone. */
export const nodeRefNamed = (name: string): NodeRef => nodeRef(name);

/**
 * A dep as an action declares it in `deps`, by role: the outputs its node returns. An action is
 * one, so `deps: { fetch }` takes a node of `fetch`; `dep<T>` is one for a role that more than one
 * action fills. A node of the action gives the role a `NodeRef<T>`, never a `Dep`.
 */
export interface Dep<T extends Outputs = Outputs> {
  readonly [DEP]: true;
  readonly settled?: false;
  readonly _T?: T;
}

/** A dep declared `settled`, which its node runs without: a node gives it a `SettledRef<T>`. */
export interface SettledDep<T extends Outputs = Outputs> {
  readonly [DEP]: true;
  readonly settled: true;
  readonly _T?: T;
}

/** A role as an action declares it. One whose type holds `undefined` is `maybe`. */
type DepSpec = Dep | SettledDep | undefined;

/**
 * The deps an action declares, by role: each a `DepSpec`, or a function that returns one, as an
 * uncalled `dep<T>` is. A record of this type takes a dep in any role: `const anyRole: DepSpecs =
 * {}`, `deps: anyRole`.
 */
export type DepSpecs = { readonly [role: string]: DepSpec | (() => DepSpec) };

/** A role as declared, its marker uncalled or called: `settled<T>` and `settled<T>()` are one. */
type Role<X> = X extends () => infer R ? R : X;

/**
 * A role that more than one action fills, by the outputs its nodes return. It names only a type,
 * so it goes uncalled: `deps: { image: dep<string> }`. Where one action fills the role, name that
 * action: `deps: { fetch }`.
 */
export function dep<T extends Outputs>(): Dep<T> {
  return { [DEP]: true };
}

/**
 * Mark a dep its node runs without: when it does not succeed, its role is `undefined`. An action
 * declares the role with it, around the action that fills it, `deps: { captions:
 * settled(captions) }`, or uncalled, by the outputs of a role more than one action fills, `deps:
 * { captions: settled<string> }`. Its node marks the ref it gives, `deps: { captions:
 * settled(captionsRef) }`: a role declared one way takes no ref of the other.
 */
export function settled<T extends Outputs>(ref: NodeRef<T>): SettledRef<T>;
export function settled<T extends Outputs>(dep: Dep<T>): SettledDep<T>;
export function settled<T extends Outputs>(): SettledDep<T>;
export function settled(of?: NodeRef | Dep): SettledRef | SettledDep {
  return of === undefined || DEP in of
    ? { [DEP]: true, settled: true }
    : notAString({ name: of.name, settled: true as const }, nodeRefusal(of.name, true));
}

const MAYBE: unique symbol = Symbol.for("@mrmeku/dagraph/maybe");

/**
 * Mark a role that a node may leave out: around the action that fills it, `deps: { summary:
 * maybe(summarize) }`, or uncalled, by its outputs, `deps: { summary: maybe<string> }`. Its
 * outputs are `undefined` when the node gives no dep, so the action checks before it reads them.
 */
export function maybe<T extends Outputs>(dep: SettledDep<T>): SettledDep<T> | undefined;
export function maybe<T extends Outputs>(dep: Dep<T>): Dep<T> | undefined;
export function maybe<T extends Outputs>(): Dep<T> | undefined;
export function maybe(dep?: Dep | SettledDep): Dep | SettledDep | undefined {
  const role = { [DEP]: true as const, [MAYBE]: true as const };
  return dep?.settled ? { ...role, settled: true } : role;
}

/** The roles of `deps` that each node gives: each but one that `maybe` marks or that is `undefined`. */
export const requiredRoles = (deps: DepSpecs): string[] =>
  Object.entries(deps).flatMap(([role, declared]) => {
    const spec = typeof declared === "function" ? declared() : declared;
    return spec === undefined || MAYBE in spec ? [] : [role];
  });

/**
 * The inputs that each node of an action gives when it is added, by name and type, as its
 * `nodeInputs` declares them. `T` is a record type, never an interface, which has no index
 * signature.
 */
export interface NodeInputsSpec<T extends InputRecord<unknown> = InputRecord<unknown>> {
  readonly [NODE_INPUTS]: true;
  readonly _T?: T;
}

/**
 * Declare the inputs each node gives, by name and type. It names only a type, so it goes
 * uncalled: `nodeInputs: nodeInputs<{ url: string; lock: FileInput }>`. The action reads them
 * beside its own `inputs`.
 */
export function nodeInputs<T extends InputRecord<unknown>>(): NodeInputsSpec<T> {
  return { [NODE_INPUTS]: true };
}

/** The deps a node may give, by role. */
export type DepRecord = Record<string, NodeRef | SettledRef | undefined>;

/**
 * The argument of a node's `inputs` function: each dep in `deps`, by role, as refs to its outputs.
 * `D` is the type of `deps` as the node gives them.
 */
export function depRefs<D, S>(deps: DepRecord | undefined): DepRefs<D, S> {
  const refs = Object.fromEntries(
    Object.entries(deps ?? {}).flatMap(([role, dep]) => {
      if (!dep) return [];
      const ref = (output: string) => {
        const shown = `${role}.${output}`;
        const fix =
          isIdentifier(role) && isIdentifier(output)
            ? `: [..., ${shown}] or { ${output}: ${shown} }`
            : "";
        return notAString(
          { [OUTPUT_REF]: true, node: dep.name, output, settled: dep.settled === true },
          `${shown} can't be part of a string: its path exists only once "${dep.name}" has run. ` +
            `Make it its own array item or property${fix}.`,
        );
      };
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
  return notAString(
    { [FILE_INPUT]: path },
    `file("${path}") can't be part of a string. Make it its own input: ` +
      `inputs: { "${path}": file("${path}") }.`,
  );
}

const branded = (value: unknown, brand: symbol) =>
  typeof value === "object" && value !== null && brand in value;
export const isOutputRef = (value: unknown): value is OutputRef | SettledOutputRef =>
  branded(value, OUTPUT_REF);
export const isFileInput = (value: unknown): value is FileInput => branded(value, FILE_INPUT);
/** Whether a value is a handle: a list or a record of handles is not. */
export const isFileHandle = (value: unknown): value is FileHandle => branded(value, FILE_HANDLE);

type DepOutputs<X> =
  X extends SettledDep<infer T>
    ? Handles<T> | undefined
    : X extends Dep<infer T>
      ? Handles<T>
      : never;

/**
 * Each dep's outputs by role, as handles, from the deps `D` an action declares. A `settled` or a
 * `maybe` role's are `Handles<T> | undefined`, so the action checks before it reads them.
 */
export type DepOutputsOf<D> = {
  [K in keyof D]: undefined extends Role<D[K]>
    ? DepOutputs<NonNullable<Role<D[K]>>> | undefined
    : DepOutputs<Role<D[K]>>;
};

/** An input as the action reads it: a file as a handle, an output ref as that output's handles. */
export type Resolved<V> = V extends FileInput
  ? FileHandle
  : V extends SettledOutputRef<infer T>
    ? Handles<T> | undefined
    : V extends OutputRef<infer T>
      ? Handles<T>
      : V extends readonly (infer U)[]
        ? Resolved<U>[]
        : V extends object
          ? { [K in keyof V]: Resolved<V[K]> }
          : V;

/**
 * Everything one call of an action gets. What is keyed: `inputs` and `depOutputs`, each file in
 * them a `FileHandle`. Its tools: `ports`. What the attempt gives: `outputDir`, the absolute path
 * of a new, empty directory only this attempt writes; `signal`, which fires on the node's timeout
 * or the execution's cancel; and `output`, for what the action prints, in chunks as printed. `D`
 * is the deps the action declares, and `I` its inputs and its nodes' together.
 */
export interface ActionContext<Ports = unknown, D = DepSpecs, I = Record<string, unknown>> {
  inputs: Resolved<I>;
  depOutputs: DepOutputsOf<D>;
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
export type InvalidateOn<Ports, D> = {
  [K in keyof D]?: (
    outputs: NonNullable<DepOutputsOf<D>[K]>,
    ports: Ports,
  ) => Promise<string> | string;
};

type RefOf<X> =
  X extends SettledDep<infer T> ? SettledRef<T> : X extends Dep<infer T> ? NodeRef<T> : never;
type Flat<T> = { [K in keyof T]: T[K] };

/**
 * The deps a node gives, by role, for the deps `D` its action declares: a `NodeRef` in each role,
 * a `SettledRef` in a `settled` one, and a `maybe` role left out or `undefined`. A ref must carry
 * the outputs its role declares, so a node of another action does not compile.
 */
export type NodeDeps<D> = Flat<
  { [K in keyof D as undefined extends Role<D[K]> ? never : K]: RefOf<Role<D[K]>> } & {
    [K in keyof D as undefined extends Role<D[K]> ? K : never]?:
      | RefOf<NonNullable<Role<D[K]>>>
      | undefined;
  }
>;

type DepOf<R> =
  R extends SettledRef<infer T> ? SettledDep<T> : R extends NodeRef<infer T> ? Dep<T> : undefined;

/**
 * The deps an action declares for the deps `D` a node gives, `NodeDeps` the other way: a `Dep` for
 * each `NodeRef`, a `SettledDep` for each `SettledRef`, and `maybe` for a role that may be
 * `undefined`. For an action defined for one node, which declares the deps that node gives.
 */
export type DepSpecsOf<D extends DepRecord> = { [K in keyof D]: DepOf<D[K]> };

/**
 * The action's own inputs, which no node declares again. Where they are a record typed by an index
 * signature, their names are not in the type, so `addNode` refuses a repeat when the node is added.
 */
type NotRedeclared<I> = string extends keyof I
  ? unknown
  : { readonly [K in keyof I]?: { readonly "is its action's own input: leave it out": K } };

/** The names `nodeInputs` declares: where it is a union of records, each member's. */
type InputNames<N> = N extends unknown ? keyof N : never;

/** Whether a node may give any input but its action's own: `nodeInputs` names none, or any. */
type TakesAnyInput<N> = [InputNames<N>] extends [never]
  ? true
  : string extends InputNames<N>
    ? true
    : false;

/**
 * A node's own inputs: those its action's `nodeInputs` declares, or any but the action's own.
 * One object type, not an intersection, so a name that `Object` has, as `constructor`, compiles.
 */
type OwnInputs<N, I, S> =
  TakesAnyInput<N> extends true
    ? Flat<N & NotRedeclared<I> & InputRecord<S>>
    : Flat<{ [K in keyof N]: N[K] & (InputValue<S> | FileInput | undefined) } & NotRedeclared<I>>;

/**
 * Each name of `NI`, the inputs a node gives, refused where `nodeInputs` does not declare it, also
 * in a variable or a return, which no excess-property check sees. Each is optional: a returned
 * union infers `NI` from one member.
 */
type InputChecks<NI, N, I> =
  TakesAnyInput<N> extends true
    ? unknown
    : {
        [K in keyof NI]?: K extends InputNames<N> | keyof NotRedeclared<I>
          ? unknown
          : { readonly "is no input its action's nodeInputs declares": K };
      };

/**
 * A node's own inputs, added to its action's: a record, or a function of the deps the node gives
 * that returns one. The function is the one way to put a ref in a value input, and it runs once,
 * when the node is added: `inputs: ({ pack }) => ({ argv: ["publish", pack.tarball] })`. `N` is
 * what the action's `nodeInputs` declares, `I` the action's own `inputs`, which no node declares
 * again, and `D` the deps whose refs the function gets. `NI`, inferred from the node, is the
 * inputs it gives.
 */
export type NodeInputs<N, I, D, NI = N> =
  | (OwnInputs<N, I, never> & InputChecks<NI, N, I>)
  | (<S>(deps: DepRefs<D, S>) => OwnInputs<N, I, S> & InputChecks<NI, N, I>);

/**
 * Whether an action's `deps` take a dep in any role, as a record typed `DepSpecs` does, rather than
 * in the roles they name.
 */
type TakesAnyRole<D> = string extends keyof D ? true : false;

/** The deps whose refs a node's `inputs` function gets: the roles `D` names, or else the node's `ND`. */
type RefDeps<D, ND> = TakesAnyRole<D> extends true ? ND : NodeDeps<D>;

/** A param `K` of type `V`, optional where `Needed`, what the action declares, may be empty. */
type Param<K extends string, Needed, V> =
  Record<never, never> extends Needed ? { [P in K]?: V } : { [P in K]: V };

/** A role `K` as a node gives it, refused by an object that names why. */
type RoleCheck<K, D> = K extends keyof D
  ? unknown
  : { readonly "is no role its action declares": K };

/** Each role of `ND`, the deps a node gives, checked also where no excess-property check sees. */
type RoleChecks<ND, D> =
  TakesAnyRole<D> extends true ? unknown : { [K in keyof ND]: RoleCheck<K, D> };

/** A node's deps: none where its action declares no role, else the roles it declares. */
type DepsParam<D, ND> = [keyof D] extends [never]
  ? { deps?: Record<string, never> }
  : Param<"deps", NodeDeps<D>, ND & RoleChecks<ND, D>>;

/**
 * What `addNode` takes: a name, deps, inputs and meta, and nothing else. The deps are the roles
 * the action's `deps` declare (`D`), and its inputs those its `nodeInputs` declare (`N`), with
 * none of its own `inputs` (`I`). `ND` and `NI`, inferred from the node, are the deps and the
 * inputs it gives.
 */
export type NodeParams<D, N, I, Meta, ND = NodeDeps<D>, NI = N> = {
  name?: string;
  meta?: Meta;
} & DepsParam<D, ND> &
  Param<"inputs", N, NodeInputs<N, I, RefDeps<D, ND>, NI>>;

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

/** The deps a node runs only once they succeed: its deps less its `settled` ones. */
export function requiredDeps(node: Node): string[] {
  return node.deps.filter((d) => !node.settledDeps?.includes(d));
}
