import { expect, test } from "bun:test";

import { isJsonValue, isPlainObject, jsonCopy } from "./index.ts";

test("jsonCopy copies JSON, leaving out undefined properties and making -0 0, and is undefined for what is not JSON; isJsonValue says which", () => {
  const loop: Record<string, unknown> = { a: 1 };
  loop.self = loop;
  const shared = { a: 1 };
  class Point {
    constructor(readonly x: number) {}
  }
  const values: Record<string, unknown> = {
    record: { a: [1, "two", true, null], b: { c: {} } },
    undefinedProperty: { a: 1, b: undefined },
    negativeZero: [-0],
    // An object that comes twice, but not inside itself, is no cycle.
    sharedTwice: [shared, shared],
    nullPrototype: { __proto__: null, a: 1 },
    loop,
    nan: { ratio: Number.NaN },
    infinity: [Infinity],
    bigint: 1n,
    instance: new Point(1),
    map: new Map([["a", 1]]),
    date: new Date(0),
    undefinedItem: [1, undefined],
    hole: [1, , 3],
    function: () => 1,
    symbol: Symbol("s"),
    undefined: undefined,
  };
  const copies = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, jsonCopy(v)]));
  const accepted = Object.entries(values)
    .filter(([, v]) => isJsonValue(v))
    .map(([k]) => k);
  expect({ copies, accepted }).toStrictEqual({
    copies: {
      record: { a: [1, "two", true, null], b: { c: {} } },
      undefinedProperty: { a: 1 },
      negativeZero: [0],
      sharedTwice: [{ a: 1 }, { a: 1 }],
      nullPrototype: { a: 1 },
      loop: undefined,
      nan: undefined,
      infinity: undefined,
      bigint: undefined,
      instance: undefined,
      map: undefined,
      date: undefined,
      undefinedItem: undefined,
      hole: undefined,
      function: undefined,
      symbol: undefined,
      undefined: undefined,
    },
    accepted: ["record", "undefinedProperty", "negativeZero", "sharedTwice", "nullPrototype"],
  });
});

test("isPlainObject is true of a record, with or without a prototype, and false of an array, a class instance or a Map", () => {
  class Point {
    constructor(readonly x: number) {}
  }
  expect({
    record: isPlainObject({ a: 1 }),
    nullPrototype: isPlainObject({ __proto__: null }),
    array: isPlainObject([1]),
    instance: isPlainObject(new Point(1)),
    map: isPlainObject(new Map()),
  }).toEqual({ record: true, nullPrototype: true, array: false, instance: false, map: false });
});
