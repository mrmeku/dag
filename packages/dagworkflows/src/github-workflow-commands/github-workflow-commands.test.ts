import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  flattenGroups,
  isDebugCommand,
  openStopToken,
  warningCommand,
  warningsOf,
} from "./index.ts";

describe("GitHub workflow commands", () => {
  test("a warning command escapes its title by the toolkit's rules and reads back as written", () => {
    const line = warningCommand("lint:a, b", "50% done,\r\nno more");
    assert.deepEqual(
      { line, read: warningsOf([line]) },
      {
        line: "::warning title=lint%3Aa%2C b::50%25 done,%0D%0Ano more",
        read: [{ line: 0, message: "50% done,\r\nno more" }],
      },
    );
  });

  test("the warnings in a log, as GitHub's runner reads them", () => {
    assert.deepEqual(
      warningsOf([
        "  ::warning title=lint%3Aa::50%25 done,%0Ano more",
        "::WARNING file=a.ts,line=3::shout",
        "\u0085::warning::after a next-line character",
        "progress\r::warning::after a return",
        "::notice::a notice",
        "echo ::warning::not a command",
        "::stop-commands::pause",
        "::warning::held",
        "::pause::",
        "::warning::after",
        "progress\r::stop-commands::hold",
        "::warning::held after a return",
      ]),
      [
        { line: 0, message: "50% done,\nno more" },
        { line: 1, message: "shout" },
        { line: 2, message: "after a next-line character" },
        { line: 3, message: "after a return" },
        { line: 9, message: "after" },
      ],
    );
  });

  test("only a debug command at the start of a line is one", () => {
    assert.deepEqual(
      ["::debug::walking", "  ::debug::walking", "\x1b[0m::debug::walking", "::DEBUG::walking"].map(
        isDebugCommand,
      ),
      [true, false, false, false],
    );
  });

  test("a tool's groups flatten to their titles, and the stop token a log leaves open is found", () => {
    const build = [
      "line 1",
      "::group::a.test.ts:",
      "token",
      "::endgroup::",
      "::stop-commands::Never-Resumed",
    ];
    const quiet = ["::stop-commands::paused", "plain", "::PAUSED::"];
    assert.deepEqual(
      {
        flattened: flattenGroups(build),
        openInBuild: openStopToken(build),
        openInQuiet: openStopToken(quiet),
        openAfterReturn: openStopToken(["progress\r  ::stop-commands::tok"]),
      },
      {
        flattened: ["line 1", "a.test.ts:", "token", "::stop-commands::Never-Resumed"],
        openInBuild: "Never-Resumed",
        openInQuiet: undefined,
        openAfterReturn: "tok",
      },
    );
  });
});
