/**
 * The GitHub host on the toolkit this process installed, apart from the group's index, which
 * loads no toolkit module, so the package's index is safe to import off GitHub.
 */
import * as core from "@actions/core";
import * as github from "@actions/github";
import type { Host } from "../host/index.ts";
import { createActionsHost } from "./host/index.ts";

export { flattenGroups, openStopToken } from "../github-workflow-commands/index.ts";

/** The GitHub host: check runs with `token`, sent through `fetch`, Octokit's unless given. */
export const createGithubHost = (
  opts: { token?: string | undefined; fetch?: typeof fetch } = {},
): Host => createActionsHost({ core, github, ...opts });
