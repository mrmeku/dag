import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { logBlock, stepSummary, type SummaryRenderer } from "./index.ts";

describe("step summary", () => {
  test("over the budget, logs go first, each whole though it holds a fence of its own, then from the top the blocks that no longer fit beside the notes after them, counting UTF-8 bytes", async () => {
    // A failure's log of a markdown diff, which prints fences.
    const failures = () => ["### failures", ...logBlock(["+```ts", "x".repeat(700_000), "+```"])];
    const tail = () => ["c".repeat(40)];
    const first = () => ["a".repeat(500_000)];
    const second = () => ["b".repeat(500_000)];
    const nearlyAll = () => ["n".repeat(899_990)];
    // Three UTF-8 bytes per character: within the budget in UTF-16 units, over it in bytes.
    const ticksOf = (count: number) =>
      function ticks() {
        return ["✓".repeat(count)];
      };
    const markdownOf = async (renderers: SummaryRenderer<null>[]) =>
      (await stepSummary("t", renderers, null)).markdown;
    assert.deepEqual(
      {
        logsDropped: await markdownOf([ticksOf(100_000), failures, tail]),
        sectionDropped: await markdownOf([ticksOf(400_000), failures, tail]),
        firstKept: await markdownOf([first, second]),
        notesCounted: await markdownOf([nearlyAll, tail]),
      },
      {
        logsDropped:
          [
            "## t",
            "✓".repeat(100_000),
            "### failures\n_(log omitted: summary over the 1 MiB budget)_",
            "c".repeat(40),
          ].join("\n\n") + "\n",
        sectionDropped:
          [
            "## t",
            "_(ticks omitted: summary over the 1 MiB budget)_",
            "### failures\n_(log omitted: summary over the 1 MiB budget)_",
            "c".repeat(40),
          ].join("\n\n") + "\n",
        firstKept:
          ["## t", "a".repeat(500_000), "_(second omitted: summary over the 1 MiB budget)_"].join(
            "\n\n",
          ) + "\n",
        // Kept, nearlyAll would leave tail's note no room.
        notesCounted:
          ["## t", "_(nearlyAll omitted: summary over the 1 MiB budget)_", "c".repeat(40)].join(
            "\n\n",
          ) + "\n",
      },
    );
  });

  test("a renderer that rejects or throws leaves a note in its place under its name or place, and every other block stays", async () => {
    const coverage = async (): Promise<string[]> => {
      throw new Error("no coverage file");
    };
    const status = () => ["### ✔︎ all 2 nodes succeeded"];
    const nothing = () => [];
    assert.deepEqual(
      {
        summary: await stepSummary(
          "ci.ts",
          [
            coverage,
            () => {
              throw new Error("boom");
            },
            nothing,
            status,
          ],
          null,
        ),
        empty: await stepSummary("ci.ts", [nothing], null),
      },
      {
        summary: {
          markdown: [
            "## ci.ts",
            "",
            "_(coverage failed: no coverage file)_",
            "",
            "_(#2 failed: boom)_",
            "",
            "### ✔︎ all 2 nodes succeeded",
            "",
          ].join("\n"),
          failed: [
            { name: "coverage", message: "no coverage file" },
            { name: "#2", message: "boom" },
          ],
        },
        empty: { markdown: "", failed: [] },
      },
    );
  });
});
