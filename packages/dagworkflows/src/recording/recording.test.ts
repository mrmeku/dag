import assert from "node:assert/strict";
import { test } from "node:test";
import { recordingPlatform } from "./index.ts";

test("one host however often asked, the one recordedHost() gives, with the context given; no display; the same stores each time, with no notice", async () => {
  const platform = recordingPlatform({ runId: 7 });
  const members = platform();
  const again = platform();
  const host = await members.host();
  const cacheStore = await members.cacheStore();
  const artifactStore = await members.artifactStore();
  host.info("told");
  assert.deepEqual(
    {
      name: members.name,
      sameHost: host === (await again.host()) && host === platform.recordedHost().host,
      log: platform.recordedHost().log,
      runId: (await host.context()).runId,
      listeners: await members.listeners(),
      sameStores:
        cacheStore.store === (await again.cacheStore()).store &&
        artifactStore.store === (await again.artifactStore()).store,
      offered: [Object.keys(cacheStore), Object.keys(artifactStore)],
    },
    {
      name: "recording",
      sameHost: true,
      log: ["told"],
      runId: 7,
      listeners: undefined,
      sameStores: true,
      offered: [["store"], ["store"]],
    },
  );
});
