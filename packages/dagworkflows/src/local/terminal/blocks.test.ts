import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nameWidth, padName } from "./blocks.ts";

describe("terminal blocks", () => {
  test("names pad to terminal columns and are never cut", () => {
    assert.deepEqual(
      {
        width: nameWidth(["lint", "日本語"]),
        padded: padName("lint", 6),
        wide: padName("日本語", 8),
        whole: padName("integration:packages-dagworkflows-e2e", 24),
      },
      {
        width: 6,
        padded: "lint  ",
        wide: "日本語  ",
        whole: "integration:packages-dagworkflows-e2e",
      },
    );
  });
});
