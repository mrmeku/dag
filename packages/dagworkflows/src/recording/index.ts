import type { Platform } from "../wiring/index.ts";
import { createMemoryArtifactStore, type MemoryArtifactStore } from "./artifact-store/index.ts";
import { createMemoryCacheStore, type MemoryCacheStore } from "./cache-store/index.ts";
import { createRecordingHost, type RecordedHost } from "./host/index.ts";

export { createMemoryArtifactStore, type MemoryArtifactStore } from "./artifact-store/index.ts";
export { createMemoryCacheStore, type MemoryCacheStore } from "./cache-store/index.ts";
export { createRecordingHost, type RecordedHost } from "./host/index.ts";

/** A platform's members, its stores the memory ones a test reads. */
type RecordingMembers = Omit<ReturnType<Platform>, "cacheStore" | "artifactStore"> & {
  cacheStore: () => Promise<{ store: MemoryCacheStore }>;
  artifactStore: () => Promise<{ store: MemoryArtifactStore }>;
};

/**
 * Running under a test that wires a process as a program does: one recording host, made with
 * `context` over its defaults, no display of its own, and memory stores, each made once and with
 * no notice. A test reads what the run gave them by asking again.
 */
export function recordingPlatform(
  context?: Parameters<typeof createRecordingHost>[0],
): (() => RecordingMembers) & { recordedHost: () => RecordedHost } {
  const recorded = createRecordingHost(context);
  const cacheStore = createMemoryCacheStore();
  const artifactStore = createMemoryArtifactStore();
  const members: RecordingMembers = {
    name: "recording",
    host: async () => recorded.host,
    listeners: async () => undefined,
    cacheStore: async () => ({ store: cacheStore }),
    artifactStore: async () => ({ store: artifactStore }),
  };
  return Object.assign((() => members) satisfies Platform, {
    recordedHost: () => recorded,
  });
}
