import { expect, test } from "bun:test";

import { isResult } from "./types.ts";

const isMade = (value: unknown): value is "made" => value === "made";
const isReason = (value: unknown): value is { reason: string } =>
  typeof value === "object" && value !== null && "reason" in value;

test("isResult accepts each status whose details pass their guards, and refuses a record that lacks a field its status needs, whose field is malformed, whose details a guard refuses, or whose status no result has", () => {
  const failed = { name: "a", status: "failed", error: { name: "Error", message: "m" } };
  const records = {
    succeeded: { name: "a", status: "succeeded", details: "made" },
    succeededWithoutDetails: { name: "a", status: "succeeded" },
    succeededDetailsRefused: { name: "a", status: "succeeded", details: "lost" },
    failed,
    failedWithCause: { ...failed, error: { ...failed.error, cause: { code: 1 } } },
    failedWithDetails: { ...failed, details: { reason: "r" } },
    failedDetailsRefused: { ...failed, details: "made" },
    failedWithoutMessage: { ...failed, error: { name: "Error" } },
    causeNotJson: { ...failed, error: { ...failed.error, cause: 1n } },
    cancelled: { name: "a", status: "cancelled" },
    cancelledWithDetails: { name: "a", status: "cancelled", details: { reason: "r" } },
    cancelledDetailsRefused: { name: "a", status: "cancelled", details: "made" },
    depFailed: { name: "a", status: "dep-failed", dep: "b", rootCauses: ["c"] },
    depFailedWithoutDep: { name: "a", status: "dep-failed" },
    rootCausesNotNames: { name: "a", status: "dep-failed", dep: "b", rootCauses: [1] },
    withoutName: { status: "cancelled" },
    unknownStatus: { name: "a", status: "skipped" },
  };
  expect(
    Object.fromEntries(
      Object.entries(records).map(([k, v]) => [k, isResult(v, isMade, isReason, isReason)]),
    ),
  ).toEqual({
    succeeded: true,
    succeededWithoutDetails: false,
    succeededDetailsRefused: false,
    failed: true,
    failedWithCause: true,
    failedWithDetails: true,
    failedDetailsRefused: false,
    failedWithoutMessage: false,
    causeNotJson: false,
    cancelled: true,
    cancelledWithDetails: true,
    cancelledDetailsRefused: false,
    depFailed: true,
    depFailedWithoutDep: false,
    rootCausesNotNames: false,
    withoutName: false,
    unknownStatus: false,
  });
});
