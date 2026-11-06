import type { StartTimer } from "@mrmeku/dagraph";
import { nullCacheStore, type CacheStore } from "../actions-cache/index.ts";
import { DEFAULT_BUILD_LOG_DIR, DEFAULT_DURATIONS_DIR, type OutputStyle } from "../config/index.ts";
import type { Host } from "../host/index.ts";
import type { Lockfile } from "../lock/index.ts";
import {
  createRunStore,
  durationsFileOf,
  type RunListener,
  type RunStore,
} from "../run-store/index.ts";
import type { Clock, Exec } from "../tasks/index.ts";
import {
  nullArtifactStore,
  type ArtifactStore,
  type FileMatcher,
} from "../upload-artifact/index.ts";
import type { Ports, RunDataPaths, WorkflowFileSystem } from "../workflow/index.ts";

/**
 * Synchronous writes: three functions of `node:fs`, so that module is itself one. A display's
 * files are written with them, so they are whole when the process is forced out.
 */
export type SyncFileSystem = Pick<
  typeof import("node:fs"),
  "mkdirSync" | "writeFileSync" | "appendFileSync"
>;

type WriteStream = NodeJS.WriteStream;

/** Where a display writes: the process's stdout and stderr unless given others. */
export interface WriteStreams {
  stdout: Pick<WriteStream, "write"> &
    Partial<Pick<WriteStream, "columns" | "rows" | "isTTY" | "hasColors">>;
  stderr: Pick<WriteStream, "write">;
}

/** What a process runs on: Node.js, or in-memory doubles. */
export interface Runtime {
  exec: Exec;
  clock: Clock;
  startTimer: StartTimer;
  fs: WorkflowFileSystem;
  syncFs: SyncFileSystem;
  lockfile: Lockfile;
  fileMatcher: FileMatcher;
  env: Readonly<NodeJS.ProcessEnv>;
  /** Installs the process's signal handling, and returns the cancel it fires. */
  abortOnSignals: () => AbortSignal;
}

/** The options a display reads, each defaulted by the platform that uses it. */
export interface DisplayOptions {
  style?: OutputStyle | undefined;
  logDir?: string | undefined;
  failuresReportFile?: string | undefined;
  summaryFile?: string | undefined;
  streams?: WriteStreams | undefined;
}

/** The run's dirs, as `run/` takes them. */
interface RunPaths extends RunDataPaths {
  historyDir?: string | undefined;
  buildLogDir?: string | undefined;
}

/** The command a process runs, as `dag` names it: a run, or the post steps earlier runs owe. */
export type DagCommand = "run" | "post";

/** What a platform is given beside the runtime. */
export interface PlatformOptions {
  display: DisplayOptions;
  paths: RunPaths;
  command: DagCommand;
  workflowFile: string | undefined;
}

/** A store a platform gives, with the notice saying it is off when it is. */
interface OfferedStore<Store> {
  store: Store;
  notice?: string;
}

/**
 * Where a process runs: GitHub Actions, a local machine or a test's recording doubles. Calling it
 * makes nothing; each member is made, and its modules loaded, only when asked. `host()` is made
 * once, and `listeners()` draws on it: the command's display, or none for `run/`'s default.
 */
export type Platform = (
  runtime: Runtime,
  options: PlatformOptions,
) => {
  name: string;
  host: () => Promise<Host>;
  listeners: () => Promise<RunListener[] | undefined>;
  cacheStore: () => Promise<OfferedStore<CacheStore>>;
  artifactStore: () => Promise<OfferedStore<ArtifactStore>>;
};

/** Each choice names an offered platform, or `none` for a store. */
interface Choices {
  platform?: string | undefined;
  cacheStore?: string | undefined;
  artifactStore?: string | undefined;
}

const GITHUB_ACTIONS_PLATFORM = "github-actions";
const LOCAL_PLATFORM = "local";

/**
 * A process's `Ports`, and its store when the display needs one. The platform is GitHub Actions
 * exactly when `GITHUB_ACTIONS` is `true` in the runtime's environment, else local, or the one
 * platform offered whatever the variable; each choice overrides its own. A store that is off is
 * announced once on the host when `notices` is set. Installs no signal handling.
 */
export async function processPorts(opts: {
  runtime: Runtime;
  platforms: Platform[];
  choices?: Choices;
  display?: DisplayOptions;
  paths: RunPaths;
  workflowFile?: string | undefined;
  command: DagCommand;
  notices?: boolean;
}): Promise<{ ports: Ports; store?: RunStore }> {
  const { runtime, choices = {}, paths, workflowFile, command } = opts;
  const options: PlatformOptions = { display: opts.display ?? {}, paths, command, workflowFile };
  const offered = new Map(
    opts.platforms.map((platform) => {
      const members = platform(runtime, options);
      return [members.name, members];
    }),
  );
  const detected =
    offered.size === 1
      ? [...offered.keys()][0]
      : runtime.env.GITHUB_ACTIONS === "true"
        ? GITHUB_ACTIONS_PLATFORM
        : LOCAL_PLATFORM;
  const platformNamed = (choice: string, name = detected) => {
    const members = name === undefined ? undefined : offered.get(name);
    if (!members) throw new Error(`${choice} ${name} is not offered here`);
    return members;
  };
  const platform = platformNamed("platform", choices.platform);
  const host = await platform.host();
  const storeOf = async <Store>(
    choice: string,
    named: string | undefined,
    none: Store,
    offer: (members: ReturnType<Platform>) => Promise<OfferedStore<Store>>,
  ): Promise<Store> => {
    if (named === "none") return none;
    const { store, notice } = await offer(platformNamed(choice, named));
    if (notice !== undefined && opts.notices) host.annotate("notice", "dag", notice);
    return store;
  };
  const cacheStore = await storeOf("cache store", choices.cacheStore, nullCacheStore, (members) =>
    members.cacheStore(),
  );
  const artifactStore = await storeOf(
    "artifact store",
    choices.artifactStore,
    nullArtifactStore,
    (members) => members.artifactStore(),
  );
  const ports: Ports = {
    exec: runtime.exec,
    clock: runtime.clock,
    startTimer: runtime.startTimer,
    fs: runtime.fs,
    lockfile: runtime.lockfile,
    fileMatcher: runtime.fileMatcher,
    env: runtime.env,
    host,
    cacheStore,
    artifactStore,
  };
  const listeners = await platform.listeners();
  if (!listeners) return { ports };
  const store = createRunStore({
    fs: runtime.fs,
    listeners,
    buildLogDir: paths.buildLogDir ?? DEFAULT_BUILD_LOG_DIR,
    durationsFile: durationsFileOf(paths.durationsDir ?? DEFAULT_DURATIONS_DIR, workflowFile),
  });
  return { ports, store };
}
