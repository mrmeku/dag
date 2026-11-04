import { expect, test } from "bun:test";

import { failureErrorOf } from "./errors.ts";

test("failureErrorOf keeps a thrown error's name and message and its cause as JSON: JSON copied, an Error as its name, message and cause, anything else dropped", () => {
  const errorLoop = new Error("first");
  errorLoop.cause = new Error("second", { cause: errorLoop });
  const objectLoop: Record<string, unknown> = { code: 1 };
  objectLoop.self = objectLoop;
  const mutated: Record<string, unknown> = { code: 1 };
  const causes: Record<string, unknown> = {
    command: { argv: ["bun", "test"], cwd: ".", code: 1 },
    nested: new TypeError("inner", {
      cause: new RangeError("innermost", { cause: { code: 2 } }),
    }),
    errorLoop,
    objectLoop,
    bigint: 1n,
    instance: new Map([["code", 1]]),
    nan: { ratio: NaN },
    unreadable: {
      get code(): number {
        throw new Error("not now");
      },
    },
    mutated,
    normalized: { code: -0, signal: undefined },
  };
  const errors = Object.fromEntries(
    Object.entries(causes).map(([name, cause]) => [
      name,
      failureErrorOf(new Error(`${name} failed`, { cause })),
    ]),
  );
  // The thrower changes its cause after the failure: the error keeps a copy.
  mutated.code = 2;
  mutated.late = 1n;
  const dropped = (name: string) => ({ name: "Error", message: `${name} failed` });
  expect({
    errors,
    notAnError: failureErrorOf("a string"),
    timedOut: failureErrorOf(new Error("killed", { cause: { code: 1 } }), "timed out after 5 ms"),
  }).toStrictEqual({
    errors: {
      command: {
        name: "Error",
        message: "command failed",
        cause: { argv: ["bun", "test"], cwd: ".", code: 1 },
      },
      nested: {
        name: "Error",
        message: "nested failed",
        cause: {
          name: "TypeError",
          message: "inner",
          cause: { name: "RangeError", message: "innermost", cause: { code: 2 } },
        },
      },
      // The chain stops at the error that comes again.
      errorLoop: {
        name: "Error",
        message: "errorLoop failed",
        cause: { name: "Error", message: "first", cause: { name: "Error", message: "second" } },
      },
      objectLoop: dropped("objectLoop"),
      bigint: dropped("bigint"),
      instance: dropped("instance"),
      nan: dropped("nan"),
      unreadable: dropped("unreadable"),
      mutated: { name: "Error", message: "mutated failed", cause: { code: 1 } },
      normalized: { name: "Error", message: "normalized failed", cause: { code: 0 } },
    },
    notAnError: { name: "Error", message: "a string" },
    timedOut: { name: "Error", message: "timed out after 5 ms", cause: { code: 1 } },
  });
});
