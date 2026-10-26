[**@mrmeku/dagworkflows**](README.md)

---

[@mrmeku/dagworkflows](README.md) / github

# github

## Functions

### createGithubHost()

> **createGithubHost**(`opts?`): [`Host`](index/README.md#host)

GitHub Actions adapter: `@actions/core` for log groups, annotations and the step summary,
`@actions/github` for the context and the check runs (needs `GITHUB_TOKEN` and `checks: write`;
silently off without the token, and switched off after the first API failure so a flaky API
can never fail the build). `fetch` is Octokit's, injectable for tests. A group's lines are a
command's output, replayed: the runner reads its workflow commands, `::add-mask::` included,
as it reads a `run:` step's. A check run carries no log, which the runner never masks there:
it links to the run's. Its summary keeps the tail GitHub accepts.

#### Parameters

##### opts?

###### fetch?

_typeof_ `fetch`

###### token?

`string`

#### Returns

[`Host`](index/README.md#host)

---

### flattenGroups()

> **flattenGroups**(`lines`): `string`[]

GitHub does not nest log groups: a tool's own `::group::` inside a node's group would end the
node's group early. Its title stays as a plain line; `::endgroup::` goes.

#### Parameters

##### lines

`string`[]

#### Returns

`string`[]

---

### openStopToken()

> **openStopToken**(`lines`): `string` \| `undefined`

The token of a `::stop-commands::` the lines leave open. On GitHub one ends with its step, and
every node's log replays in this one step, so the group that opened it resumes it.

#### Parameters

##### lines

`string`[]

#### Returns

`string` \| `undefined`
